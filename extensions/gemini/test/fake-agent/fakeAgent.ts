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

export type ScriptedStep =
	| { readonly step: 'update'; readonly update: acp.SessionUpdate }
	| { readonly step: 'delay'; readonly ms: number }
	/** Asks the client; the outcome is echoed back as an agent message `permission:<optionId|cancelled>`. */
	| { readonly step: 'permission'; readonly request: Omit<acp.RequestPermissionRequest, 'sessionId'> };

export interface FakeAgentScript {
	/** Exit with this code before reading anything, like a CLI that dies on startup. */
	readonly exitCode?: number;
	/** Merged over the default `initialize` response. */
	readonly initialize?: Partial<acp.InitializeResponse> | ScriptedError;
	/**
	 * Until `authenticate` succeeds, `session/new` fails the way gemini 0.62
	 * does when no auth type is selected.
	 */
	readonly requireAuth?: boolean;
	/** Returned from `session/new`, or an error to throw (e.g. a missing project ID). */
	readonly newSession?: Partial<acp.NewSessionResponse> | ScriptedError;
	/** Steps played for each successive `session/prompt`, one array per turn. */
	readonly turns?: readonly (readonly ScriptedStep[])[];
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

if (script.exitCode !== undefined) {
	process.stderr.write(`fake-agent: exiting with ${script.exitCode}\n`);
	process.exit(script.exitCode);
}

let authenticated = false;
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
	.onRequest('authenticate', () => {
		authenticated = true;
		return {};
	})
	.onRequest('session/new', () => {
		if (script.requireAuth && !authenticated) {
			throw new acp.RequestError(-32000, 'Gemini API key is missing or not configured.');
		}
		return answer<acp.NewSessionResponse>({ sessionId: `fake-session-${++sessionCount}` }, script.newSession);
	})
	.onRequest('session/prompt', async ctx => {
		const { sessionId } = ctx.params;
		const abort = new AbortController();
		pendingTurns.set(sessionId, abort);
		const steps = script.turns?.[turnIndex++] ?? [];
		try {
			for (const step of steps) {
				if (abort.signal.aborted) {
					break;
				}
				switch (step.step) {
					case 'delay':
						await new Promise(resolve => setTimeout(resolve, step.ms));
						break;
					case 'permission': {
						const response = await ctx.client.request('session/request_permission', { ...step.request, sessionId });
						const outcome = response.outcome.outcome === 'selected' ? response.outcome.optionId : 'cancelled';
						await ctx.client.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission:${outcome}` } } });
						break;
					}
					case 'update':
						await ctx.client.notify('session/update', { sessionId, update: step.update });
						break;
				}
			}
			return { stopReason: abort.signal.aborted ? 'cancelled' as const : 'end_turn' as const };
		} finally {
			pendingTurns.delete(sessionId);
		}
	})
	.onNotification('session/cancel', ctx => {
		pendingTurns.get(ctx.params.sessionId)?.abort();
	})
	.connect(stream);
