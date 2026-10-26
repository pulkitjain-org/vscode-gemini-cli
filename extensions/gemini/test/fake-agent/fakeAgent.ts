/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
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
	| { readonly step: 'permission'; readonly request: Omit<acp.RequestPermissionRequest, 'sessionId'> }
	/** Calls `fs/read_text_file`; echoes `read:<content>` or `error:<message>`. */
	| { readonly step: 'readFile'; readonly path: string; readonly line?: number; readonly limit?: number }
	/** Calls `fs/write_text_file`; echoes `wrote` or `error:<message>`. */
	| { readonly step: 'writeFile'; readonly path: string; readonly content: string }
	/** Echoes the client's file system capabilities from `initialize` as `fs:<read>,<write>`. */
	| { readonly step: 'capabilities' }
	/** Echoes the model last set with `session/set_model` as `model:<id>`. */
	| { readonly step: 'model' }
	/** Echoes the prompt's content blocks as JSON, as `prompt:<json>`. */
	| { readonly step: 'prompt' }
	/** Echoes the session's id and the `cwd` it was opened with, as `session:<id>:<cwd>`. */
	| { readonly step: 'session' }
	/** Echoes how many times `authenticate` was called, as `auth:<count>`. */
	| { readonly step: 'auth' }
	/** Replies with the sessions closed so far, "closed:<ids>". */
	| { readonly step: 'closed' }
	/** Fails the prompt with this JSON-RPC error, as gemini-cli does with an API error (its HTTP status as the code). */
	| { readonly step: 'fail'; readonly error: { readonly code: number; readonly message: string } };

export interface FakeAgentScript {
	/** Exit with this code before reading anything, like a CLI that dies on startup. */
	readonly exitCode?: number;
	/** Merged over the default `initialize` response. */
	readonly initialize?: Partial<acp.InitializeResponse> | ScriptedError;
	/** Waits this long before answering `initialize`. */
	readonly initializeDelayMs?: number;
	/** Waits this long before answering each `session/new`, like a CLI held up by its setup. */
	readonly newSessionDelayMs?: number;
	/** Per `session/new` call, in order: an error to fail it with, or null to answer it. Calls past the list answer. */
	readonly newSessionErrors?: readonly (ScriptedError | null)[];
	/** Updates (agent messages "early 1" and on) sent for a new session before `session/new` answers. */
	readonly earlyUpdates?: number;
	/**
	 * Until `authenticate` succeeds, `session/new` fails the way gemini 0.62
	 * does when no auth type is selected.
	 */
	readonly requireAuth?: boolean;
	/**
	 * Sessions `session/load` can reopen, as if stored by an earlier process;
	 * sessions this process opened can be reopened too. Setting it advertises
	 * `loadSession`. A reopened session first replays `history:<id>` as a user message.
	 */
	readonly storedSessions?: readonly string[];
	/**
	 * More of the history a reopened session replays, after `session/load`
	 * answers, as gemini-cli does: `updates` agent messages ("Part 1" and on,
	 * each ending in a `[Function Call: replace]` marker), one every `delayMs`.
	 */
	readonly replay?: { readonly updates: number; readonly delayMs?: number };
	/** Returned from `session/new`, or an error to throw (e.g. a missing project ID). */
	readonly newSession?: Partial<acp.NewSessionResponse> | ScriptedError;
	/** Serve the unstable `session/set_model`, as gemini-cli does. Without it the call fails with -32601. */
	readonly supportsSetModel?: boolean;
	/** Also announce a mode change as message text ("[MODE_UPDATE] plan"), as gemini-cli 0.62 does. */
	readonly modeUpdateText?: boolean;
	/** Sent as `available_commands_update` right after each `session/new`, as gemini-cli does. */
	readonly availableCommands?: readonly acp.AvailableCommand[];
	/** Sent as each `session/prompt` answer's `_meta`, such as gemini-cli's token counts. */
	readonly promptMeta?: Record<string, unknown>;
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
let authCount = 0;
const sessionCwds = new Map<string, string>();
/** Sessions `session/close` freed, in order. */
const closedSessions: string[] = [];
let clientCapabilities: acp.ClientCapabilities | undefined;
/** The last model set through `session/set_model`; the `model` step echoes it. */
let lastModel: string | undefined;
let sessionCount = 0;
let newSessionCalls = 0;
let turnIndex = 0;
const pendingTurns = new Map<string, AbortController>();

const stream = acp.ndJsonStream(
	Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
	Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

acp.agent({ name: 'fake-agent' })
	.onRequest('initialize', async ctx => {
		clientCapabilities = ctx.params.clientCapabilities;
		if (script.initializeDelayMs) {
			await new Promise(resolve => setTimeout(resolve, script.initializeDelayMs));
		}
		return answer<acp.InitializeResponse>({
			protocolVersion: acp.PROTOCOL_VERSION,
			agentInfo: { name: 'fake-agent', version: '0.0.0' },
			agentCapabilities: { loadSession: !!script.storedSessions },
			authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
		}, script.initialize);
	})
	.onRequest('authenticate', () => {
		authenticated = true;
		authCount++;
		return {};
	})
	.onRequest('session/new', async ctx => {
		if (script.requireAuth && !authenticated) {
			throw new acp.RequestError(-32000, 'Gemini API key is missing or not configured.');
		}
		const failure = script.newSessionErrors?.[newSessionCalls++];
		if (failure) {
			throw new acp.RequestError(failure.error.code, failure.error.message);
		}
		if (script.newSessionDelayMs) {
			await new Promise(resolve => setTimeout(resolve, script.newSessionDelayMs));
		}
		const response = answer<acp.NewSessionResponse>({ sessionId: `fake-session-${++sessionCount}` }, script.newSession);
		sessionCwds.set(response.sessionId, ctx.params.cwd);
		for (let i = 1; i <= (script.earlyUpdates ?? 0); i++) {
			await ctx.client.notify('session/update', { sessionId: response.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `early ${i}` } } });
		}
		if (script.availableCommands) {
			const availableCommands = [...script.availableCommands];
			setTimeout(() => void ctx.client.notify('session/update', { sessionId: response.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands } }), 0);
		}
		return response;
	})
	.onRequest('session/load', async ctx => {
		const { sessionId, cwd } = ctx.params;
		if (!script.storedSessions || (!script.storedSessions.includes(sessionId) && !sessionCwds.has(sessionId))) {
			throw new acp.RequestError(-32603, `Session not found: ${sessionId}`);
		}
		sessionCwds.set(sessionId, cwd);
		// Like gemini-cli, the history is replayed as updates.
		await ctx.client.notify('session/update', { sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `history:${sessionId}` } } });
		const replay = script.replay;
		if (replay) {
			void (async () => {
				for (let i = 1; i <= replay.updates; i++) {
					await new Promise(resolve => setTimeout(resolve, replay.delayMs ?? 0));
					await ctx.client.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `[Thought: true]Part ${i}[Function Call: replace]` } } });
				}
			})();
		}
		return {};
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
					case 'model':
						await ctx.client.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `model:${lastModel}` } } });
						break;
					case 'prompt':
						await ctx.client.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `prompt:${JSON.stringify(ctx.params.prompt)}` } } });
						break;
					case 'session':
						await ctx.client.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `session:${sessionId}:${sessionCwds.get(sessionId)}` } } });
						break;
					case 'auth':
						await ctx.client.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `auth:${authCount}` } } });
						break;
					case 'closed':
						await ctx.client.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `closed:${closedSessions.join(',')}` } } });
						break;
					case 'fail':
						throw new acp.RequestError(step.error.code, step.error.message);
					case 'readFile':
					case 'writeFile':
					case 'capabilities': {
						const text = await runClientStep(ctx.client, sessionId, step);
						await ctx.client.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
						break;
					}
				}
			}
			return { stopReason: abort.signal.aborted ? 'cancelled' as const : 'end_turn' as const, ...(script.promptMeta ? { _meta: script.promptMeta } : {}) };
		} finally {
			pendingTurns.delete(sessionId);
		}
	})
	.onRequest('session/set_mode', async ctx => {
		// Echo the change the way gemini-cli does when its approval mode changes.
		await ctx.client.notify('session/update', { sessionId: ctx.params.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: ctx.params.modeId } });
		if (script.modeUpdateText) {
			await ctx.client.notify('session/update', { sessionId: ctx.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `[MODE_UPDATE] ${ctx.params.modeId}` } } });
		}
		return {};
	})
	.onNotification('session/cancel', ctx => {
		pendingTurns.get(ctx.params.sessionId)?.abort();
	})
	// Answered whether or not `initialize` advertises it; a test that wants the runtime to close sessions advertises `sessionCapabilities.close`.
	.onRequest('session/close', (params: unknown) => params as { sessionId: string }, ctx => {
		closedSessions.push(ctx.params.sessionId);
		sessionCwds.delete(ctx.params.sessionId);
		return {};
	})
	.onRequest('session/set_model', (params: unknown) => params as { sessionId: string; modelId: string }, ctx => {
		if (!script.supportsSetModel) {
			throw acp.RequestError.methodNotFound('session/set_model');
		}
		lastModel = ctx.params.modelId;
		return {};
	})
	.connect(stream);

async function runClientStep(client: acp.AgentContext, sessionId: string, step: Extract<ScriptedStep, { step: 'readFile' | 'writeFile' | 'capabilities' }>): Promise<string> {
	try {
		switch (step.step) {
			case 'readFile': {
				const response = await client.request('fs/read_text_file', { sessionId, path: step.path, line: step.line, limit: step.limit });
				return `read:${response.content}`;
			}
			case 'writeFile':
				await client.request('fs/write_text_file', { sessionId, path: step.path, content: step.content });
				return 'wrote';
			case 'capabilities':
				return `fs:${!!clientCapabilities?.fs?.readTextFile},${!!clientCapabilities?.fs?.writeTextFile}`;
		}
	} catch (err) {
		return `error:${err instanceof Error ? err.message : JSON.stringify(err)}`;
	}
}
