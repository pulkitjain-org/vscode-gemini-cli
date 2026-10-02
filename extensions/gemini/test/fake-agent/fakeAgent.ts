/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A scripted ACP agent for tests. It stands in for `gemini --acp`, which CI
// cannot authenticate against. Run it with Node 22.18+ (type stripping):
//
//   node test/fake-agent/fakeAgent.ts [script.json]
//
// The script decides what each method answers; see FakeAgentScript.

import { readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

export interface ScriptedError {
	readonly error: { readonly code: number; readonly message: string };
}

export interface FakeAgentScript {
	/** Merged over the default `initialize` response. */
	readonly initialize?: Partial<acp.InitializeResponse> | ScriptedError;
	/** Returned from `session/new`, or an error to throw (e.g. auth required). */
	readonly newSession?: Partial<acp.NewSessionResponse> | ScriptedError;
	/** Updates streamed for each successive `session/prompt`, one array per turn. */
	readonly turns?: readonly (readonly acp.SessionUpdate[])[];
}

function isError(value: unknown): value is ScriptedError {
	return typeof value === 'object' && value !== null && 'error' in value;
}

function answer<T>(defaults: T, scripted: Partial<T> | ScriptedError | undefined): T {
	if (isError(scripted)) {
		throw new acp.RequestError(scripted.error.code, scripted.error.message);
	}
	return { ...defaults, ...scripted };
}

const scriptPath = process.argv[2];
const script: FakeAgentScript = scriptPath ? JSON.parse(readFileSync(scriptPath, 'utf8')) : {};

let sessionCount = 0;
let turnIndex = 0;
const pendingTurns = new Map<string, AbortController>();

const stream = acp.ndJsonStream(
	Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
	Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

acp.agent({ name: 'fake-agent' })
	.onRequest('initialize', () => answer<acp.InitializeResponse>({
		protocolVersion: acp.PROTOCOL_VERSION,
		agentInfo: { name: 'fake-agent', version: '0.0.0' },
		agentCapabilities: { loadSession: false },
		authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
	}, script.initialize))
	.onRequest('authenticate', () => ({}))
	.onRequest('session/new', () => answer<acp.NewSessionResponse>({ sessionId: `fake-session-${++sessionCount}` }, script.newSession))
	.onRequest('session/prompt', async ctx => {
		const abort = new AbortController();
		pendingTurns.set(ctx.params.sessionId, abort);
		const updates = script.turns?.[turnIndex++] ?? [];
		try {
			for (const update of updates) {
				if (abort.signal.aborted) {
					return { stopReason: 'cancelled' as const };
				}
				await ctx.client.notify('session/update', { sessionId: ctx.params.sessionId, update });
			}
			return { stopReason: abort.signal.aborted ? 'cancelled' as const : 'end_turn' as const };
		} finally {
			pendingTurns.delete(ctx.params.sessionId);
		}
	})
	.onNotification('session/cancel', ctx => {
		pendingTurns.get(ctx.params.sessionId)?.abort();
	})
	.connect(stream);
