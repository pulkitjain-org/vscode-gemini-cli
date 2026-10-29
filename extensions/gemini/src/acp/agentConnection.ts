/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
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

/** How long each setup request may take before it fails, in milliseconds. */
export interface SetupTimeouts {
	readonly initialize: number;
	readonly newSession: number;
	readonly loadSession: number;
	readonly authenticate: number;
	/** `session/set_mode`, `session/set_model` and `session/close`: settings of an open session, which the CLI answers at once. */
	readonly sessionCall: number;
}

/**
 * Generous on purpose: they catch a CLI that hangs, not a slow one.
 * `initialize` loads the CLI's config and fetches its experiments (about
 * 3 s, FINDINGS.md); `session/new` and `session/load` sign in again and can
 * start a chat. `authenticate` runs the CLI's browser sign-in, which the CLI
 * itself gives up on after 5 minutes.
 */
export const defaultSetupTimeouts: SetupTimeouts = {
	initialize: 120_000,
	newSession: 120_000,
	loadSession: 120_000,
	authenticate: 330_000,
	sessionCall: 15_000,
};

/**
 * The largest message the agent may send. The SDK's default of 32 MB ends
 * the connection on a tool call whose diff carries a large file's old and
 * new text; past this the connection still ends, and the runtime restarts
 * the agent.
 */
const maxMessageBytes = 128 * 1024 * 1024;

/**
 * A JSON-RPC connection to an ACP agent over a pair of byte streams
 * (normally the sidecar's stdin and stdout).
 */
export class AgentConnection {

	private readonly connection: acp.ClientConnection;
	private readonly fs: acp.FileSystemCapabilities;

	constructor(toAgent: Writable, fromAgent: Readable, handlers: AgentClientHandlers, private readonly timeouts: SetupTimeouts = defaultSetupTimeouts) {
		const stream = acp.ndJsonStream(
			Writable.toWeb(toAgent) as WritableStream<Uint8Array>,
			Readable.toWeb(fromAgent) as ReadableStream<Uint8Array>,
			{ maxMessageBytes },
		);
		let builder = acp.client({ name: CLIENT_INFO.name })
			.onRequest('session/request_permission', ctx => handlers.requestPermission(ctx.params))
			.onNotification('session/update', ctx => handlers.sessionUpdate(ctx.params));
		const { readTextFile, writeTextFile } = handlers;
		if (readTextFile) {
			builder = builder.onRequest('fs/read_text_file', ctx => asRequestError(() => readTextFile.call(handlers, ctx.params)));
		}
		if (writeTextFile) {
			builder = builder.onRequest('fs/write_text_file', ctx => asRequestError(() => writeTextFile.call(handlers, ctx.params)));
		}
		this.fs = { readTextFile: !!readTextFile, writeTextFile: !!writeTextFile };
		this.connection = builder.connect(stream);
	}

	/** Resolves when the connection closes, for any reason. */
	get closed(): Promise<void> {
		return this.connection.closed;
	}

	/** Whether the connection has closed. */
	get isClosed(): boolean {
		return this.connection.signal.aborted;
	}

	/**
	 * Runs `initialize` and checks that the agent speaks our protocol version.
	 * File system capabilities follow the handlers given; terminals are never
	 * advertised (the CLI runs shell commands itself).
	 */
	async initialize(): Promise<acp.InitializeResponse> {
		const response = await withTimeout(this.connection.agent.request('initialize', {
			protocolVersion: SUPPORTED_PROTOCOL_VERSION,
			clientCapabilities: {
				fs: this.fs,
				terminal: false,
			},
			clientInfo: CLIENT_INFO,
		}), 'initialize', this.timeouts.initialize);
		if (response.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
			throw new UnsupportedProtocolVersionError(response.protocolVersion);
		}
		return response;
	}

	newSession(cwd: string, mcpServers: readonly acp.McpServer[] = []): Promise<acp.NewSessionResponse> {
		return withTimeout(this.connection.agent.request('session/new', { cwd, mcpServers: [...mcpServers] }), 'session/new', this.timeouts.newSession);
	}

	/** Reopens a session the agent stored; the agent replays its history as `session/update` notifications. */
	loadSession(sessionId: string, cwd: string, mcpServers: readonly acp.McpServer[] = []): Promise<acp.LoadSessionResponse> {
		return withTimeout(this.connection.agent.request('session/load', { sessionId, cwd, mcpServers: [...mcpServers] }), 'session/load', this.timeouts.loadSession);
	}

	authenticate(methodId: string): Promise<acp.AuthenticateResponse> {
		return withTimeout(this.connection.agent.request('authenticate', { methodId }), 'authenticate', this.timeouts.authenticate);
	}

	prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
		return this.connection.agent.request('session/prompt', { sessionId, prompt });
	}

	setMode(sessionId: string, modeId: string): Promise<acp.SetSessionModeResponse> {
		return withTimeout(this.connection.agent.request('session/set_mode', { sessionId, modeId }), 'session/set_mode', this.timeouts.sessionCall);
	}

	/** The unstable `session/set_model` that gemini-cli implements; not in the SDK's stable method list. */
	setModel(sessionId: string, modelId: string): Promise<unknown> {
		return withTimeout(this.connection.agent.request('session/set_model', { sessionId, modelId }), 'session/set_model', this.timeouts.sessionCall);
	}

	cancel(sessionId: string): Promise<void> {
		return this.connection.agent.notify('session/cancel', { sessionId });
	}

	/** Frees a session the agent keeps in memory; only when it advertises `sessionCapabilities.close`. */
	close(sessionId: string): Promise<unknown> {
		return withTimeout(this.connection.agent.request('session/close', { sessionId }), 'session/close', this.timeouts.sessionCall);
	}

	dispose(): void {
		this.connection.close();
	}
}

/**
 * A request the agent did not answer in time. Not an `AgentError`: this
 * module is bundled apart from the extension (src/connection.ts), where
 * `instanceof` would not hold, so it carries the same `info` and
 * `classifyAgentError` reads that.
 */
export class ConnectionTimeoutError extends Error {
	readonly info: { readonly kind: 'timeout'; readonly message: string };
	constructor(method: string, ms: number) {
		super(`The agent did not answer ${method} within ${Math.round(ms / 1000)} s.`);
		this.name = 'ConnectionTimeoutError';
		this.info = { kind: 'timeout', message: this.message };
	}
}

/**
 * `request`, or a `timeout` error once `ms` pass without an answer. The
 * request is not cancelled: gemini-cli 0.66 implements no `$/cancel_request`,
 * and an answer that comes later is dropped.
 */
function withTimeout<T>(request: Promise<T>, method: string, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new ConnectionTimeoutError(method, ms)), ms);
	});
	return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs a file handler; a refused access (`FileAccessDeniedError`, known by
 * its name and code since the class is the extension bundle's) goes back to
 * the agent as the JSON-RPC error its code names.
 */
async function asRequestError<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (err) {
		const code = (err as { code?: unknown } | undefined)?.code;
		if (err instanceof Error && err.name === 'FileAccessDeniedError' && typeof code === 'number') {
			throw new acp.RequestError(code, err.message);
		}
		throw err;
	}
}
