/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentConnection } from './agentConnection';
import { AgentError, AgentErrorInfo, classifyAgentError, errorMessage, isConnectionClosed } from './errors';
import { FileAccessDeniedError } from './fileAccess';
import { isAllowed, protectedWriteRequest } from './permissions';
import { decidesWhatRuns } from './sessionApprovals';
import { Emitter } from './events';
import { AgentRuntime, AgentRuntimeState, FileSystemHandlers } from './agentRuntime';
import { readCliSession } from './cliSessions';
import { withoutReplayMarkers } from './replayText';
import { ReplayTracker } from './replayTracker';
import { StallWatch, type TurnStall } from './stallWatch';
import { PromptCapabilities, readPromptCapabilities } from './promptContent';
import { filterModes, readSessionSettings, SessionChoice, SessionSettings } from './sessionSettings';
import type { SlashCommand } from './slashCommands';
import { ChatEvent, SessionUpdateAdapter } from './sessionUpdates';
import { ModelTokens, readTurnUsage } from './turnUsage';

export { AUTH_METHOD_ID } from './agentRuntime';

/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601;

export type AgentClientState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'connecting' }
	| {
		readonly kind: 'ready';
		/** The session's id on the wire, for this run of the agent. */
		readonly sessionId: string;
		/** The id the CLI saved the session under, to reopen it by later; differs when it was loaded by its number. */
		readonly savedSessionId: string;
		readonly agent: acp.InitializeResponse;
		readonly session: acp.NewSessionResponse;
	}
	| { readonly kind: 'error'; readonly error: AgentErrorInfo };

export interface TurnResult {
	readonly stopReason: acp.StopReason;
	/** Tokens per model, from gemini-cli's `_meta`; unset when the agent sent none. */
	readonly usage?: readonly ModelTokens[];
}

/** What the client knows of a saved session before reopening it. */
export interface SavedSession {
	/** How many updates the CLI replays on `session/load`; unknown when unset. */
	readonly replayUpdates?: number;
}

/** How long a turn that was asked to stop may take to end before it is ended here (see `cancel`). */
const defaultCancelGraceMs = 10_000;
/** How long a turn may go without any update from the agent before it counts as stalled (see `stall`). */
const defaultStallAfterMs = 45_000;
/**
 * Waits before opening a session again after it failed while the agent
 * stayed ready (see `retryOpen`): the first retry is at once, later ones back off.
 */
const defaultRetryDelaysMs: readonly number[] = [0, 2_000, 5_000, 15_000];

/** A turn that has had no update from the agent for a while. */
export type { TurnStall } from './stallWatch';

/** Thrown by `whenReady` when its signal aborts. */
export class WaitAbortedError extends Error {
	constructor() {
		super('Stopped while waiting for the agent.');
		this.name = 'AbortError';
	}
}

type ReadyState = Extract<AgentClientState, { kind: 'ready' }>;

/** How `openSession` went: opened, or not, with why when it failed (unset when a newer open or a restart took over). */
type OpenOutcome = { readonly opened: true } | { readonly opened: false; readonly error?: AgentErrorInfo };

/**
 * gemini-cli 0.62 and 0.63 tell the client about a mode change they make
 * themselves with message text such as `[MODE_UPDATE] autoEdit`, not with
 * `current_mode_update`. Several can arrive in one chunk.
 */
const modeUpdateText = /^(?:\[MODE_UPDATE\] [\w-]+)+$/;

/** Updates the CLI sends when it replays a saved session's history. */
const replayKinds: ReadonlySet<string> = new Set(['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call']);

export interface AgentClientOptions {
	readonly cwd: string;
	/** Asked for every `session/request_permission`; must resolve, with `cancelled` if nothing else. */
	readonly requestPermission: (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
	/** Serves this session's file reads and writes instead of the runtime's handlers. */
	readonly fileSystem?: FileSystemHandlers;
	/** Why GeminiCode last refused a file request of session `sessionId`, to show for a tool failure the CLI wrote as "[object Object]". */
	readonly explainFileError?: (sessionId: string) => string | undefined;
	/** A session from an earlier run to reopen first, when the agent supports `session/load`. */
	readonly resumeSessionId?: string;
	/**
	 * Waits for `open()` before opening the first session. Reopening a session
	 * replays its whole history, so an agent reopened from its saved chat shows
	 * that chat first and reopens the session once it is on screen.
	 */
	readonly openLater?: boolean;
	/**
	 * The model to switch each new or reopened session to, from the ones the
	 * agent offers, such as the one the user picked last; ignored when the
	 * agent does not offer it. Picking a model rather than Auto also spares
	 * gemini-cli its routing call before every prompt.
	 */
	readonly preferredModel?: (available: readonly SessionChoice[]) => string | undefined;
	/** Shapes the models the agent offers into the list the picker shows, such as the terminal's `/model` list. */
	readonly modelList?: (available: readonly SessionChoice[]) => readonly SessionChoice[];
	/** Which approval modes the picker may offer; all of them when unset. */
	readonly isModeAllowed?: (modeId: string) => boolean;
	/** Requests the user answers even in YOLO: the confirm class, which the admin policy makes ask in every mode. */
	readonly alwaysAsks?: (params: acp.RequestPermissionRequest) => boolean;
	/** Told after the agent wrote a file through the client. */
	readonly onDidWriteFile?: (filePath: string) => void;
	/**
	 * Finds a saved session in the CLI's files: how many updates its replay
	 * has. The CLI's own files when unset.
	 */
	readonly findSavedSession?: (cwd: string, id: string) => Promise<SavedSession | undefined>;
	/**
	 * MCP servers GeminiCode itself serves to this session, such as the
	 * browser; asked each time a session opens. Servers over a transport the
	 * agent does not advertise (`mcpCapabilities`) are left out.
	 */
	readonly mcpServers?: () => readonly acp.McpServer[];
	/**
	 * The key of a spare session this client may take instead of opening one
	 * (see `AgentRuntime.prepareSession`); by default, the folder and servers.
	 */
	readonly spareKey?: () => string | undefined;
	/** Told the servers each session opened with, which differ from `mcpServers` when it took a spare. */
	readonly onDidOpenSession?: (mcpServers: readonly acp.McpServer[]) => void;
	/** Awaited before each session opens, such as for a server in `mcpServers` to listen; `mcpServers` is asked after it. */
	readonly beforeOpen?: () => Promise<void>;
	/** Overrides how long a stopped turn may take to end (default 10 s), such as in tests. */
	readonly cancelGraceMs?: number;
	/** Overrides when a turn without updates counts as stalled (default 45 s), such as in tests. */
	readonly stallAfterMs?: number;
	/** Overrides the waits before opening a failed session again (see `retryOpen`), such as in tests. */
	readonly retryDelaysMs?: readonly number[];
}

/**
 * One chat session on a shared `AgentRuntime`. Whenever the runtime has a
 * ready process it opens a session in `cwd` (the runtime authenticates when
 * the agent asks), then serves prompts for it. A restarted process gets a
 * new session.
 */
export class AgentClient {

	private readonly onDidChangeStateEmitter = new Emitter<AgentClientState>();
	readonly onDidChangeState = this.onDidChangeStateEmitter.event;

	private readonly onDidReceiveEventEmitter = new Emitter<ChatEvent>();
	readonly onDidReceiveEvent = this.onDidReceiveEventEmitter.event;

	private readonly onDidChangeModeByAgentEmitter = new Emitter<{ readonly from: string | undefined; readonly to: string }>();
	/** The agent changed the session's mode itself, such as out of Plan once a plan is approved. */
	readonly onDidChangeModeByAgent = this.onDidChangeModeByAgentEmitter.event;

	private readonly onDidAllowInYoloEmitter = new Emitter<acp.RequestPermissionRequest>();
	/** A permission request that came in YOLO mode, which the client allowed at once. */
	readonly onDidAllowInYolo = this.onDidAllowInYoloEmitter.event;

	private readonly onDidFailToReopenEmitter = new Emitter<{ readonly sessionId: string; readonly error: AgentErrorInfo }>();
	/** A saved session could not be reopened, and why; a new session opens instead. */
	readonly onDidFailToReopen = this.onDidFailToReopenEmitter.event;

	private readonly onDidReplayEventEmitter = new Emitter<ChatEvent>();
	/**
	 * The history a reopened session replays, apart from new turns, with the
	 * CLI's markers taken out. A chat that already shows its saved copy can ignore it.
	 */
	readonly onDidReplayEvent = this.onDidReplayEventEmitter.event;

	private readonly onDidChangeSettingsEmitter = new Emitter<SessionSettings>();
	/** The current session's mode and model choices changed. */
	readonly onDidChangeSettings = this.onDidChangeSettingsEmitter.event;

	private readonly onDidChangeCommandsEmitter = new Emitter<readonly SlashCommand[]>();
	/** The agent listed a new set of slash commands for the current session. */
	readonly onDidChangeCommands = this.onDidChangeCommandsEmitter.event;

	/** The watch for a turn gone quiet (stallWatch.ts); `onDidChangeStall` and `stall` are its. */
	private readonly stallWatch: StallWatch;
	/** A running turn stalled, its stall changed (a retry was logged), or it ended (undefined): see `stall`. */
	readonly onDidChangeStall: StallWatch['onDidChange'];

	private _commands: readonly SlashCommand[] = [];
	private _state: AgentClientState = { kind: 'idle' };
	private _settings: SessionSettings = {};
	private pendingMode: string | undefined;
	/** The mode the user picked last, which a mode change the CLI makes on its own must not undo (see `onModeUpdate`). */
	private chosenMode: string | undefined;
	/** Prompts running in this session. */
	private turns = 0;
	/** YOLO picked during a turn on Auto, sent to the CLI when the turn ends (see `setMode`). */
	private deferredMode: string | undefined;
	private connection: AgentConnection | undefined;
	private adapter = this.newAdapter();
	private registration: { dispose(): void } | undefined;
	/** Bumped on every reconnect, so a slow `session/new` for an old process is ignored. */
	private generation = 0;
	/** The MCP servers the current session opened with, as passed to the agent. */
	private _openedMcpServers: readonly acp.McpServer[] = [];
	/** The session to reopen when the agent (re)starts, so a restart keeps the conversation. */
	private resumeSessionId: string | undefined;
	private readonly runtimeListener: { dispose(): void };
	/** Set until `open()` with `openLater`: the runtime may be ready, but no session is opened yet. */
	private held: boolean;
	/** A reopened session's replay of its history, while it runs (replayTracker.ts). */
	private readonly replay = new ReplayTracker();
	private disposed = false;
	/** Called when the client is disposed, so waits on it end. */
	private readonly onDispose = new Set<() => void>();
	/** Ends each running turn here, without the agent's answer (see `cancel`). */
	private readonly endTurnLocally = new Set<() => void>();
	private cancelTimer: ReturnType<typeof setTimeout> | undefined;
	/** Sessions that failed to open in a row while the agent stayed ready, and when the last one failed. */
	private failures = 0;
	private failedAt = 0;
	private retrying: Promise<void> | undefined;
	private readonly retryListener: { dispose(): void };

	constructor(private readonly runtime: AgentRuntime, private readonly options: AgentClientOptions) {
		this.resumeSessionId = options.resumeSessionId;
		this.held = !!options.openLater;
		this.runtimeListener = runtime.onDidChangeState(state => this.onRuntimeState(state));
		this.stallWatch = new StallWatch(options.stallAfterMs ?? defaultStallAfterMs, () => this.turns > 0);
		this.onDidChangeStall = this.stallWatch.onDidChange;
		this.retryListener = runtime.onDidRetry(retry => this.stallWatch.retry(retry));
		this.onRuntimeState(runtime.state);
	}

	get cwd(): string {
		return this.options.cwd;
	}

	get state(): AgentClientState {
		return this._state;
	}

	get settings(): SessionSettings {
		return this._settings;
	}

	/** The slash commands the agent runs itself, from its latest `available_commands_update`. */
	get commands(): readonly SlashCommand[] {
		return this._commands;
	}

	/** The names of the MCP servers the current session opened with. */
	get openedMcpServers(): readonly string[] {
		return this._openedMcpServers.map(server => server.name);
	}

	/**
	 * Opens the current session again, by id, with the servers as they are
	 * now, such as one that opened before a server it needs listened. Resolves
	 * once it is open; does nothing while the agent isn't ready.
	 */
	async reopen(): Promise<void> {
		if (this._state.kind !== 'ready' || this.runtime.state.kind !== 'ready') {
			return;
		}
		await this.openSession(true);
	}

	/** Opens the session a client made with `openLater` waits to open; does nothing otherwise. */
	open(): void {
		if (!this.held) {
			return;
		}
		this.held = false;
		if (this.runtime.state.kind === 'ready') {
			void this.openSession(true);
		}
	}

	/**
	 * Starts a fresh session on the running agent; the old conversation is
	 * gone for the agent too. Rejects with an `AgentError` when no session
	 * opened; the old one is closed only once the new one is open, and is
	 * never reopened after a restart.
	 */
	async newSession(): Promise<void> {
		const state = this._state;
		if (state.kind !== 'ready' || this.runtime.state.kind !== 'ready') {
			throw new Error('The agent is not ready.');
		}
		const old = this.connection;
		// Whatever happens next, the old session is not the one to go back to.
		this.resumeSessionId = undefined;
		const outcome = await this.openSession(false);
		if (!outcome.opened) {
			throw new AgentError(outcome.error ?? { kind: 'unknown', message: 'The agent could not start a new session.' });
		}
		if (old) {
			this.closeSession(old, state.agent, state.sessionId);
		}
	}

	/**
	 * Replaces the current session with saved session `id`, such as one
	 * started in the terminal. Resolves with whether the agent opened it; if
	 * not, the chat carries on in a new session. Rejects with an `AgentError`
	 * when no session opened at all.
	 */
	async loadSession(id: string): Promise<boolean> {
		if (this._state.kind !== 'ready' || this.runtime.state.kind !== 'ready') {
			throw new Error('The agent is not ready.');
		}
		this.resumeSessionId = id;
		const outcome = await this.openSession(true);
		if (!outcome.opened && outcome.error) {
			throw new AgentError(outcome.error);
		}
		return this._state.kind === 'ready' && this._state.savedSessionId === id;
	}

	/**
	 * Opens the session again after it failed to open while the agent process
	 * stayed ready, such as after a passing network or MCP error: at once the
	 * first time, then after a growing wait since the last failure. Resolves
	 * once that open settles; undefined when there is nothing to retry.
	 */
	retryOpen(): Promise<void> | undefined {
		if (this._state.kind !== 'error' || this.runtime.state.kind !== 'ready' || this.held || this.disposed) {
			return undefined;
		}
		return this.retrying ??= (async () => {
			try {
				const delays = this.options.retryDelaysMs ?? defaultRetryDelaysMs;
				const wait = delays[Math.min(Math.max(this.failures - 1, 0), delays.length - 1)] - (Date.now() - this.failedAt);
				if (wait > 0) {
					await new Promise<void>(resolve => {
						const done = () => {
							clearTimeout(timer);
							this.onDispose.delete(done);
							resolve();
						};
						const timer = setTimeout(done, wait);
						this.onDispose.add(done);
					});
				}
				if (this._state.kind === 'error' && this.runtime.state.kind === 'ready' && !this.disposed) {
					this.runtime.debug(`Opening the session in ${this.options.cwd} again after it failed ${this.failures} time(s)`);
					await this.openSession(true);
				}
			} finally {
				this.retrying = undefined;
			}
		})();
	}

	/**
	 * Resolves with the ready state once a session is open; one made with
	 * `openLater` waits for `open()`. A session that failed to open while the
	 * agent stayed ready is opened once more first (`retryOpen`). Rejects with
	 * an `AgentError` when it fails or the agent stops, with a
	 * `WaitAbortedError` when `signal` aborts, and when the client is disposed.
	 */
	async whenReady(signal?: AbortSignal): Promise<ReadyState> {
		let retried = false;
		for (;;) {
			const state = this._state;
			if (signal?.aborted) {
				throw new WaitAbortedError();
			}
			if (this.disposed) {
				throw new AgentError({ kind: 'unknown', message: 'The chat closed.' });
			}
			if (state.kind === 'ready') {
				return state;
			}
			if (state.kind === 'idle') {
				throw new AgentError({ kind: 'unknown', message: 'The agent is not running.' });
			}
			if (state.kind === 'error') {
				const retry = retried ? undefined : this.retryOpen();
				if (!retry) {
					throw new AgentError(state.error);
				}
				retried = true;
				await this.untilChange(retry, signal);
				continue;
			}
			await this.untilChange(undefined, signal);
		}
	}

	/** Resolves on the next state change, when `also` settles, or when the client is disposed; rejects when `signal` aborts. */
	private untilChange(also: Promise<void> | undefined, signal: AbortSignal | undefined): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const finish = () => {
				listener.dispose();
				this.onDispose.delete(finish);
				signal?.removeEventListener('abort', abort);
				resolve();
			};
			const abort = () => {
				finish();
				reject(new WaitAbortedError());
			};
			const listener = this.onDidChangeStateEmitter.event(finish);
			this.onDispose.add(finish);
			signal?.addEventListener('abort', abort);
			void also?.then(finish, finish);
		});
	}

	/** Makes the next session a new one instead of reopening the last, for a chat cleared while the agent is not running. */
	forgetSession(): void {
		this.resumeSessionId = undefined;
	}

	/** Switches the next session this client opens, such as the one reopened after a restart, to `modeId`. */
	setModeOnNextSession(modeId: string): void {
		this.pendingMode = modeId;
		this.chosenMode = modeId;
	}

	async setMode(modeId: string): Promise<void> {
		if (this._state.kind !== 'ready') {
			// Picked while the agent starts: the session opens in it.
			this.setModeOnNextSession(modeId);
			return;
		}
		this.deferredMode = undefined;
		const mode = this._settings.mode;
		if (modeId === 'yolo' && this.turns > 0 && mode?.available.some(choice => choice.id === modeId) && /^auto/.test(this._settings.model?.currentId ?? '')) {
			// Switching to or from YOLO makes gemini-cli 0.63 route Auto again in the middle of the
			// turn (`clearCurrentSequenceModel`), which can move the task to another model. So the
			// switch waits for the turn's end, and until then requests are allowed here, as in YOLO.
			this.deferredMode = modeId;
			this.chosenMode = modeId;
			this.setSettings({ ...this._settings, mode: { ...mode, currentId: modeId } });
			return;
		}
		await this.changeSetting('mode', modeId, (connection, sessionId) => connection.setMode(sessionId, modeId));
		if (this._settings.mode?.currentId === modeId) {
			this.chosenMode = modeId;
		}
	}

	setModel(modelId: string): Promise<void> {
		return this.changeSetting('model', modelId, (connection, sessionId) => connection.setModel(sessionId, modelId));
	}

	/** What the agent accepts in a prompt besides text; text only until a session is ready. */
	get promptCapabilities(): PromptCapabilities {
		return readPromptCapabilities(this._state.kind === 'ready' ? this._state.agent : undefined);
	}

	/** Sends a prompt and resolves when the turn ends. Updates stream through `onDidReceiveEvent`. */
	async prompt(content: string | acp.ContentBlock[]): Promise<acp.StopReason> {
		return (await this.promptTurn(content)).stopReason;
	}

	/** Like `prompt`, and also resolves with the tokens the turn used, when the agent reports them. */
	async promptTurn(content: string | acp.ContentBlock[]): Promise<TurnResult> {
		if (this.replay.done) {
			// The answer must not mix with the history still arriving.
			await this.replay.done;
		}
		const state = this._state;
		if (state.kind !== 'ready' || !this.connection) {
			throw new Error('The agent is not ready.');
		}
		const connection = this.connection;
		if (this.turns++ === 0) {
			this.stallWatch.begin();
		}
		let endLocally!: () => void;
		const endedHere = new Promise<undefined>(resolve => endLocally = () => resolve(undefined));
		this.endTurnLocally.add(endLocally);
		try {
			const response = await this.runtime.trackTurn(Promise.race([connection.prompt(state.sessionId, typeof content === 'string' ? [{ type: 'text', text: content }] : content), endedHere]));
			if (!response) {
				this.runtime.debug(`The turn in ${state.sessionId} did not stop when asked; ended it without the agent's answer`);
				return { stopReason: 'cancelled' };
			}
			const usage = readTurnUsage(response._meta);
			return { stopReason: response.stopReason, ...(usage ? { usage } : {}) };
		} catch (err) {
			if (isConnectionClosed(err) || connection.isClosed) {
				// The agent restarted, or its connection broke, under the turn.
				throw new AgentError({ kind: 'agent-restarted', message: errorMessage(err) });
			}
			throw new AgentError(classifyAgentError(err));
		} finally {
			this.endTurnLocally.delete(endLocally);
			if (!this.endTurnLocally.size) {
				clearTimeout(this.cancelTimer);
				this.cancelTimer = undefined;
			}
			const deferred = this.deferredMode;
			if (--this.turns === 0) {
				this.stallWatch.end();
				if (deferred && this.connection === connection) {
					this.deferredMode = undefined;
					void connection.setMode(state.sessionId, deferred).catch(err => this.runtime.debug(`Could not switch ${state.sessionId} to ${deferred} after the turn: ${errorMessage(err)}`));
				}
			}
		}
	}

	/**
	 * Asks the agent to stop the current turn; the pending `prompt` resolves
	 * with `cancelled`. gemini-cli stops at its next check, which a hung MCP
	 * server or tool can hold up, so a turn still running after a grace period
	 * is ended here (the CLI drops it when the next prompt comes). Without a
	 * session to send the cancel to, it ends at once.
	 */
	async cancel(): Promise<void> {
		const state = this._state;
		const connection = this.connection;
		if (state.kind === 'ready' && connection) {
			try {
				await connection.cancel(state.sessionId);
			} catch (err) {
				this.runtime.debug(`Could not ask the agent to stop the turn in ${state.sessionId}: ${errorMessage(err)}`);
			}
		}
		if (!this.endTurnLocally.size) {
			return;
		}
		if (state.kind !== 'ready' || !connection || connection.isClosed) {
			this.endRunningTurns();
		} else {
			this.cancelTimer ??= setTimeout(() => this.endRunningTurns(), this.options.cancelGraceMs ?? defaultCancelGraceMs);
		}
	}

	private endRunningTurns(): void {
		clearTimeout(this.cancelTimer);
		this.cancelTimer = undefined;
		for (const end of [...this.endTurnLocally]) {
			end();
		}
	}

	/** The running turn's stall, while it has had no update for a while; undefined otherwise. */
	get stall(): TurnStall | undefined {
		return this.stallWatch.stall;
	}

	dispose(): void {
		this.disposed = true;
		this.runtimeListener.dispose();
		this.retryListener.dispose();
		// The agent keeps an open session in memory until it exits; the chat reopens it from the CLI's file when it comes back.
		const state = this._state;
		if (state.kind === 'ready' && this.connection) {
			this.closeSession(this.connection, state.agent, state.sessionId);
		}
		this.endRunningTurns();
		this.stallWatch.dispose();
		for (const done of [...this.onDispose]) {
			done();
		}
		this.onDispose.clear();
		this.dropSession();
		this.onDidChangeStateEmitter.dispose();
		this.onDidReceiveEventEmitter.dispose();
		this.onDidReplayEventEmitter.dispose();
		this.onDidFailToReopenEmitter.dispose();
		this.onDidChangeModeByAgentEmitter.dispose();
		this.onDidAllowInYoloEmitter.dispose();
		this.onDidChangeSettingsEmitter.dispose();
		this.onDidChangeCommandsEmitter.dispose();
	}

	private onRuntimeState(state: AgentRuntimeState): void {
		switch (state.kind) {
			case 'ready':
				if (this.held) {
					// The process is ready; the session opens on `open()`.
					this.setState({ kind: 'connecting' });
				} else {
					void this.openSession(true);
				}
				break;
			case 'connecting':
				this.keepModeAcrossRestart();
				this.dropSession();
				this.setState({ kind: 'connecting' });
				break;
			case 'error':
				this.dropSession();
				this.setState({ kind: 'error', error: state.error });
				break;
			case 'idle':
				this.dropSession();
				this.setState({ kind: 'idle' });
				break;
		}
	}

	/** The session reopened after the agent restarts, such as to trust a folder, opens in the mode this one had. */
	private keepModeAcrossRestart(): void {
		const mode = this._settings.mode?.currentId;
		if (mode && this._state.kind === 'ready') {
			this.pendingMode ??= mode;
		}
	}

	/** Opens a session: with `resume`, the last one is reopened if the agent can, else a new one. */
	private async openSession(resume: boolean): Promise<OpenOutcome> {
		this.dropSession();
		const generation = ++this.generation;
		this.setState({ kind: 'connecting' });
		try {
			if (this.options.beforeOpen) {
				await this.options.beforeOpen();
				if (generation !== this.generation) {
					return { opened: false };
				}
			}
			const { connection, agent, session, savedSessionId, replayUpdates } = await this.loadOrCreate(resume ? this.resumeSessionId : undefined);
			if (generation !== this.generation) {
				// A newer open took over while this one waited: nobody will use a new session it opened.
				// A reopened one keeps its saved id, which the newer open may be reopening too.
				if (replayUpdates === null) {
					this.closeSession(connection, agent, session.sessionId);
				}
				return { opened: false };
			}
			this.connection = connection;
			this.adapter = this.newAdapter();
			if (replayUpdates !== null) {
				// Before registering, which hands over the updates that came first; the count follows once the session file is read.
				this.replay.begin(replayUpdates);
			}
			this.registration = this.runtime.register(session.sessionId, {
				sessionUpdate: update => this.onSessionUpdate(update),
				requestPermission: params => this.requestPermission(params),
				onDidEnd: () => this.onSessionEnded(session.sessionId),
				fileSystem: this.options.fileSystem,
				onDidWriteFile: filePath => this.options.onDidWriteFile?.(filePath),
				beforeWrite: (filePath, content) => this.confirmProtectedWrite(session.sessionId, filePath, content),
			});
			this.resumeSessionId = savedSessionId;
			// Model and mode together rather than one after the other: they are independent, and each is a round trip before the chat is ready.
			const opened = withModelList(filterModes(readSessionSettings(session), this.options.isModeAllowed), this.options.modelList);
			const [withModel, withMode] = await Promise.all([
				this.applyPreferredModel(connection, session.sessionId, opened),
				this.applyPendingMode(connection, session.sessionId, opened),
			]);
			const settings: SessionSettings = { ...opened, model: withModel.model, mode: withMode.mode };
			if (generation !== this.generation) {
				return { opened: false };
			}
			this.setReady(agent, session, savedSessionId, settings);
			return { opened: true };
		} catch (err) {
			// If the process died, the runtime reports why (and the sidecar may
			// restart it); the closed-connection error says less. An error the
			// agent explained, such as a sign-in one, shows at once.
			const error = err instanceof AgentError ? err.info : classifyAgentError(err);
			const explained = error.kind !== 'unknown' && error.kind !== 'agent-exited' && error.kind !== 'agent-restarted';
			if (generation === this.generation && (explained || await this.runtimeStaysReady(1_000)) && generation === this.generation) {
				this.failures++;
				this.failedAt = Date.now();
				this.setState({ kind: 'error', error });
				return { opened: false, error };
			}
			this.runtime.debug(`Opening the session in ${this.options.cwd} failed as the agent went away: ${error.message}`);
			return { opened: false };
		}
	}

	/**
	 * `replayUpdates` is null for a new session, which replays nothing, and
	 * for a reopened one resolves with its replay length, undefined when not known.
	 */
	private async loadOrCreate(resumeSessionId: string | undefined): Promise<Awaited<ReturnType<AgentRuntime['newSession']>> & { readonly savedSessionId: string; readonly replayUpdates: Promise<number | undefined> | null }> {
		if (resumeSessionId) {
			try {
				// The session file is read for its replay length while the agent loads the session by its id;
				// the session registers without waiting for it, so its replay is not held back.
				const finding = (this.options.findSavedSession ?? readCliSession)(this.options.cwd, resumeSessionId).then(found => found?.replayUpdates, err => {
					this.runtime.debug(`Could not read saved session ${resumeSessionId}: ${errorMessage(err)}`);
					return undefined;
				});
				const servers = this.mcpServers();
				const loaded = await this.runtime.loadSession(this.options.cwd, resumeSessionId, undefined, servers);
				this._openedMcpServers = servers;
				return { ...loaded, savedSessionId: resumeSessionId, replayUpdates: finding };
			} catch (err) {
				// Not supported, or the agent no longer has it: start afresh, and say why.
				this.onDidFailToReopenEmitter.fire({ sessionId: resumeSessionId, error: err instanceof AgentError ? err.info : classifyAgentError(err) });
			}
		}
		const created = await this.runtime.newSession(this.options.cwd, this.mcpServers(), this.options.spareKey?.());
		this._openedMcpServers = created.mcpServers;
		this.options.onDidOpenSession?.(created.mcpServers);
		return { ...created, savedSessionId: created.session.sessionId, replayUpdates: null };
	}

	/** The servers for a session the runtime opens now, as far as the agent can take them. */
	private mcpServers(): acp.McpServer[] {
		const state = this.runtime.state;
		return supportedMcpServers(state.kind === 'ready' ? state.agent : undefined, this.options.mcpServers?.() ?? []);
	}

	/** Whether the runtime is still ready after `ms`, or as soon as it changes state. */
	private runtimeStaysReady(ms: number): Promise<boolean> {
		if (this.runtime.state.kind !== 'ready') {
			return Promise.resolve(false);
		}
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				listener.dispose();
				resolve(true);
			}, ms);
			const listener = this.runtime.onDidChangeState(() => {
				clearTimeout(timer);
				listener.dispose();
				resolve(false);
			});
		});
	}

	private onSessionUpdate(update: acp.SessionUpdate): void {
		if (this.replay.active && replayKinds.has(update.sessionUpdate)) {
			this.onReplayed(update);
			return;
		}
		if (this.turns > 0) {
			this.stallWatch.noteActivity();
			if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
				this.stallWatch.toolCall(update.toolCallId, update.status, update.sessionUpdate === 'tool_call');
			}
		}
		if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' && modeUpdateText.test(update.content.text.trim())) {
			const modes = update.content.text.trim().split('[MODE_UPDATE] ').filter(Boolean);
			this.onModeUpdate(modes[modes.length - 1].trim());
			return;
		}
		if (update.sessionUpdate === 'current_mode_update' && this._settings.mode) {
			this.setSettings({ ...this._settings, mode: { ...this._settings.mode, currentId: update.currentModeId } });
		}
		if (update.sessionUpdate === 'available_commands_update') {
			this.setCommands(update.availableCommands
				.filter(c => typeof c.name === 'string' && c.name)
				.map(c => ({ name: c.name.replace(/^\//, ''), description: c.description ?? '', source: 'cli' as const })));
			return;
		}
		this.onDidReceiveEventEmitter.fire(this.adapter.adapt(update));
	}

	/**
	 * A mode change the CLI made itself. Allowing an edit for the session
	 * makes gemini-cli 0.63 switch to Auto Edit even from YOLO
	 * (`isAutoEditTransition`), which would make YOLO ask again: the user's
	 * YOLO is put back at once. Other changes, such as out of Plan once a plan
	 * is approved, are the agent's to make and are kept.
	 */
	private onModeUpdate(modeId: string): void {
		const mode = this._settings.mode;
		const state = this._state;
		if (!mode || !mode.available.some(choice => choice.id === modeId) || mode.currentId === modeId) {
			return;
		}
		if (this.chosenMode === 'yolo' && modeId === 'autoEdit' && this.deferredMode === 'yolo') {
			// YOLO is sent when the turn ends.
			return;
		}
		if (this.chosenMode === 'yolo' && modeId === 'autoEdit' && state.kind === 'ready' && this.connection) {
			void this.connection.setMode(state.sessionId, 'yolo').catch(err => {
				this.runtime.debug(`Could not put ${state.sessionId} back in YOLO: ${errorMessage(err)}`);
				this.setSettings({ ...this._settings, mode: { ...mode, currentId: modeId } });
			});
			return;
		}
		const from = mode.currentId;
		this.chosenMode = modeId;
		this.setSettings({ ...this._settings, mode: { ...mode, currentId: modeId } });
		this.onDidChangeModeByAgentEmitter.fire({ from, to: modeId });
	}

	/**
	 * Asks the user, through the chat. In YOLO a request should not come; when
	 * one does anyway, it is allowed at once, as the user chose (and as the
	 * admin policy allows, else YOLO would not be offered), except for the
	 * confirm class, which the admin policy makes ask in every mode.
	 */
	private requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
		const allow = params.options.find(option => option.kind === 'allow_once') ?? params.options.find(option => option.kind === 'allow_always');
		if (this._settings.mode?.currentId === 'yolo' && allow && (this.options.isModeAllowed?.('yolo') ?? true) && !this.options.alwaysAsks?.(params)) {
			this.onDidAllowInYoloEmitter.fire(params);
			return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } });
		}
		return this.askUser(params);
	}

	/** Asks the host; while the user decides, the turn does not count as stalled. */
	private async askUser(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
		this.stallWatch.waitBegin();
		try {
			return await this.options.requestPermission(params);
		} finally {
			this.stallWatch.waitEnd();
		}
	}

	/**
	 * In Auto Edit the CLI applies edits without asking, and its policy engine is
	 * not consulted for them (gemini-cli 0.66), so an edit to a file that
	 * decides what runs next (a git hook, a build file, the worktree setup
	 * script, the CLI's project settings, the folder's editor settings and
	 * tasks, the ignore files) asks here, as a card, before the write. Other
	 * modes ask already (Default) or never (YOLO).
	 */
	private async confirmProtectedWrite(sessionId: string, filePath: string, content: string): Promise<void> {
		if (this._settings.mode?.currentId !== 'autoEdit' || !decidesWhatRuns(filePath)) {
			return;
		}
		const oldText = await fs.readFile(filePath, 'utf8').catch(() => null);
		const request = protectedWriteRequest(sessionId, filePath, oldText, content);
		const response = await this.askUser(request);
		if (!isAllowed(request, response)) {
			throw new FileAccessDeniedError(filePath, 'the user did not allow the edit, since this file decides what runs next');
		}
	}

	/** One replayed update: shown to whoever shows the replay (cleaned), never as part of a turn. */
	private onReplayed(update: acp.SessionUpdate): void {
		const event = this.adapter.adapt(update);
		if (event.kind === 'text') {
			const text = withoutReplayMarkers(event.text);
			if (text) {
				this.onDidReplayEventEmitter.fire({ ...event, text });
			}
		} else {
			this.onDidReplayEventEmitter.fire(event);
		}
		this.replay.received();
	}

	/** Frees a session the agent keeps in memory, when it can close sessions (gemini-cli 0.64 cannot); never throws. */
	private newAdapter(): SessionUpdateAdapter {
		return new SessionUpdateAdapter(() => this.state.kind === 'ready' ? this.options.explainFileError?.(this.state.savedSessionId) : undefined);
	}

	private closeSession(connection: AgentConnection, agent: acp.InitializeResponse, sessionId: string): void {
		if (agent.agentCapabilities?.sessionCapabilities?.close) {
			void connection.close(sessionId).catch(err => this.runtime.debug(`Could not close session ${sessionId}: ${errorMessage(err)}`));
		}
	}

	/** The process of its folder's own the session was open on ended, the shared one still running: it opens again (`retryOpen`). */
	private onSessionEnded(sessionId: string): void {
		if (this._state.kind === 'ready' && this._state.sessionId === sessionId) {
			this.dropSession();
			this.failures++;
			this.failedAt = Date.now();
			this.setState({ kind: 'error', error: { kind: 'agent-exited', message: 'The agent process stopped.' } });
			void this.retryOpen();
		}
	}

	/** Stops listening to the current session; it stays in the agent's memory unless closed (`closeSession`). */
	private dropSession(): void {
		this.replay.end();
		this.generation++;
		this.registration?.dispose();
		this.registration = undefined;
		this.connection = undefined;
	}

	/** Switches a session that just opened to the preferred model, before any prompt can reach it. */
	private async applyPreferredModel(connection: AgentConnection, sessionId: string, settings: SessionSettings): Promise<SessionSettings> {
		const model = settings.model;
		const preferred = model && this.options.preferredModel?.(model.available);
		if (!preferred || !model || model.currentId === preferred || !model.available.some(choice => choice.id === preferred)) {
			return settings;
		}
		try {
			await connection.setModel(sessionId, preferred);
			return { ...settings, model: { ...model, currentId: preferred } };
		} catch (err) {
			// The session keeps the agent's default; the picker shows it.
			this.runtime.debug(`Could not switch ${sessionId} to ${preferred}: ${errorMessage(err)}`);
			return settings;
		}
	}

	private async applyPendingMode(connection: AgentConnection, sessionId: string, settings: SessionSettings): Promise<SessionSettings> {
		const modeId = this.pendingMode;
		this.pendingMode = undefined;
		const mode = settings.mode;
		if (!modeId || !mode || mode.currentId === modeId || !mode.available.some(choice => choice.id === modeId)) {
			return settings;
		}
		try {
			await connection.setMode(sessionId, modeId);
			return { ...settings, mode: { ...mode, currentId: modeId } };
		} catch (err) {
			// The session still opens, in the mode the agent chose.
			this.runtime.debug(`Could not switch ${sessionId} to ${modeId}: ${errorMessage(err)}`);
			return settings;
		}
	}

	private setReady(agent: acp.InitializeResponse, session: acp.NewSessionResponse, savedSessionId: string, settings: SessionSettings): void {
		this.failures = 0;
		this.setSettings(settings);
		this.setState({ kind: 'ready', sessionId: session.sessionId, savedSessionId, agent, session });
	}

	/**
	 * Asks the agent to change the mode or model. An agent that does not
	 * implement the method (-32601) loses the control instead of failing.
	 */
	private async changeSetting(key: keyof SessionSettings, id: string, request: (connection: AgentConnection, sessionId: string) => Promise<unknown>): Promise<void> {
		const state = this._state;
		const selector = this._settings[key];
		if (state.kind !== 'ready' || !this.connection || !selector || !selector.available.some(choice => choice.id === id)) {
			return;
		}
		try {
			await request(this.connection, state.sessionId);
			this.setSettings({ ...this._settings, [key]: { ...selector, currentId: id } });
		} catch (err) {
			if ((err as { code?: unknown }).code === METHOD_NOT_FOUND) {
				this.setSettings({ ...this._settings, [key]: undefined });
				return;
			}
			throw new AgentError(classifyAgentError(err));
		}
	}

	private setCommands(commands: readonly SlashCommand[]): void {
		if (commands.length || this._commands.length) {
			this._commands = commands;
			this.onDidChangeCommandsEmitter.fire(commands);
		}
	}

	private setSettings(settings: SessionSettings): void {
		this._settings = settings;
		this.onDidChangeSettingsEmitter.fire(settings);
	}

	private setState(state: AgentClientState): void {
		if (state.kind !== 'ready' && (this._settings.mode || this._settings.model)) {
			this.setSettings({});
		}
		if (state.kind !== 'ready' && state.kind !== 'connecting') {
			this.setCommands([]);
		}
		this._state = state;
		this.onDidChangeStateEmitter.fire(state);
	}
}


/** `servers` without those over a transport the agent does not advertise (ACP `mcpCapabilities`); every agent takes stdio. */
export function supportedMcpServers(agent: acp.InitializeResponse | undefined, servers: readonly acp.McpServer[]): acp.McpServer[] {
	const transports = agent?.agentCapabilities?.mcpCapabilities;
	return servers.filter(server => {
		// Only stdio servers come without a `type`.
		const type = (server as { readonly type?: 'http' | 'sse' | 'acp' }).type;
		return type === undefined || transports?.[type] === true;
	});
}

/** `settings` with its models shaped by `modelList`, keeping the current model listed even when the shaping would drop it. */
function withModelList(settings: SessionSettings, modelList: AgentClientOptions['modelList']): SessionSettings {
	const model = settings.model;
	if (!model || !modelList) {
		return settings;
	}
	const available = [...modelList(model.available)];
	if (!available.some(choice => choice.id === model.currentId)) {
		const current = model.available.find(choice => choice.id === model.currentId);
		if (current) {
			available.unshift(current);
		}
	}
	return { ...settings, model: { ...model, available } };
}
