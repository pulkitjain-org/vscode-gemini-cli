/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import type { AgentConnection } from './agentConnection';
import { AgentError, AgentErrorInfo, classifyAgentError } from './errors';
import { Emitter } from './events';
import { AgentRuntime, AgentRuntimeState, FileSystemHandlers } from './agentRuntime';
import { findCliSession, readCliSession } from './cliSessions';
import { isOlderThan } from './cliResolution';
import { withoutReplayMarkers } from './replayText';
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
	readonly index?: number;
	readonly firstPrompt?: string;
	/** How many updates the CLI replays on `session/load`; unknown when unset. */
	readonly replayUpdates?: number;
}

/**
 * gemini-cli before 0.63 loses a saved session loaded by its id (see
 * cliSessions.ts), so those are loaded by their number in the CLI's list.
 */
const loadsByIdFrom = '0.63.0';

/** After this long without a replayed update, a replay whose length is not known is taken as over. */
const replayQuietMs = 250;

/** Updates the CLI sends when it replays a saved session's history. */
const replayKinds: ReadonlySet<string> = new Set(['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call']);

export interface AgentClientOptions {
	readonly cwd: string;
	/** Asked for every `session/request_permission`; must resolve, with `cancelled` if nothing else. */
	readonly requestPermission: (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
	/** Serves this session's file reads and writes instead of the runtime's handlers. */
	readonly fileSystem?: FileSystemHandlers;
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
	/** Which approval modes the picker may offer; all of them when unset. */
	readonly isModeAllowed?: (modeId: string) => boolean;
	/**
	 * Finds a saved session in the CLI's files: its number and first prompt
	 * (for a CLI that must load it by number) and how many updates its replay
	 * has. The CLI's own files when unset.
	 */
	readonly findSavedSession?: (cwd: string, id: string, byNumber: boolean) => Promise<SavedSession | undefined>;
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

	private _commands: readonly SlashCommand[] = [];
	private _state: AgentClientState = { kind: 'idle' };
	private _settings: SessionSettings = {};
	private pendingMode: string | undefined;
	private connection: AgentConnection | undefined;
	private adapter = new SessionUpdateAdapter();
	private registration: { dispose(): void } | undefined;
	/** Bumped on every reconnect, so a slow `session/new` for an old process is ignored. */
	private generation = 0;
	/** The session to reopen when the agent (re)starts, so a restart keeps the conversation. */
	private resumeSessionId: string | undefined;
	private readonly runtimeListener: { dispose(): void };
	/** Set until `open()` with `openLater`: the runtime may be ready, but no session is opened yet. */
	private held: boolean;
	/** While a reopened session replays its history: updates still to come (unknown when unset), and the end that prompts wait for. */
	private replay: { remaining?: number; quiet?: ReturnType<typeof setTimeout>; readonly done: Promise<void>; readonly end: () => void } | undefined;

	constructor(private readonly runtime: AgentRuntime, private readonly options: AgentClientOptions) {
		this.resumeSessionId = options.resumeSessionId;
		this.held = !!options.openLater;
		this.runtimeListener = runtime.onDidChangeState(state => this.onRuntimeState(state));
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

	/** Starts a fresh session on the running agent; the old conversation is gone for the agent too. */
	async newSession(): Promise<void> {
		if (this._state.kind !== 'ready' || this.runtime.state.kind !== 'ready') {
			throw new Error('The agent is not ready.');
		}
		await this.openSession(false);
	}

	/**
	 * Replaces the current session with saved session `id`, such as one
	 * started in the terminal. Resolves with whether the agent opened it; if
	 * not, the chat carries on in a new session.
	 */
	async loadSession(id: string): Promise<boolean> {
		if (this._state.kind !== 'ready' || this.runtime.state.kind !== 'ready') {
			throw new Error('The agent is not ready.');
		}
		this.resumeSessionId = id;
		await this.openSession(true);
		return this._state.kind === 'ready' && this._state.savedSessionId === id;
	}

	/** Makes the next session a new one instead of reopening the last, for a chat cleared while the agent is not running. */
	forgetSession(): void {
		this.resumeSessionId = undefined;
	}

	/** Switches the next session this client opens, such as the one reopened after a restart, to `modeId`. */
	setModeOnNextSession(modeId: string): void {
		this.pendingMode = modeId;
	}

	setMode(modeId: string): Promise<void> {
		return this.changeSetting('mode', modeId, (connection, sessionId) => connection.setMode(sessionId, modeId));
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
		if (this.replay) {
			// The answer must not mix with the history still arriving.
			await this.replay.done;
		}
		const state = this._state;
		if (state.kind !== 'ready' || !this.connection) {
			throw new Error('The agent is not ready.');
		}
		try {
			const response = await this.runtime.trackTurn(this.connection.prompt(state.sessionId, typeof content === 'string' ? [{ type: 'text', text: content }] : content));
			const usage = readTurnUsage(response._meta);
			return { stopReason: response.stopReason, ...(usage ? { usage } : {}) };
		} catch (err) {
			throw new AgentError(classifyAgentError(err));
		}
	}

	/** Asks the agent to stop the current turn; the pending `prompt` resolves with `cancelled`. */
	async cancel(): Promise<void> {
		if (this._state.kind === 'ready' && this.connection) {
			await this.connection.cancel(this._state.sessionId);
		}
	}

	dispose(): void {
		this.runtimeListener.dispose();
		this.dropSession();
		this.onDidChangeStateEmitter.dispose();
		this.onDidReceiveEventEmitter.dispose();
		this.onDidReplayEventEmitter.dispose();
		this.onDidFailToReopenEmitter.dispose();
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

	/** Opens a session: with `resume`, the last one is reopened if the agent can, else a new one. */
	private async openSession(resume: boolean): Promise<void> {
		this.dropSession();
		const generation = ++this.generation;
		this.setState({ kind: 'connecting' });
		try {
			const { connection, agent, session, savedSessionId, replayUpdates } = await this.loadOrCreate(resume ? this.resumeSessionId : undefined);
			if (generation !== this.generation) {
				return;
			}
			this.connection = connection;
			this.adapter = new SessionUpdateAdapter();
			if (replayUpdates !== null) {
				// Before registering, which hands over the updates that came first.
				this.beginReplay(replayUpdates);
			}
			this.registration = this.runtime.register(session.sessionId, {
				sessionUpdate: update => this.onSessionUpdate(update),
				requestPermission: params => this.options.requestPermission(params),
				fileSystem: this.options.fileSystem,
			});
			this.resumeSessionId = savedSessionId;
			// Model and mode together rather than one after the other: they are independent, and each is a round trip before the chat is ready.
			const opened = filterModes(readSessionSettings(session), this.options.isModeAllowed);
			const [withModel, withMode] = await Promise.all([
				this.applyPreferredModel(connection, session.sessionId, opened),
				this.applyPendingMode(connection, session.sessionId, opened),
			]);
			const settings: SessionSettings = { ...opened, model: withModel.model, mode: withMode.mode };
			if (generation !== this.generation) {
				return;
			}
			this.setReady(agent, session, savedSessionId, settings);
		} catch (err) {
			// If the process died, the runtime reports why (and the sidecar may
			// restart it); the closed-connection error says less.
			if (generation === this.generation && await this.runtimeStaysReady(1_000) && generation === this.generation) {
				this.setState({ kind: 'error', error: err instanceof AgentError ? err.info : classifyAgentError(err) });
			}
		}
	}

	/** `replayUpdates` is null for a new session, which replays nothing, and undefined for a reopened one whose replay length is unknown. */
	private async loadOrCreate(resumeSessionId: string | undefined): Promise<Awaited<ReturnType<AgentRuntime['newSession']>> & { readonly savedSessionId: string; readonly replayUpdates: number | undefined | null }> {
		if (resumeSessionId) {
			try {
				const version = this.runtime.state.kind === 'ready' ? this.runtime.state.agent.agentInfo?.version ?? '' : '';
				const byNumber = isOlderThan(version, loadsByIdFrom);
				const saved = await (this.options.findSavedSession ?? findSavedCliSession)(this.options.cwd, resumeSessionId, byNumber).catch(() => undefined);
				const loadId = byNumber && saved?.index !== undefined ? String(saved.index) : resumeSessionId;
				// The first-prompt check is only for a load by number, where the number may have moved to another session.
				const loaded = await this.runtime.loadSession(this.options.cwd, loadId, byNumber ? saved?.firstPrompt : undefined, this.mcpServers());
				return { ...loaded, savedSessionId: resumeSessionId, replayUpdates: saved?.replayUpdates };
			} catch (err) {
				// Not supported, or the agent no longer has it: start afresh, and say why.
				this.onDidFailToReopenEmitter.fire({ sessionId: resumeSessionId, error: err instanceof AgentError ? err.info : classifyAgentError(err) });
			}
		}
		const created = await this.runtime.newSession(this.options.cwd, this.mcpServers(), this.options.spareKey?.());
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
		if (this.replay && replayKinds.has(update.sessionUpdate)) {
			this.onReplayed(update);
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

	/** Starts counting a reopened session's replay; `count` updates are coming, or an unknown number. */
	private beginReplay(count: number | undefined): void {
		this.endReplay();
		let end!: () => void;
		const done = new Promise<void>(resolve => end = resolve);
		this.replay = { remaining: count, done, end };
		if (count === 0) {
			this.endReplay();
		} else {
			this.armReplayQuiet();
		}
	}

	/** One replayed update: shown to whoever shows the replay (cleaned), never as part of a turn. */
	private onReplayed(update: acp.SessionUpdate): void {
		const replay = this.replay!;
		const event = this.adapter.adapt(update);
		if (event.kind === 'text') {
			const text = withoutReplayMarkers(event.text);
			if (text) {
				this.onDidReplayEventEmitter.fire({ ...event, text });
			}
		} else {
			this.onDidReplayEventEmitter.fire(event);
		}
		if (replay.remaining !== undefined && --replay.remaining <= 0) {
			this.endReplay();
		} else {
			this.armReplayQuiet();
		}
	}

	/**
	 * Ends the replay when no update came for a while. With a known count it
	 * is a fallback for a count that is off; prompts wait for nothing longer.
	 */
	private armReplayQuiet(): void {
		const replay = this.replay;
		if (replay) {
			clearTimeout(replay.quiet);
			replay.quiet = setTimeout(() => this.replay === replay && this.endReplay(), replayQuietMs);
		}
	}

	private endReplay(): void {
		const replay = this.replay;
		this.replay = undefined;
		if (replay) {
			clearTimeout(replay.quiet);
			replay.end();
		}
	}

	/** Stops listening to the current session. The CLI has no way to close one, so it stays in the agent's memory. */
	private dropSession(): void {
		this.endReplay();
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
		} catch {
			// The session keeps the agent's default; the picker shows it.
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
		} catch {
			// The session still opens, in the mode the agent chose.
			return settings;
		}
	}

	private setReady(agent: acp.InitializeResponse, session: acp.NewSessionResponse, savedSessionId: string, settings: SessionSettings): void {
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

/** The CLI's saved session `id` in `cwd`: from its own file, or numbered as the CLI lists it for a load by number. */
async function findSavedCliSession(cwd: string, id: string, byNumber: boolean): Promise<SavedSession | undefined> {
	return byNumber ? findCliSession(cwd, id) : readCliSession(cwd, id);
}
