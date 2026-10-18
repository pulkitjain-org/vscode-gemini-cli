/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The MCP servers GeminiCode gives agent sessions (the browser's, the team tools' and a project's):
// Streamable HTTP with plain JSON replies (no event stream, which the protocol allows) on
// 127.0.0.1, answering `initialize`, `ping`, `tools/list` and `tools/call`. Each route, such as an
// agent's id, has its own URL and token (an HMAC of the route), so one session's token reaches
// no other route.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpTool, McpToolResult } from './browserMcp';

/** An `mcpServers` entry for a session: one route's URL and token. */
export type McpHttpConfig = { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] };

export interface JsonRpcRequest {
	readonly jsonrpc?: string;
	readonly id?: string | number | null;
	readonly method?: string;
	readonly params?: Record<string, unknown>;
}

export interface LocalMcpServerOptions<C> {
	/** The server's name in `mcpServers` and `serverInfo`. */
	readonly name: string;
	readonly version: string;
	/** Who a route is for; undefined answers 404. Asked only once the route's token checked out. */
	callerOf(route: string): C | undefined;
	instructions(caller: C): string;
	tools(caller: C): readonly McpTool[];
	/** Runs a tool; a throw becomes an error result the model can read. */
	call(caller: C, name: string, args: Record<string, unknown>): Promise<McpToolResult>;
	/** Sees each authorised request's messages before they are answered. */
	onMessages?(route: string, messages: readonly JsonRpcRequest[]): void;
}

/** The largest request body read; tool calls are small. */
const maxBodyBytes = 1024 * 1024;
/** A route: one to three parts of letters, digits, `-` and `_`, such as `agent-1` or `project/thread/t1`. */
const routePattern = /^[\w-]{1,80}(?:\/[\w-]{1,80}){0,2}$/;

export class LocalMcpServer<C> {

	private readonly secret = randomBytes(32);
	private server: http.Server | undefined;
	private port: number | undefined;
	private starting: Promise<number> | undefined;

	constructor(private readonly options: LocalMcpServerOptions<C>) { }

	/** Starts listening, once (concurrent calls share it); resolves with the port. */
	start(): Promise<number> {
		if (!this.starting) {
			const starting: Promise<number> = listen(http.createServer((req, res) => void this.handle(req, res))).then(server => {
				if (this.starting !== starting) {
					// Disposed while starting.
					server.close();
					throw new Error(`${this.options.name} was stopped.`);
				}
				this.server = server;
				this.port = (server.address() as AddressInfo).port;
				return this.port;
			}, err => {
				if (this.starting === starting) {
					this.starting = undefined;
				}
				throw err;
			});
			this.starting = starting;
		}
		return this.starting;
	}

	/** Whether it is listening, so sessions can be given it. */
	get listening(): boolean {
		return !!this.port;
	}

	/** The `mcpServers` entry for `route`; undefined until started, or for a route it would not serve. */
	configFor(route: string): McpHttpConfig | undefined {
		if (!this.port || !routePattern.test(route)) {
			return undefined;
		}
		return { type: 'http', name: this.options.name, url: `http://127.0.0.1:${this.port}/mcp/${route}`, headers: [{ name: 'Authorization', value: `Bearer ${this.tokenFor(route)}` }] };
	}

	/** Stops listening and drops open connections, so sessions lose the tools at once. */
	dispose(): void {
		this.starting = undefined;
		this.server?.close();
		this.server?.closeAllConnections();
		this.server = undefined;
		this.port = undefined;
	}

	private tokenFor(route: string): string {
		return createHmac('sha256', this.secret).update(route).digest('base64url');
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			await this.serve(req, res);
		} catch (err) {
			// A request the CLI sent must get an answer, or its tool call waits until it times out.
			if (!res.headersSent) {
				reply(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
			} else {
				res.end();
			}
		}
	}

	private async serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const route = /^\/mcp\/(.+)$/.exec(req.url ?? '')?.[1] ?? '';
		if (!routePattern.test(route)) {
			return void res.writeHead(404).end();
		}
		const expected = Buffer.from(`Bearer ${this.tokenFor(route)}`);
		const given = Buffer.from(req.headers.authorization ?? '');
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
			return void res.writeHead(401).end();
		}
		const caller = this.options.callerOf(route);
		if (caller === undefined) {
			return void res.writeHead(404).end();
		}
		if (req.method === 'DELETE') {
			return void res.writeHead(200).end();
		}
		if (req.method !== 'POST') {
			return void res.writeHead(405, { Allow: 'POST, DELETE' }).end();
		}
		let body: unknown;
		try {
			body = JSON.parse(await readBody(req));
		} catch {
			return void reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
		}
		const messages = (Array.isArray(body) ? body : [body]) as JsonRpcRequest[];
		this.options.onMessages?.(route, messages);
		const answers = (await Promise.all(messages.map(m => this.answer(caller, m)))).filter(a => a !== undefined);
		if (!answers.length) {
			return void res.writeHead(202).end();
		}
		reply(res, 200, Array.isArray(body) ? answers : answers[0]);
	}

	/** The reply to one message; undefined for a notification. */
	private async answer(caller: C, message: JsonRpcRequest): Promise<unknown> {
		if (!message || typeof message !== 'object' || message.id === undefined || message.id === null) {
			return undefined;
		}
		const ok = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
		switch (message.method) {
			case 'initialize':
				return ok({
					protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18',
					capabilities: { tools: {} },
					serverInfo: { name: this.options.name, version: this.options.version },
					instructions: this.options.instructions(caller),
				});
			case 'ping':
				return ok({});
			case 'tools/list':
				return ok({ tools: this.options.tools(caller) });
			case 'tools/call': {
				const name = typeof message.params?.name === 'string' ? message.params.name : '';
				const args = message.params?.arguments;
				try {
					return ok(await this.options.call(caller, name, typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {}));
				} catch (err) {
					return ok({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
				}
			}
			default:
				return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
		}
	}
}

function listen(server: http.Server): Promise<http.Server> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBodyBytes) {
				reject(new Error('Too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

export interface AgentMcpServerOptions {
	readonly name: string;
	readonly version: string;
	readonly instructions: string;
	tools(): readonly McpTool[];
	call(agent: string, name: string, args: Record<string, unknown>): Promise<McpToolResult>;
	/** The answer to a call from a spare session no agent has taken yet. */
	readonly notReady: string;
}

/** Slots kept for spare sessions no agent took: a spare that was replaced is never bound, so older ones go. */
const maxUnboundSlots = 8;

/**
 * A local MCP server with one route per agent (its id), and slots for spare
 * sessions opened before any agent takes them (`/mcp/slot-…`), which `bind`
 * later points at the agent that took the session.
 */
export class AgentMcpServer {

	private readonly server: LocalMcpServer<{ readonly agent: string | undefined }>;
	/** Spare sessions' slots, to the agent each is bound to; an unbound slot lists the tools but runs none. */
	private readonly slots = new Map<string, string | undefined>();

	constructor(options: AgentMcpServerOptions) {
		this.server = new LocalMcpServer({
			name: options.name,
			version: options.version,
			// A slot it no longer keeps is refused; one not bound yet lists the tools but runs none.
			callerOf: route => route.includes('/') || (isSlot(route) && !this.slots.has(route)) ? undefined : { agent: isSlot(route) ? this.slots.get(route) : route },
			instructions: () => options.instructions,
			tools: () => options.tools(),
			call: async ({ agent }, name, args) => agent ? options.call(agent, name, args) : { content: [{ type: 'text', text: options.notReady }], isError: true },
		});
	}

	/** Starts listening, once (concurrent calls share it); resolves with the port. */
	start(): Promise<number> {
		return this.server.start();
	}

	/** Whether it is listening, so sessions can be given it. */
	get listening(): boolean {
		return this.server.listening;
	}

	/** The `mcpServers` entry for an agent; undefined until started. */
	configFor(agent: string): McpHttpConfig | undefined {
		return isSlot(agent) ? undefined : this.server.configFor(agent);
	}

	/** The `mcpServers` entry for a session not yet any agent's, such as a spare one, until `bind` gives it to an agent. */
	configForSlot(): McpHttpConfig | undefined {
		if (!this.server.listening) {
			return undefined;
		}
		const unbound = [...this.slots].filter(([, agent]) => agent === undefined).map(([slot]) => slot);
		for (const slot of unbound.slice(0, Math.max(0, unbound.length - maxUnboundSlots + 1))) {
			this.slots.delete(slot);
		}
		const slot = `slot-${randomBytes(12).toString('hex')}`;
		this.slots.set(slot, undefined);
		return this.server.configFor(slot);
	}

	/** Gives a session opened with `configForSlot` (its server's `url`) to `agent`. Returns whether the url was a slot. */
	bind(url: string, agent: string): boolean {
		const slot = /\/mcp\/([\w-]+)$/.exec(url)?.[1];
		if (!slot || !isSlot(slot) || !this.slots.has(slot)) {
			return false;
		}
		this.slots.set(slot, agent);
		return true;
	}

	/** Forgets the slots bound to `agent`, for an agent that was removed. */
	unbind(agent: string): void {
		for (const [slot, bound] of this.slots) {
			if (bound === agent) {
				this.slots.delete(slot);
			}
		}
	}

	/** Stops listening and drops open connections, so agents lose the tools at once. */
	dispose(): void {
		this.server.dispose();
	}
}

function isSlot(route: string): boolean {
	return route.startsWith('slot-');
}
