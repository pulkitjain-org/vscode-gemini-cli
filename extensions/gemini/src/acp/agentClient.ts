/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as acp from '@agentclientprotocol/sdk';
import { AgentClientHandlers, AgentConnection } from './agentConnection';
import { AgentError, AgentErrorInfo, classifyAgentError } from './errors';
import { Emitter } from './events';
import { ChatEvent, SessionUpdateAdapter } from './sessionUpdates';
import { AgentSidecar, SidecarState } from './sidecar';

/** The one auth method the IDE ever selects (plan C4). */
export const AUTH_METHOD_ID = 'oauth-personal';

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

	private _state: AgentClientState = { kind: 'idle' };
	private connection: AgentConnection | undefined;
	private adapter = new SessionUpdateAdapter();
	private readonly sidecarListener: { dispose(): void };

	constructor(sidecar: AgentSidecar, private readonly options: AgentClientOptions) {
		this.sidecarListener = sidecar.onDidChangeState(state => this.onSidecarState(state));
	}

	get state(): AgentClientState {
		return this._state;
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
			sessionUpdate: params => this.onDidReceiveEventEmitter.fire(this.adapter.adapt(params.update)),
			requestPermission: params => this.options.requestPermission(params),
			readTextFile: this.options.fileSystem?.readTextFile,
			writeTextFile: this.options.fileSystem?.writeTextFile,
		});
		this.connection = connection;
		this.setState({ kind: 'connecting' });
		try {
			const agent = await connection.initialize();
			const session = await this.newSession(connection, agent);
			if (this.connection === connection) {
				this.setState({ kind: 'ready', sessionId: session.sessionId, agent, session });
			}
		} catch (err) {
			// If the process died, the sidecar reports why (and may restart it);
			// the closed-connection error says less.
			if (this.connection === connection && !await exitsWithin(agentProcess, 1_000)) {
				this.setState({ kind: 'error', error: err instanceof AgentError ? err.info : classifyAgentError(err) });
			}
		}
	}

	private async newSession(connection: AgentConnection, agent: acp.InitializeResponse): Promise<acp.NewSessionResponse> {
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

	private setState(state: AgentClientState): void {
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
