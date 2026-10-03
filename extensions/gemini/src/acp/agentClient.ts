/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import type { AgentConnection } from './agentConnection';
import { AgentError, AgentErrorInfo, classifyAgentError } from './errors';
import { Emitter } from './events';
import { AgentRuntime, AgentRuntimeState, FileSystemHandlers } from './agentRuntime';
import { PromptCapabilities, readPromptCapabilities } from './promptContent';
import { filterModes, readSessionSettings, SessionSettings } from './sessionSettings';
import { ChatEvent, SessionUpdateAdapter } from './sessionUpdates';

export { AUTH_METHOD_ID } from './agentRuntime';

/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601;

export type AgentClientState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'connecting' }
	| { readonly kind: 'ready'; readonly sessionId: string; readonly agent: acp.InitializeResponse; readonly session: acp.NewSessionResponse }
	| { readonly kind: 'error'; readonly error: AgentErrorInfo };

export interface AgentClientOptions {
	readonly cwd: string;
	/** Asked for every `session/request_permission`; must resolve, with `cancelled` if nothing else. */
	readonly requestPermission: (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
	/** Serves this session's file reads and writes instead of the runtime's handlers. */
	readonly fileSystem?: FileSystemHandlers;
	/** A session from an earlier run to reopen first, when the agent supports `session/load`. */
	readonly resumeSessionId?: string;
	/**
	 * The model to switch each new or reopened session to, such as the one the
	 * user picked last; ignored when the agent does not offer it. Picking a
	 * model rather than Auto also spares gemini-cli its routing call before
	 * every prompt.
	 */
	readonly preferredModel?: () => string | undefined;
	/** Which approval modes the picker may offer; all of them when unset. */
	readonly isModeAllowed?: (modeId: string) => boolean;
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

	private readonly onDidChangeSettingsEmitter = new Emitter<SessionSettings>();
	/** The current session's mode and model choices changed. */
	readonly onDidChangeSettings = this.onDidChangeSettingsEmitter.event;

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

	constructor(private readonly runtime: AgentRuntime, private readonly options: AgentClientOptions) {
		this.resumeSessionId = options.resumeSessionId;
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

	/** Starts a fresh session on the running agent; the old conversation is gone for the agent too. */
	async newSession(): Promise<void> {
		if (this._state.kind !== 'ready' || this.runtime.state.kind !== 'ready') {
			throw new Error('The agent is not ready.');
		}
		await this.openSession(false);
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
		const state = this._state;
		if (state.kind !== 'ready' || !this.connection) {
			throw new Error('The agent is not ready.');
		}
		try {
			const response = await this.runtime.trackTurn(this.connection.prompt(state.sessionId, typeof content === 'string' ? [{ type: 'text', text: content }] : content));
			return response.stopReason;
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
		this.onDidChangeSettingsEmitter.dispose();
	}

	private onRuntimeState(state: AgentRuntimeState): void {
		switch (state.kind) {
			case 'ready':
				void this.openSession(true);
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
			const { connection, agent, session } = await this.loadOrCreate(resume ? this.resumeSessionId : undefined);
			if (generation !== this.generation) {
				return;
			}
			this.connection = connection;
			this.adapter = new SessionUpdateAdapter();
			this.registration = this.runtime.register(session.sessionId, {
				sessionUpdate: update => this.onSessionUpdate(update),
				requestPermission: params => this.options.requestPermission(params),
				fileSystem: this.options.fileSystem,
			});
			this.resumeSessionId = session.sessionId;
			const preferred = await this.applyPreferredModel(connection, session.sessionId, filterModes(readSessionSettings(session), this.options.isModeAllowed));
			const settings = await this.applyPendingMode(connection, session.sessionId, preferred);
			if (generation !== this.generation) {
				return;
			}
			this.setReady(agent, session, settings);
		} catch (err) {
			// If the process died, the runtime reports why (and the sidecar may
			// restart it); the closed-connection error says less.
			if (generation === this.generation && await this.runtimeStaysReady(1_000) && generation === this.generation) {
				this.setState({ kind: 'error', error: err instanceof AgentError ? err.info : classifyAgentError(err) });
			}
		}
	}

	private async loadOrCreate(resumeSessionId: string | undefined): ReturnType<AgentRuntime['newSession']> {
		if (resumeSessionId) {
			try {
				return await this.runtime.loadSession(this.options.cwd, resumeSessionId);
			} catch {
				// Not supported, or the agent no longer has it: start afresh.
			}
		}
		return this.runtime.newSession(this.options.cwd);
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
		if (update.sessionUpdate === 'current_mode_update' && this._settings.mode) {
			this.setSettings({ ...this._settings, mode: { ...this._settings.mode, currentId: update.currentModeId } });
		}
		this.onDidReceiveEventEmitter.fire(this.adapter.adapt(update));
	}

	/** Stops listening to the current session. The CLI has no way to close one, so it stays in the agent's memory. */
	private dropSession(): void {
		this.generation++;
		this.registration?.dispose();
		this.registration = undefined;
		this.connection = undefined;
	}

	/** Switches a session that just opened to the preferred model, before any prompt can reach it. */
	private async applyPreferredModel(connection: AgentConnection, sessionId: string, settings: SessionSettings): Promise<SessionSettings> {
		const preferred = this.options.preferredModel?.();
		const model = settings.model;
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

	private setReady(agent: acp.InitializeResponse, session: acp.NewSessionResponse, settings: SessionSettings): void {
		this.setSettings(settings);
		this.setState({ kind: 'ready', sessionId: session.sessionId, agent, session });
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

	private setSettings(settings: SessionSettings): void {
		this._settings = settings;
		this.onDidChangeSettingsEmitter.fire(settings);
	}

	private setState(state: AgentClientState): void {
		if (state.kind !== 'ready' && (this._settings.mode || this._settings.model)) {
			this.setSettings({});
		}
		this._state = state;
		this.onDidChangeStateEmitter.fire(state);
	}
}
