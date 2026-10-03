/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// One running agent process shared by many chat sessions (plan Phase 2B,
// multi-session-runtime). gemini-cli serves any number of ACP sessions from
// one process, each with its own `cwd`: a new session takes about 30 ms and
// 2.5 MB, against about 1.2 s and 230 MB for a new process (FINDINGS.md).
// The runtime runs `initialize` once per process and routes the agent's
// messages to the session they name.

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as acp from '@agentclientprotocol/sdk';
import { AgentClientHandlers, AgentConnection } from './agentConnection';
import { AgentError, AgentErrorInfo, classifyAgentError } from './errors';
import { Emitter } from './events';
import { AgentSidecar, SidecarState } from './sidecar';

/** The one auth method the IDE ever selects (plan C4). */
export const AUTH_METHOD_ID = 'oauth-personal';

export type AgentRuntimeState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'connecting' }
	| { readonly kind: 'ready'; readonly agent: acp.InitializeResponse }
	| { readonly kind: 'error'; readonly error: AgentErrorInfo };

export type FileSystemHandlers = Pick<AgentClientHandlers, 'readTextFile' | 'writeTextFile'>;

/** What one session answers for itself. */
export interface SessionHandlers {
	sessionUpdate(update: acp.SessionUpdate): void;
	requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
	/** Overrides the runtime's file handlers for this session, for example to give it other roots. */
	readonly fileSystem?: FileSystemHandlers;
}

export interface AgentRuntimeOptions {
	/**
	 * Serves the agent's file reads and writes for sessions without their own.
	 * Without it the client does not advertise `fs` and the agent uses the disk.
	 */
	readonly fileSystem?: FileSystemHandlers;
}

/** Updates kept for a session the client has not registered yet, such as one whose `session/new` reply is still being handled. */
const maxEarlyUpdates = 100;

export class AgentRuntime {

	private readonly onDidChangeStateEmitter = new Emitter<AgentRuntimeState>();
	readonly onDidChangeState = this.onDidChangeStateEmitter.event;

	private _state: AgentRuntimeState = { kind: 'idle' };
	private connection: AgentConnection | undefined;
	private readonly sessions = new Map<string, SessionHandlers>();
	private readonly earlyUpdates = new Map<string, acp.SessionUpdate[]>();
	/** Shared by concurrent `session/new` calls so the user's settings are rewritten at most once (plan C4). */
	private authenticating: Promise<void> | undefined;
	private readonly sidecarListener: { dispose(): void };
	/** Prompts still running on this process, across its sessions. */
	private turns = 0;
	private readonly onDidBecomeIdleEmitter = new Emitter<void>();
	/** Fires when the last running prompt ends. */
	readonly onDidBecomeIdle = this.onDidBecomeIdleEmitter.event;

	constructor(sidecar: AgentSidecar, private readonly options: AgentRuntimeOptions = {}) {
		this.sidecarListener = sidecar.onDidChangeState(state => this.onSidecarState(state));
		if (sidecar.state.kind === 'running') {
			void this.connect(sidecar.state.process);
		}
	}

	get state(): AgentRuntimeState {
		return this._state;
	}

	/** Whether a prompt is running in any session. */
	get busy(): boolean {
		return this.turns > 0;
	}

	/** Counts `turn` as running until it settles, for `busy`. */
	async trackTurn<T>(turn: Promise<T>): Promise<T> {
		this.turns++;
		try {
			return await turn;
		} finally {
			if (--this.turns === 0) {
				this.onDidBecomeIdleEmitter.fire();
			}
		}
	}

	/** How many sessions are registered. */
	get sessionCount(): number {
		return this.sessions.size;
	}

	/**
	 * Opens a session in `cwd` on the running process. When the agent asks for
	 * auth, authenticates once with `oauth-personal` and retries.
	 * Rejects with an `AgentError`.
	 */
	async newSession(cwd: string): Promise<{ readonly connection: AgentConnection; readonly agent: acp.InitializeResponse; readonly session: acp.NewSessionResponse }> {
		const state = this._state;
		const connection = this.connection;
		if (state.kind !== 'ready' || !connection) {
			throw new AgentError({ kind: 'unknown', message: 'The agent is not ready.' });
		}
		try {
			return { connection, agent: state.agent, session: await connection.newSession(cwd) };
		} catch (err) {
			const info = classifyAgentError(err);
			const canAuthenticate = state.agent.authMethods?.some(m => m.id === AUTH_METHOD_ID);
			if (info.kind !== 'auth-required' || !canAuthenticate) {
				throw new AgentError(info);
			}
		}
		try {
			// Only now, and only with oauth-personal: `authenticate` rewrites the
			// user's ~/.gemini/settings.json (plan C4).
			this.authenticating ??= connection.authenticate(AUTH_METHOD_ID).then(() => undefined);
			await this.authenticating;
			return { connection, agent: state.agent, session: await connection.newSession(cwd) };
		} catch (err) {
			throw new AgentError(classifyAgentError(err));
		} finally {
			this.authenticating = undefined;
		}
	}

	/**
	 * Reopens a stored session in `cwd`, when the agent advertises
	 * `loadSession`. Rejects with an `AgentError` otherwise, or when the agent
	 * cannot find it; the caller then opens a new session.
	 */
	async loadSession(cwd: string, sessionId: string): Promise<{ readonly connection: AgentConnection; readonly agent: acp.InitializeResponse; readonly session: acp.NewSessionResponse }> {
		const state = this._state;
		const connection = this.connection;
		if (state.kind !== 'ready' || !connection) {
			throw new AgentError({ kind: 'unknown', message: 'The agent is not ready.' });
		}
		if (!state.agent.agentCapabilities?.loadSession) {
			throw new AgentError({ kind: 'unknown', message: 'The agent cannot reopen sessions.' });
		}
		try {
			const response = await connection.loadSession(sessionId, cwd);
			return { connection, agent: state.agent, session: { ...response, sessionId } };
		} catch (err) {
			throw new AgentError(classifyAgentError(err));
		}
	}

	/** Routes the agent's messages for `sessionId` to `handlers` until disposed. */
	register(sessionId: string, handlers: SessionHandlers): { dispose(): void } {
		this.sessions.set(sessionId, handlers);
		const early = this.earlyUpdates.get(sessionId);
		this.earlyUpdates.delete(sessionId);
		for (const update of early ?? []) {
			handlers.sessionUpdate(update);
		}
		return {
			dispose: () => {
				if (this.sessions.get(sessionId) === handlers) {
					this.sessions.delete(sessionId);
				}
			},
		};
	}

	dispose(): void {
		this.sidecarListener.dispose();
		this.dropConnection();
		this.onDidChangeStateEmitter.dispose();
		this.onDidBecomeIdleEmitter.dispose();
	}

	private onSidecarState(state: SidecarState): void {
		switch (state.kind) {
			case 'running':
				void this.connect(state.process);
				break;
			case 'starting':
			case 'restarting':
				this.dropConnection();
				this.setState({ kind: 'connecting' });
				break;
			case 'failed':
				this.dropConnection();
				this.setState({ kind: 'error', error: { kind: state.reason, message: state.message } });
				break;
			case 'stopped':
				this.dropConnection();
				this.setState({ kind: 'idle' });
				break;
		}
	}

	private async connect(agentProcess: ChildProcessWithoutNullStreams): Promise<void> {
		this.dropConnection();
		const connection = new AgentConnection(agentProcess.stdin, agentProcess.stdout, {
			sessionUpdate: params => this.routeUpdate(params),
			requestPermission: async params => {
				const session = this.sessions.get(params.sessionId);
				return session ? session.requestPermission(params) : { outcome: { outcome: 'cancelled' } };
			},
			...this.fileHandlers(),
		});
		this.connection = connection;
		this.setState({ kind: 'connecting' });
		try {
			const agent = await connection.initialize();
			if (this.connection === connection) {
				this.setState({ kind: 'ready', agent });
			}
		} catch (err) {
			// If the process died, the sidecar reports why (and may restart it);
			// the closed-connection error says less.
			if (this.connection === connection && !await exitsWithin(agentProcess, 1_000)) {
				this.setState({ kind: 'error', error: err instanceof AgentError ? err.info : classifyAgentError(err) });
			}
		}
	}

	/** File handlers that pick the requesting session's own handlers first. */
	private fileHandlers(): FileSystemHandlers {
		const fallback = this.options.fileSystem;
		if (!fallback) {
			return {};
		}
		const handlersFor = (sessionId: string) => this.sessions.get(sessionId)?.fileSystem ?? fallback;
		const unsupported = (method: string) => new AgentError({ kind: 'unknown', message: `${method} is not served for this session.` });
		return {
			readTextFile: params => {
				const read = handlersFor(params.sessionId).readTextFile;
				return read ? read(params) : Promise.reject(unsupported('fs/read_text_file'));
			},
			writeTextFile: params => {
				const write = handlersFor(params.sessionId).writeTextFile;
				return write ? write(params) : Promise.reject(unsupported('fs/write_text_file'));
			},
		};
	}

	private routeUpdate(params: acp.SessionNotification): void {
		const session = this.sessions.get(params.sessionId);
		if (session) {
			session.sessionUpdate(params.update);
			return;
		}
		const early = this.earlyUpdates.get(params.sessionId) ?? [];
		if (early.length < maxEarlyUpdates) {
			early.push(params.update);
			this.earlyUpdates.set(params.sessionId, early);
		}
	}

	private dropConnection(): void {
		this.connection?.dispose();
		this.connection = undefined;
		this.authenticating = undefined;
		this.earlyUpdates.clear();
	}

	private setState(state: AgentRuntimeState): void {
		this._state = state;
		this.onDidChangeStateEmitter.fire(state);
	}
}

function exitsWithin(child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(true);
	}
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			child.off('exit', onExit);
			resolve(false);
		}, ms);
		const onExit = () => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once('exit', onExit);
	});
}
