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
import { readSessionSettings, SessionSettings } from './sessionSettings';
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
	private connection: AgentConnection | undefined;
	private adapter = new SessionUpdateAdapter();
	private registration: { dispose(): void } | undefined;
	/** Bumped on every reconnect, so a slow `session/new` for an old process is ignored. */
	private generation = 0;
	private readonly runtimeListener: { dispose(): void };

	constructor(private readonly runtime: AgentRuntime, private readonly options: AgentClientOptions) {
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
		await this.openSession();
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
			const response = await this.connection.prompt(state.sessionId, typeof content === 'string' ? [{ type: 'text', text: content }] : content);
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
				void this.openSession();
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

	private async openSession(): Promise<void> {
		this.dropSession();
		const generation = ++this.generation;
		this.setState({ kind: 'connecting' });
		try {
			const { connection, agent, session } = await this.runtime.newSession(this.options.cwd);
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
			this.setReady(agent, session);
		} catch (err) {
			// If the process died, the runtime reports why (and the sidecar may
			// restart it); the closed-connection error says less.
			if (generation === this.generation && await this.runtimeStaysReady(1_000) && generation === this.generation) {
				this.setState({ kind: 'error', error: err instanceof AgentError ? err.info : classifyAgentError(err) });
			}
		}
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

	private setReady(agent: acp.InitializeResponse, session: acp.NewSessionResponse): void {
		this.setSettings(readSessionSettings(session));
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
