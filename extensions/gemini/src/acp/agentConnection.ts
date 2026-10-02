/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { CLIENT_INFO, SUPPORTED_PROTOCOL_VERSION, UnsupportedProtocolVersionError } from './protocol';

/**
 * Handlers for the requests and notifications the agent sends to the client.
 */
export interface AgentClientHandlers {
	sessionUpdate(params: acp.SessionNotification): void | Promise<void>;
	requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
}

/**
 * A JSON-RPC connection to an ACP agent over a pair of byte streams
 * (normally the sidecar's stdin and stdout).
 */
export class AgentConnection {

	private readonly connection: acp.ClientConnection;

	constructor(toAgent: Writable, fromAgent: Readable, handlers: AgentClientHandlers) {
		const stream = acp.ndJsonStream(
			Writable.toWeb(toAgent) as WritableStream<Uint8Array>,
			Readable.toWeb(fromAgent) as ReadableStream<Uint8Array>,
		);
		this.connection = acp.client({ name: CLIENT_INFO.name })
			.onRequest('session/request_permission', ctx => handlers.requestPermission(ctx.params))
			.onNotification('session/update', ctx => handlers.sessionUpdate(ctx.params))
			.connect(stream);
	}

	/** Resolves when the connection closes, for any reason. */
	get closed(): Promise<void> {
		return this.connection.closed;
	}

	/**
	 * Runs `initialize` and checks that the agent speaks our protocol version.
	 * No file system or terminal capabilities are advertised yet.
	 */
	async initialize(): Promise<acp.InitializeResponse> {
		const response = await this.connection.agent.request('initialize', {
			protocolVersion: SUPPORTED_PROTOCOL_VERSION,
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
			},
			clientInfo: CLIENT_INFO,
		});
		if (response.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
			throw new UnsupportedProtocolVersionError(response.protocolVersion);
		}
		return response;
	}

	newSession(cwd: string): Promise<acp.NewSessionResponse> {
		return this.connection.agent.request('session/new', { cwd, mcpServers: [] });
	}

	authenticate(methodId: string): Promise<acp.AuthenticateResponse> {
		return this.connection.agent.request('authenticate', { methodId });
	}

	prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
		return this.connection.agent.request('session/prompt', { sessionId, prompt });
	}

	cancel(sessionId: string): Promise<void> {
		return this.connection.agent.notify('session/cancel', { sessionId });
	}

	dispose(): void {
		this.connection.close();
	}
}
