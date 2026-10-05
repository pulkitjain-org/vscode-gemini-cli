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
	/** When set, the client advertises `fs.readTextFile` and the agent reads workspace files through it. */
	readTextFile?(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
	/** When set, the client advertises `fs.writeTextFile` and the agent writes workspace files through it. */
	writeTextFile?(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>;
}

/**
 * A JSON-RPC connection to an ACP agent over a pair of byte streams
 * (normally the sidecar's stdin and stdout).
 */
export class AgentConnection {

	private readonly connection: acp.ClientConnection;
	private readonly fs: acp.FileSystemCapabilities;

	constructor(toAgent: Writable, fromAgent: Readable, handlers: AgentClientHandlers) {
		const stream = acp.ndJsonStream(
			Writable.toWeb(toAgent) as WritableStream<Uint8Array>,
			Readable.toWeb(fromAgent) as ReadableStream<Uint8Array>,
		);
		let builder = acp.client({ name: CLIENT_INFO.name })
			.onRequest('session/request_permission', ctx => handlers.requestPermission(ctx.params))
			.onNotification('session/update', ctx => handlers.sessionUpdate(ctx.params));
		const { readTextFile, writeTextFile } = handlers;
		if (readTextFile) {
			builder = builder.onRequest('fs/read_text_file', ctx => readTextFile.call(handlers, ctx.params));
		}
		if (writeTextFile) {
			builder = builder.onRequest('fs/write_text_file', ctx => writeTextFile.call(handlers, ctx.params));
		}
		this.fs = { readTextFile: !!readTextFile, writeTextFile: !!writeTextFile };
		this.connection = builder.connect(stream);
	}

	/** Resolves when the connection closes, for any reason. */
	get closed(): Promise<void> {
		return this.connection.closed;
	}

	/**
	 * Runs `initialize` and checks that the agent speaks our protocol version.
	 * File system capabilities follow the handlers given; terminals are never
	 * advertised (the CLI runs shell commands itself).
	 */
	async initialize(): Promise<acp.InitializeResponse> {
		const response = await this.connection.agent.request('initialize', {
			protocolVersion: SUPPORTED_PROTOCOL_VERSION,
			clientCapabilities: {
				fs: this.fs,
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

	/** Reopens a session the agent stored; the agent replays its history as `session/update` notifications. */
	loadSession(sessionId: string, cwd: string): Promise<acp.LoadSessionResponse> {
		return this.connection.agent.request('session/load', { sessionId, cwd, mcpServers: [] });
	}

	authenticate(methodId: string): Promise<acp.AuthenticateResponse> {
		return this.connection.agent.request('authenticate', { methodId });
	}

	prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
		return this.connection.agent.request('session/prompt', { sessionId, prompt });
	}

	setMode(sessionId: string, modeId: string): Promise<acp.SetSessionModeResponse> {
		return this.connection.agent.request('session/set_mode', { sessionId, modeId });
	}

	/** The unstable `session/set_model` that gemini-cli implements; not in the SDK's stable method list. */
	setModel(sessionId: string, modelId: string): Promise<unknown> {
		return this.connection.agent.request('session/set_model', { sessionId, modelId });
	}

	cancel(sessionId: string): Promise<void> {
		return this.connection.agent.notify('session/cancel', { sessionId });
	}

	/** Frees a session the agent keeps in memory; only when it advertises `sessionCapabilities.close`. */
	close(sessionId: string): Promise<unknown> {
		return this.connection.agent.request('session/close', { sessionId });
	}

	dispose(): void {
		this.connection.close();
	}
}
