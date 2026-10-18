/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A small MCP client over stdio (newline-delimited JSON-RPC), for the servers the team tools
// run as their own children (gemini/docs/adr/0004-one-tool-adapter.md), and a child server that
// starts on its first call, starts again after it exits, and stops when it has been idle.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpContent } from './browserMcp';

/** How to start a server: its command, arguments and the environment it alone gets. */
export interface StdioServerSpec {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
}

/** A tool call's answer, as MCP gives it. */
export interface McpCallResult {
	readonly content: readonly McpContent[];
	readonly isError?: boolean;
}

/** The server could not be started or stopped answering; the caller can fall back. */
export class McpServerUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'McpServerUnavailableError';
	}
}

const protocolVersion = '2025-06-18';

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (err: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** One running server process and its JSON-RPC session. */
export class McpStdioClient {

	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private buffer = '';
	private exited: Error | undefined;
	private stderr = '';

	private constructor(private readonly child: ChildProcessWithoutNullStreams) {
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => this.receive(chunk));
		// Kept short: the last lines say why a server would not start (no Docker, a bad token).
		child.stderr.on('data', (chunk: Buffer) => this.stderr = (this.stderr + chunk.toString()).slice(-2000));
		child.on('error', err => this.fail(new McpServerUnavailableError(err.message)));
		child.on('exit', code => this.fail(new McpServerUnavailableError(`The server exited with code ${code}.${this.stderr.trim() ? ` ${lastLine(this.stderr)}` : ''}`)));
		child.stdin.on('error', () => undefined);
	}

	/** Starts the server and completes MCP's `initialize` handshake. */
	static async start(spec: StdioServerSpec, timeoutMs: number): Promise<McpStdioClient> {
		const child = spawn(spec.command, [...spec.args], { env: spec.env, stdio: 'pipe', windowsHide: true });
		const client = new McpStdioClient(child);
		try {
			await client.request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'geminicode-tools', version: '1' } }, timeoutMs);
			client.notify('notifications/initialized');
			return client;
		} catch (err) {
			client.close();
			throw err instanceof McpServerUnavailableError ? err : new McpServerUnavailableError(err instanceof Error ? err.message : String(err));
		}
	}

	get alive(): boolean {
		return !this.exited;
	}

	async listTools(timeoutMs: number): Promise<string[]> {
		const answer = await this.request('tools/list', {}, timeoutMs) as { tools?: { name?: unknown }[] };
		return (answer.tools ?? []).map(t => t.name).filter((n): n is string => typeof n === 'string');
	}

	async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpCallResult> {
		const answer = await this.request('tools/call', { name, arguments: args }, timeoutMs) as { content?: McpContent[]; isError?: boolean };
		return { content: Array.isArray(answer.content) ? answer.content : [], ...answer.isError ? { isError: true } : {} };
	}

	close(): void {
		this.fail(new McpServerUnavailableError('The server was stopped.'));
		this.child.stdin.end();
		this.child.kill();
	}

	private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		if (this.exited) {
			return Promise.reject(this.exited);
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`The server didn't answer ${method} within ${Math.round(timeoutMs / 1000)} seconds.`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		});
	}

	private notify(method: string): void {
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
	}

	private receive(chunk: string): void {
		this.buffer += chunk;
		let end: number;
		while ((end = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, end).trim();
			this.buffer = this.buffer.slice(end + 1);
			if (!line) {
				continue;
			}
			let message: { id?: unknown; result?: unknown; error?: { message?: string } };
			try {
				message = JSON.parse(line);
			} catch {
				continue; // A server's stray log line on stdout.
			}
			const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
			if (!pending) {
				continue; // A notification or a request from the server; none is needed here.
			}
			this.pending.delete(message.id as number);
			clearTimeout(pending.timer);
			if (message.error) {
				pending.reject(new Error(message.error.message ?? 'The server returned an error.'));
			} else {
				pending.resolve(message.result);
			}
		}
	}

	private fail(err: Error): void {
		this.exited ??= err;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(err);
		}
		this.pending.clear();
	}
}

export interface ChildServerOptions {
	/** How long the start, image pull included, may take. */
	readonly startTimeoutMs?: number;
	/** How long one call may take. */
	readonly callTimeoutMs?: number;
	/** Stops the process after this long without a call; it starts again on the next. */
	readonly idleMs?: number;
}

/**
 * A server the team tools run as their child: nothing runs until the first call, a server that
 * exited starts again on the next call, and an idle one is stopped to give its memory back.
 */
export class ChildServer {

	private client: Promise<McpStdioClient> | undefined;
	private idle: ReturnType<typeof setTimeout> | undefined;
	private readonly startTimeoutMs: number;
	private readonly callTimeoutMs: number;
	private readonly idleMs: number;

	constructor(readonly name: string, private readonly spec: StdioServerSpec, options: ChildServerOptions = {}) {
		this.startTimeoutMs = options.startTimeoutMs ?? 120_000;
		this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
		this.idleMs = options.idleMs ?? 10 * 60_000;
	}

	/**
	 * Calls one of the server's tools. Throws `McpServerUnavailableError` only when the server
	 * could not be started, before the call was sent, so a caller may make the call another way;
	 * a server that stops during the call throws a plain error, since the call may have happened.
	 */
	async call(tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
		clearTimeout(this.idle);
		try {
			const client = await this.running();
			try {
				return await client.callTool(tool, args, this.callTimeoutMs);
			} catch (err) {
				throw err instanceof McpServerUnavailableError ? new Error(`The ${this.name} server stopped during ${tool}: ${err.message} Check whether it went through before trying again.`) : err;
			}
		} finally {
			this.idle = setTimeout(() => this.stop(), this.idleMs);
		}
	}

	stop(): void {
		clearTimeout(this.idle);
		const client = this.client;
		this.client = undefined;
		void client?.then(c => c.close(), () => undefined);
	}

	private running(): Promise<McpStdioClient> {
		const current = this.client;
		if (current) {
			return current.then(c => c.alive ? c : this.restart());
		}
		return this.restart();
	}

	private restart(): Promise<McpStdioClient> {
		const starting = McpStdioClient.start(this.spec, this.startTimeoutMs);
		this.client = starting;
		// A failed start is not kept: the next call tries again.
		starting.catch(() => {
			if (this.client === starting) {
				this.client = undefined;
			}
		});
		return starting;
	}
}

function lastLine(text: string): string {
	return text.trim().split('\n').pop()?.trim() ?? '';
}
