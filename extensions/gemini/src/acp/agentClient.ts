/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as acp from '@agentclientprotocol/sdk';
import { AgentClientHandlers, AgentConnection } from './agentConnection';
import { AgentError, AgentErrorInfo, classifyAgentError } from './errors';
import { Emitter } from './events';
import { readSessionSettings, SessionSettings } from './sessionSettings';
import { ChatEvent, SessionUpdateAdapter } from './sessionUpdates';
import { AgentSidecar, SidecarState } from './sidecar';

/** The one auth method the IDE ever selects (plan C4). */
export const AUTH_METHOD_ID = 'oauth-personal';

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
	/** Serves the agent's file reads and writes; without it the agent uses the disk directly. */
	readonly fileSystem?: Pick<AgentClientHandlers, 'readTextFile' | 'writeTextFile'>;
}

/**
 * Owns the ACP conversation on top of the sidecar: on every new agent process
 * it runs `initialize` and `session/new` (authenticating once with
 * `oauth-personal` when the agent asks), then serves prompts for that session.
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
	private readonly sidecarListener: { dispose(): void };

	constructor(sidecar: AgentSidecar, private readonly options: AgentClientOptions) {
		this.sidecarListener = sidecar.onDidChangeState(state => this.onSidecarState(state));
	}

	get state(): AgentClientState {
		return this._state;
	}

	get settings(): SessionSettings {
		return this._settings;
	}

	/** Starts a fresh session on the running agent; the old conversation is gone for the agent too. */
	async newSession(): Promise<void> {
		const state = this._state;
		const connection = this.connection;
		if (state.kind !== 'ready' || !connection) {
			throw new Error('The agent is not ready.');
		}
		this.adapter = new SessionUpdateAdapter();
		this.setState({ kind: 'connecting' });
		try {
			const session = await this.newSessionWithAuth(connection, state.agent);
			if (this.connection === connection) {
				this.setReady(state.agent, session);
			}
		} catch (err) {
			if (this.connection === connection) {
				this.setState({ kind: 'error', error: err instanceof AgentError ? err.info : classifyAgentError(err) });
			}
		}
	}

	setMode(modeId: string): Promise<void> {
		return this.changeSetting('mode', modeId, (connection, sessionId) => connection.setMode(sessionId, modeId));
	}

	setModel(modelId: string): Promise<void> {
		return this.changeSetting('model', modelId, (connection, sessionId) => connection.setModel(sessionId, modelId));
	}

	/** Sends a text prompt and resolves when the turn ends. Updates stream through `onDidReceiveEvent`. */
	async prompt(text: string): Promise<acp.StopReason> {
		const state = this._state;
		if (state.kind !== 'ready' || !this.connection) {
			throw new Error('The agent is not ready.');
		}
		try {
			const response = await this.connection.prompt(state.sessionId, [{ type: 'text', text }]);
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
		this.sidecarListener.dispose();
		this.connection?.dispose();
		this.onDidChangeStateEmitter.dispose();
		this.onDidReceiveEventEmitter.dispose();
		this.onDidChangeSettingsEmitter.dispose();
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
		this.adapter = new SessionUpdateAdapter();
		const connection = new AgentConnection(agentProcess.stdin, agentProcess.stdout, {
			sessionUpdate: params => {
				if (params.update.sessionUpdate === 'current_mode_update' && this._settings.mode) {
					this.setSettings({ ...this._settings, mode: { ...this._settings.mode, currentId: params.update.currentModeId } });
				}
				this.onDidReceiveEventEmitter.fire(this.adapter.adapt(params.update));
			},
			requestPermission: params => this.options.requestPermission(params),
			readTextFile: this.options.fileSystem?.readTextFile,
			writeTextFile: this.options.fileSystem?.writeTextFile,
		});
		this.connection = connection;
		this.setState({ kind: 'connecting' });
		try {
			const agent = await connection.initialize();
			const session = await this.newSessionWithAuth(connection, agent);
			if (this.connection === connection) {
				this.setReady(agent, session);
			}
		} catch (err) {
			// If the process died, the sidecar reports why (and may restart it);
			// the closed-connection error says less.
			if (this.connection === connection && !await exitsWithin(agentProcess, 1_000)) {
				this.setState({ kind: 'error', error: err instanceof AgentError ? err.info : classifyAgentError(err) });
			}
		}
	}

	private async newSessionWithAuth(connection: AgentConnection, agent: acp.InitializeResponse): Promise<acp.NewSessionResponse> {
		try {
			return await connection.newSession(this.options.cwd);
		} catch (err) {
			const info = classifyAgentError(err);
			const canAuthenticate = agent.authMethods?.some(m => m.id === AUTH_METHOD_ID);
			if (info.kind !== 'auth-required' || !canAuthenticate) {
				throw new AgentError(info);
			}
		}
		// Only now, and only with oauth-personal: `authenticate` rewrites the
		// user's ~/.gemini/settings.json (plan C4).
		try {
			await connection.authenticate(AUTH_METHOD_ID);
			return await connection.newSession(this.options.cwd);
		} catch (err) {
			throw new AgentError(classifyAgentError(err));
		}
	}

	private dropConnection(): void {
		this.connection?.dispose();
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
