/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// One running agent process shared by many chat sessions. gemini-cli serves any
// number of ACP sessions from one process, each with its own `cwd`: a new
// session takes under a second and a few MB, against about 3 s and 280 MB for
// a new process (FINDINGS.md). The runtime runs `initialize` once per process and
// routes the agent's messages to the session they name.
//
// One exception: gemini-cli reopens a session (`session/load`) with the
// settings the process read in its own folder as it started, where a new
// session reads its own folder's. A session reopened in a folder whose
// project settings differ (`AgentRuntimeOptions.folderProcess`) opens on a
// process started there, made when first needed, shared by that folder's
// sessions and ended once none is left.

import { promises as fs } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentClientHandlers, AgentConnection, SetupTimeouts } from './agentConnection';
import { comparablePath } from './fsUtil';
import { AgentError, AgentErrorInfo, AgentErrorKind, classifyAgentError, CliRetry, errorMessage } from './errors';
import { Emitter } from './events';
import { isPrompt } from './cliSessions';
import { contentBlockToText } from './sessionUpdates';
import { keepSessionFolder } from './sessionFolder';
import { AgentSidecar, SidecarState } from './sidecar';

/** The one auth method the IDE ever selects. */
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
	/** Told when the session's own process ended (`AgentRuntimeOptions.folderProcess`), so it can open again. */
	onDidEnd?(): void;
	/** Told after the agent wrote a file through the client, such as to let shell approvals lapse. */
	onDidWriteFile?(filePath: string): void;
	/** Asked before the agent writes a file through the client; rejects to refuse the write. */
	beforeWrite?(filePath: string, content: string): Promise<void>;
}

export interface AgentRuntimeOptions {
	/**
	 * Serves the agent's file reads and writes for sessions without their own.
	 * Without it the client does not advertise `fs` and the agent uses the disk.
	 */
	readonly fileSystem?: FileSystemHandlers;
	/** Overrides how long setup requests may take (see `defaultSetupTimeouts`), such as in tests. */
	readonly timeouts?: Partial<SetupTimeouts>;
	/** Writes a debug line to the log, such as for an error the runtime or its sessions get past. */
	readonly log?: (message: string) => void;
	/** Loads the connection module (the ACP SDK with it): the host's bundle of its own (dist/connection.js); the module itself by default, as in tests. */
	readonly connectionModule?: () => Promise<typeof import('./agentConnection')>;
	/** Processes of a folder's own, for sessions reopened where the shared process would give them another folder's settings. */
	readonly folderProcess?: {
		/** Whether a session reopened in `cwd` needs a process of its own. */
		needed(cwd: string): Promise<boolean>;
		/** A process for `cwd`, not started; it is ended once its sessions are gone. */
		sidecar(cwd: string): AgentSidecar;
		/** How long a folder's process stays up with no session; one minute by default. */
		readonly idleMs?: number;
	};
}

/** A process of a folder's own (`AgentRuntimeOptions.folderProcess`), and the sessions open on it. */
interface FolderProcess {
	/** Its folder, as paths compare (`comparablePath`). */
	readonly key: string;
	readonly sidecar: AgentSidecar;
	readonly ready: Promise<{ readonly connection: AgentConnection; readonly agent: acp.InitializeResponse }>;
	readonly sessions: Set<string>;
	/** Sessions being reopened on it now, which keep it up as open ones do. */
	opening: number;
	idle?: ReturnType<typeof setTimeout>;
}

/**
 * How opening sessions on the running process went, across every chat: the
 * agent's status without a session of its own. Starts afresh with each process.
 */
export interface SessionHealth {
	/** Whether any session opened on this process. */
	readonly opened: boolean;
	/** Why the last session failed to open, when it failed for a reason the user can act on, such as signing in. */
	readonly error?: AgentErrorInfo;
}

/** Session failures that say something about the agent as a whole, rather than about one chat. */
const agentLevelErrors: ReadonlySet<AgentErrorKind> = new Set(['auth-required', 'auth-failed', 'project-id-required', 'project-id-numeric', 'network', 'timeout']);

/** Updates kept for a session the client has not registered yet, such as one whose `session/new` reply is still being handled. */
/** Enough for a long conversation the agent replays when it reopens a session. */
const maxEarlyUpdates = 5000;
/** How far past `maxEarlyUpdates` the list grows before the oldest are dropped. */
const earlyUpdatesSlack = 500;
/**
 * How long updates for a session nobody registered are kept. A session being
 * opened registers within this; one that never will (a tab closed mid-turn, a
 * reopen that lost a race, a spare replaced) would otherwise keep its updates,
 * whole file diffs included, until the process ends.
 */
const earlyUpdatesTtlMs = 60_000;
/** Sessions whose chat went away, remembered so the rest of their updates are dropped. */
const maxClosedSessions = 1000;
/** How long a reopened session's replay is waited for, to check it is the one asked for. */
const replayCheckMs = 1_000;

/** A session the runtime opened, with the connection and agent it belongs to. */
export interface RuntimeSession {
	readonly connection: AgentConnection;
	readonly agent: acp.InitializeResponse;
	readonly session: acp.NewSessionResponse;
	/** The MCP servers the session was opened with: a spare's own, when one was taken. */
	readonly mcpServers: readonly acp.McpServer[];
}

function spareKey(cwd: string, mcpServers: readonly acp.McpServer[]): string {
	return JSON.stringify([cwd, mcpServers]);
}

function normalizePrompt(text: string): string {
	return text.trim().replace(/\s+/g, ' ');
}

export class AgentRuntime {

	private readonly onDidChangeStateEmitter = new Emitter<AgentRuntimeState>();
	readonly onDidChangeState = this.onDidChangeStateEmitter.event;

	private _state: AgentRuntimeState = { kind: 'idle' };
	private connection: AgentConnection | undefined;
	private readonly sessions = new Map<string, SessionHandlers>();
	private readonly earlyUpdates = new Map<string, { readonly since: number; readonly updates: acp.SessionUpdate[] }>();
	private readonly closedSessions = new Set<string>();
	/** A session opened ahead of use (`prepareSession`), keyed by its folder and servers. */
	private spare: { readonly key: string; readonly connection: AgentConnection; readonly session: Promise<RuntimeSession> } | undefined;
	private readonly realFolders = new Map<string, Promise<string>>();
	/** Shared by concurrent `session/new` calls so the user's settings are rewritten at most once. */
	private authenticating: Promise<void> | undefined;
	private readonly sidecarListener: { dispose(): void };
	/** Prompts still running on this process, across its sessions. */
	private turns = 0;
	private readonly onDidBecomeBusyEmitter = new Emitter<void>();
	/** Fires when a prompt starts while none was running. */
	readonly onDidBecomeBusy = this.onDidBecomeBusyEmitter.event;
	private readonly onDidBecomeIdleEmitter = new Emitter<void>();
	/** Fires when the last running prompt ends. */
	readonly onDidBecomeIdle = this.onDidBecomeIdleEmitter.event;
	private _sessionHealth: SessionHealth = { opened: false };
	private readonly onDidChangeSessionHealthEmitter = new Emitter<SessionHealth>();
	/** Fires when a session opens or fails to open after a different outcome. */
	readonly onDidChangeSessionHealth = this.onDidChangeSessionHealthEmitter.event;
	/** Folders' own processes, by folder, and the process each session reopened on one of them is on. */
	private readonly folders = new Map<string, FolderProcess>();
	private readonly sessionFolders = new Map<string, FolderProcess>();
	/** Each open session's folder, for the file policy its reads and writes follow. */
	private readonly sessionCwds = new Map<string, string>();
	private readonly onDidRetryEmitter = new Emitter<CliRetry>();
	/** The CLI retries an API call (from its debug log, see `noteRetry`); not tied to one session. */
	readonly onDidRetry = this.onDidRetryEmitter.event;

	constructor(private readonly sidecar: AgentSidecar, private readonly options: AgentRuntimeOptions = {}) {
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

	/** How many prompts are running, in every session. */
	get runningTurns(): number {
		return this.turns;
	}

	/** Counts `turn` as running until it settles, for `busy`. */
	async trackTurn<T>(turn: Promise<T>): Promise<T> {
		if (this.turns++ === 0) {
			this.onDidBecomeBusyEmitter.fire();
		}
		try {
			const result = await turn;
			// A served prompt is what makes the process healthy (sidecar.ts); a folder's own process counts the same.
			this.sidecar.markHealthy();
			for (const folder of this.folders.values()) {
				folder.sidecar.markHealthy();
			}
			return result;
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

	/** How opening sessions on the running process went (see `SessionHealth`). */
	get sessionHealth(): SessionHealth {
		return this._sessionHealth;
	}

	/** Writes a debug line to the log, when the runtime has one. */
	debug(message: string): void {
		this.options.log?.(message);
	}

	/** Tells sessions with a running turn that the CLI is retrying an API call, as its debug log shows. */
	noteRetry(retry: CliRetry): void {
		if (this.turns > 0) {
			this.onDidRetryEmitter.fire(retry);
		}
	}

	/**
	 * Opens a session in `cwd` on the running process. When the agent asks for
	 * auth, authenticates once with `oauth-personal` and retries.
	 * Rejects with an `AgentError`. Takes the spare session when its `key`
	 * matches (by default, the folder and servers); the spare then has the
	 * servers it was prepared with, which the result carries.
	 */
	async newSession(cwd: string, mcpServers: readonly acp.McpServer[] = [], key = spareKey(cwd, mcpServers)): Promise<RuntimeSession> {
		const spare = this.takeSpare(key);
		if (spare) {
			try {
				return await spare;
			} catch (err) {
				// Open another; this one's error may have been passing, such as a sign-in that has since finished.
				this.debug(`The spare session failed (${errorMessage(err)}); opening another`);
			}
		}
		return this.noteOutcome(this.openNewSession(cwd, mcpServers));
	}

	/** Records how opening a session went, for `sessionHealth`. */
	private async noteOutcome(opening: Promise<RuntimeSession>): Promise<RuntimeSession> {
		const connection = this.connection;
		try {
			const opened = await opening;
			if (this.connection === connection && (!this._sessionHealth.opened || this._sessionHealth.error)) {
				this.setSessionHealth({ opened: true });
			}
			return opened;
		} catch (err) {
			const info = err instanceof AgentError ? err.info : classifyAgentError(err);
			if (this.connection === connection && agentLevelErrors.has(info.kind)) {
				this.setSessionHealth({ opened: this._sessionHealth.opened, error: info });
			}
			throw err;
		}
	}

	private setSessionHealth(health: SessionHealth): void {
		this._sessionHealth = health;
		this.onDidChangeSessionHealthEmitter.fire(health);
	}

	/**
	 * Opens a session in `cwd` ahead of the chat that will use it, such as while
	 * the user types a task on Agent Home, so starting the agent waits for no
	 * `session/new`. The next `newSession` with the same folder and servers on
	 * this process takes it. Does nothing until the process is ready. One spare
	 * at a time: a spare it replaces is closed when the agent can close
	 * sessions (`sessionCapabilities.close`, which gemini-cli 0.64 does not
	 * advertise); otherwise the CLI keeps it (about 2.5 MB) until the process exits.
	 */
	prepareSession(cwd: string, mcpServers: readonly acp.McpServer[] = [], key = spareKey(cwd, mcpServers)): void {
		const connection = this.connection;
		const state = this._state;
		if (state.kind !== 'ready' || !connection || (this.spare?.key === key && this.spare.connection === connection)) {
			return;
		}
		const replaced = this.spare?.connection === connection ? this.spare.session : undefined;
		const session = this.openNewSession(cwd, mcpServers);
		session.catch(err => this.debug(`Could not open a spare session in ${cwd}: ${errorMessage(err)}`));
		this.spare = { key, connection, session };
		if (replaced && state.agent.agentCapabilities?.sessionCapabilities?.close) {
			void replaced.then(old => connection.close(old.session.sessionId), () => undefined).catch(err => this.debug(`Could not close the replaced spare session: ${errorMessage(err)}`));
		}
	}

	/** The key of the spare session on the running process, if there is one. */
	get spareKey(): string | undefined {
		return this.spare?.connection === this.connection ? this.spare?.key : undefined;
	}

	private takeSpare(key: string): Promise<RuntimeSession> | undefined {
		const spare = this.spare;
		if (!spare || spare.key !== key || spare.connection !== this.connection) {
			return undefined;
		}
		this.spare = undefined;
		return spare.session;
	}

	/**
	 * `folder` with its links resolved, as a terminal's CLI keys its sessions
	 * (process.cwd() resolves links); the folder itself when that fails (it
	 * may not exist yet). Resolved once per folder, so sessions opened in one
	 * folder back to back start in the order they were asked for.
	 */
	private realFolder(folder: string): Promise<string> {
		let real = this.realFolders.get(folder);
		if (!real) {
			real = fs.realpath(folder).catch(() => folder);
			this.realFolders.set(folder, real);
		}
		return real;
	}

	private async openNewSession(given: string, mcpServers: readonly acp.McpServer[]): Promise<RuntimeSession> {
		const state = this._state;
		const connection = this.connection;
		if (state.kind !== 'ready' || !connection) {
			throw new AgentError({ kind: 'unknown', message: 'The agent is not ready.' });
		}
		const cwd = await this.realFolder(given);
		try {
			return { connection, agent: state.agent, session: this.noteCwd(await connection.newSession(cwd, mcpServers), cwd), mcpServers };
		} catch (err) {
			const info = classifyAgentError(err);
			const canAuthenticate = state.agent.authMethods?.some(m => m.id === AUTH_METHOD_ID);
			if (info.kind !== 'auth-required' || !canAuthenticate) {
				throw new AgentError(info);
			}
		}
		try {
			// Only now, and only with oauth-personal: `authenticate` rewrites the
			// user's ~/.gemini/settings.json.
			this.authenticating ??= connection.authenticate(AUTH_METHOD_ID).then(() => undefined);
			await this.authenticating;
			return { connection, agent: state.agent, session: this.noteCwd(await connection.newSession(cwd, mcpServers), cwd), mcpServers };
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
	async loadSession(given: string, sessionId: string, firstPrompt?: string, mcpServers: readonly acp.McpServer[] = []): Promise<RuntimeSession> {
		const state = this._state;
		const connection = this.connection;
		if (state.kind !== 'ready' || !connection) {
			throw new AgentError({ kind: 'unknown', message: 'The agent is not ready.' });
		}
		if (!state.agent.agentCapabilities?.loadSession) {
			throw new AgentError({ kind: 'unknown', message: 'The agent cannot reopen sessions.' });
		}
		if (this.sessions.has(sessionId)) {
			// A session loaded by its number keeps that number as its id; another chat still uses it.
			throw new AgentError({ kind: 'unknown', message: 'Another chat has that session open.' });
		}
		this.earlyUpdates.delete(sessionId);
		this.closedSessions.delete(sessionId);
		return this.noteOutcome((async () => {
			const cwd = await this.realFolder(given);
			const target = await this.processFor(cwd, connection, state.agent);
			// The CLI deletes the session's plans as it reopens it: keep them (sessionFolder.ts).
			const putBack = await keepSessionFolder(cwd, sessionId).catch(() => undefined);
			try {
				const response = await target.connection.loadSession(sessionId, cwd, mcpServers).finally(() => putBack?.());
				if (firstPrompt !== undefined && !await this.replayStartsWith(sessionId, firstPrompt)) {
					throw new AgentError({ kind: 'unknown', message: 'The agent opened a different session.' });
				}
				if (target.folder) {
					this.sessionFolders.set(sessionId, target.folder);
				}
				this.sessionCwds.set(sessionId, cwd);
				return { connection: target.connection, agent: target.agent, session: { ...response, sessionId }, mcpServers };
			} catch (err) {
				this.earlyUpdates.delete(sessionId);
				throw err instanceof AgentError ? err : new AgentError(classifyAgentError(err));
			} finally {
				// Until the chat registers the session, which it does at once, or gives it up.
				if (target.folder && !--target.folder.opening && !target.folder.sessions.size) {
					this.idleFolder(target.folder);
				}
			}
		})());
	}

	/** The folder a session was opened in, or undefined for a session this runtime did not open. */
	folderOf(sessionId: string): string | undefined {
		return this.sessionCwds.get(sessionId);
	}

	private noteCwd<T extends acp.NewSessionResponse>(response: T, cwd: string): T {
		this.sessionCwds.set(response.sessionId, cwd);
		return response;
	}

	/** The process to reopen a session of `cwd` on: the shared one, or the folder's own when it needs one and it starts. */
	private async processFor(cwd: string, connection: AgentConnection, agent: acp.InitializeResponse): Promise<{ readonly connection: AgentConnection; readonly agent: acp.InitializeResponse; readonly folder?: FolderProcess }> {
		const own = this.options.folderProcess;
		if (!own || !await own.needed(cwd).catch(() => false) || this.connection !== connection) {
			return { connection, agent };
		}
		const folder = this.folders.get(comparablePath(cwd)) ?? this.startFolder(cwd);
		folder.opening++;
		try {
			return { ...await folder.ready, folder };
		} catch (err) {
			// As before folders had processes of their own: the conversation is kept, with the shared process's settings.
			this.debug(`No agent process for ${cwd} (${errorMessage(err)}); using the shared one`);
			folder.opening--;
			return { connection, agent };
		}
	}

	private startFolder(cwd: string): FolderProcess {
		const sidecar = this.options.folderProcess!.sidecar(cwd);
		let connection: AgentConnection | undefined;
		const folder: FolderProcess = {
			key: comparablePath(cwd),
			sidecar,
			sessions: new Set(),
			opening: 0,
			ready: new Promise((resolve, reject) => sidecar.onDidChangeState(async state => {
				if (state.kind === 'running' && !connection) {
					connection = this.createConnection(await this.loadConnectionModule(), state.process);
					connection.initialize().then(agent => resolve({ connection: connection!, agent }), err => {
						reject(err);
						this.endFolder(folder);
					});
				} else if (state.kind === 'restarting') {
					// The process is coming back; its sessions are gone with the old one, and open again on the new one.
					connection = undefined;
					for (const sessionId of folder.sessions) {
						this.sessions.get(sessionId)?.onDidEnd?.();
					}
					folder.sessions.clear();
				} else if (state.kind !== 'starting' && state.kind !== 'running') {
					reject(new AgentError(state.kind === 'failed' ? { kind: state.reason, message: state.message } : { kind: 'agent-exited', message: 'The agent process stopped.' }));
					this.endFolder(folder);
				}
			})),
		};
		folder.ready.catch(() => undefined);
		this.folders.set(folder.key, folder);
		this.debug(`Starting an agent process for ${cwd}'s settings`);
		sidecar.start();
		return folder;
	}

	/** Ends `folder`'s process once it has had no session for a while. */
	private idleFolder(folder: FolderProcess): void {
		clearTimeout(folder.idle);
		folder.idle = setTimeout(() => !folder.sessions.size && !folder.opening && this.endFolder(folder), this.options.folderProcess?.idleMs ?? 60_000);
		folder.idle.unref?.();
	}

	/** Ends `folder`'s process; the sessions still open on it are told, so they can open again. */
	private endFolder(folder: FolderProcess): void {
		if (this.folders.get(folder.key) !== folder) {
			return;
		}
		this.folders.delete(folder.key);
		clearTimeout(folder.idle);
		folder.sidecar.dispose();
		for (const sessionId of folder.sessions) {
			this.sessionFolders.delete(sessionId);
			this.sessions.get(sessionId)?.onDidEnd?.();
		}
	}

	/**
	 * Whether the conversation the agent replays for `sessionId` begins with
	 * `firstPrompt`. True when no prompt arrives in time: the check is there
	 * to catch the wrong session, which shows at once.
	 */
	private async replayStartsWith(sessionId: string, firstPrompt: string): Promise<boolean> {
		const expected = normalizePrompt(firstPrompt);
		const deadline = Date.now() + replayCheckMs;
		do {
			const replayed = (this.earlyUpdates.get(sessionId)?.updates ?? [])
				.flatMap(update => update.sessionUpdate === 'user_message_chunk' ? [normalizePrompt(contentBlockToText(update.content))] : [])
				.find(isPrompt);
			if (replayed !== undefined) {
				return replayed.startsWith(expected.slice(0, 40)) || expected.startsWith(replayed.slice(0, 40));
			}
			await new Promise(resolve => setTimeout(resolve, 20));
		} while (Date.now() < deadline);
		return true;
	}

	/** Routes the agent's messages for `sessionId` to `handlers` until disposed. */
	register(sessionId: string, handlers: SessionHandlers): { dispose(): void } {
		this.sessions.set(sessionId, handlers);
		this.closedSessions.delete(sessionId);
		const folder = this.sessionFolders.get(sessionId);
		folder?.sessions.add(sessionId);
		clearTimeout(folder?.idle);
		const early = this.earlyUpdates.get(sessionId);
		this.earlyUpdates.delete(sessionId);
		for (const update of early?.updates ?? []) {
			handlers.sessionUpdate(update);
		}
		return {
			dispose: () => {
				if (this.sessions.get(sessionId) === handlers) {
					this.sessions.delete(sessionId);
					if (folder && this.sessionFolders.get(sessionId) === folder) {
						this.sessionFolders.delete(sessionId);
						folder.sessions.delete(sessionId);
						if (!folder.sessions.size) {
							this.idleFolder(folder);
						}
					}
					if (this.closedSessions.size >= maxClosedSessions) {
						this.closedSessions.clear();
					}
					this.closedSessions.add(sessionId);
				}
			},
		};
	}

	dispose(): void {
		this.sidecarListener.dispose();
		this.dropConnection();
		this.onDidChangeStateEmitter.dispose();
		this.onDidBecomeBusyEmitter.dispose();
		this.onDidBecomeIdleEmitter.dispose();
		this.onDidChangeSessionHealthEmitter.dispose();
		this.onDidRetryEmitter.dispose();
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

	/** The process `connect` is connecting to; a newer one makes an older connect stop. */
	private connectingTo: ChildProcessWithoutNullStreams | undefined;

	private async connect(agentProcess: ChildProcessWithoutNullStreams): Promise<void> {
		this.dropConnection();
		this.connectingTo = agentProcess;
		if (this._sessionHealth.opened || this._sessionHealth.error) {
			this.setSessionHealth({ opened: false });
		}
		let module: typeof import('./agentConnection');
		try {
			// The ACP SDK (and zod, which it validates with) loads here, when the agent starts, not when the extension activates.
			module = await this.loadConnectionModule();
		} catch (err) {
			if (this.connectingTo === agentProcess) {
				this.setState({ kind: 'error', error: { kind: 'unknown', message: `The agent's protocol code did not load: ${errorMessage(err)}` } });
			}
			return;
		}
		if (this.connectingTo !== agentProcess) {
			return;
		}
		const connection = this.createConnection(module, agentProcess);
		this.connection = connection;
		void connection.closed.then(() => this.onConnectionClosed(connection, agentProcess));
		// An agent that stopped reading its input while its process lives on fails the next write (EPIPE), which nothing else reports: the connection is closed, and the process ended and started again as below.
		const stoppedReading = () => {
			if (this.connection === connection) {
				this.debug('The agent stopped reading its input; closing the connection');
				connection.dispose();
			}
		};
		agentProcess.stdin.once('error', stoppedReading);
		agentProcess.stdin.once('close', stoppedReading);
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

	/** A connection to `agentProcess` that routes the agent's messages to the sessions they name. */
	private loadConnectionModule(): Promise<typeof import('./agentConnection')> {
		if (this.options.connectionModule) {
			return this.options.connectionModule();
		}
		// A specifier the bundler cannot follow, so the SDK stays out of the extension bundle (the host passes its own
		// bundle above); this path serves the tests and the development build, where each module is a file of its own.
		const module = './agentConnection';
		// eslint-disable-next-line no-restricted-syntax
		return import(module) as Promise<typeof import('./agentConnection')>;
	}

	private createConnection(module: typeof import('./agentConnection'), agentProcess: ChildProcessWithoutNullStreams): AgentConnection {
		return new module.AgentConnection(agentProcess.stdin, agentProcess.stdout, {
			sessionUpdate: params => this.routeUpdate(params),
			requestPermission: async params => {
				const session = this.sessions.get(params.sessionId);
				return session ? session.requestPermission(params) : { outcome: { outcome: 'cancelled' } };
			},
			...this.fileHandlers(),
		}, { ...module.defaultSetupTimeouts, ...this.options.timeouts });
	}

	/**
	 * The stream to the agent closed. When the process exited, the sidecar
	 * reports it and restarts it. When it is still running, the connection
	 * broke on its own (the SDK ends it on a message too large, for example)
	 * and every later request would fail, so the process is ended and the
	 * sidecar restarts it as after a crash.
	 */
	private async onConnectionClosed(connection: AgentConnection, agentProcess: ChildProcessWithoutNullStreams): Promise<void> {
		if (this.connection !== connection || await exitsWithin(agentProcess, 1_000) || this.connection !== connection) {
			return;
		}
		this.debug('The connection to the agent closed while the agent kept running; restarting it');
		this.sidecar.endProcess(agentProcess);
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
			writeTextFile: async params => {
				const write = handlersFor(params.sessionId).writeTextFile;
				if (!write) {
					throw unsupported('fs/write_text_file');
				}
				await this.sessions.get(params.sessionId)?.beforeWrite?.(params.path, params.content);
				const written = await write(params);
				this.sessions.get(params.sessionId)?.onDidWriteFile?.(params.path);
				return written;
			},
		};
	}

	private routeUpdate(params: acp.SessionNotification): void {
		const session = this.sessions.get(params.sessionId);
		if (session) {
			session.sessionUpdate(params.update);
			return;
		}
		if (this.closedSessions.has(params.sessionId)) {
			return;
		}
		let early = this.earlyUpdates.get(params.sessionId);
		if (!early) {
			const now = Date.now();
			for (const [id, entry] of this.earlyUpdates) {
				if (now - entry.since > earlyUpdatesTtlMs) {
					this.earlyUpdates.delete(id);
				}
			}
			early = { since: now, updates: [] };
			this.earlyUpdates.set(params.sessionId, early);
		}
		early.updates.push(params.update);
		if (early.updates.length > maxEarlyUpdates + earlyUpdatesSlack) {
			// The oldest go: a session registered late wants the newest, such as the end of a replay. In batches, so a long replay is not shifted once per update.
			early.updates.splice(0, early.updates.length - maxEarlyUpdates);
		}
	}

	private dropConnection(): void {
		// The sessions on folders' processes open again with the shared process's, as every session does.
		for (const folder of [...this.folders.values()]) {
			folder.sessions.clear();
			this.endFolder(folder);
		}
		this.sessionFolders.clear();
		this.sessionCwds.clear();
		this.connection?.dispose();
		this.connection = undefined;
		this.spare = undefined;
		this.authenticating = undefined;
		this.earlyUpdates.clear();
		this.closedSessions.clear();
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


