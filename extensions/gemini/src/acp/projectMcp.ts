/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The `geminicode-project` MCP server: the tools a project's coordinator uses
// to start and steer threads, and the one a thread uses to report back. The
// same shape as the browser's server (browserMcp.ts): Streamable HTTP with
// plain JSON replies on 127.0.0.1, one URL and HMAC token per caller, so a
// thread's token can't act as the coordinator. Nothing runs until a project
// opens, and every call is answered from memory.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpTool, McpToolResult } from './browserMcp';

/** Who is calling: a project's coordinator, or one of its threads. */
export type ProjectCaller = { readonly role: 'coordinator'; readonly project: string } | { readonly role: 'thread'; readonly project: string; readonly thread: string };

export interface ProjectToolHost {
	call(caller: ProjectCaller, name: string, args: Record<string, unknown>): Promise<McpToolResult>;
	/** Whether a thread works in several repositories, which gives it add_repo. */
	multiRepo?(caller: ProjectCaller): boolean;
}

const text = { type: 'string' } as const;

export const coordinatorTools: readonly McpTool[] = [
	{
		name: 'start_thread',
		description: 'Starts a thread: a new agent on its own branch and worktree that does one piece of work. Returns at once with the thread id, and the thread starts work right away. Write the brief as the whole task: what to do, the files involved, and how to check it.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { ...text, description: 'A few words naming the work, as the user would.' },
				brief: { ...text, description: 'Everything the thread needs, in plain language.' },
				planFirst: { type: 'boolean', description: 'Write a plan and wait for the user\'s OK before changing anything. Only when the user asked for it.' },
				track: { ...text, description: 'A Conductor track id to take the brief from (its spec.md and plan.md).' },
				repos: { type: 'array', items: text, description: 'In a project with several repositories: the ones the thread works in, by name, as <repositories> lists them. Ignored in a project with one.' },
			},
			required: ['title', 'brief'],
		},
	},
	{
		name: 'message_thread',
		description: 'Sends a note to a thread: an idle or done thread starts a turn on it at once, on its own branch, and a working one gets it after its current turn. Use it for anything that extends that thread\'s work, such as something the user added in the project chat.',
		inputSchema: { type: 'object', properties: { thread: { ...text, description: 'The thread id.' }, text, reopen: { type: 'boolean', description: 'Reopen a resolved (merged) thread. Only when the user asked to reopen it.' } }, required: ['thread', 'text'] },
	},
	{
		name: 'list_threads',
		description: 'The project\'s threads with their state and last line. The same list is already in each wake; call this only for a fresh look, or with all: true for the older merged threads the wake leaves out.',
		inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'Also list every older merged thread.' } } },
	},
	{
		name: 'read_thread',
		description: 'The latest messages of one thread, as text.',
		inputSchema: { type: 'object', properties: { thread: text, last: { type: 'number', description: 'How many messages, newest last (default 10).' } }, required: ['thread'] },
	},
	{
		name: 'post',
		description: 'Posts a message in the project chat, where the user reads it. Keep it to a line or two.',
		inputSchema: { type: 'object', properties: { text }, required: ['text'] },
	},
];

export const threadTools: readonly McpTool[] = [
	{
		name: 'add_repo',
		description: 'Adds another of the project\'s repositories to this thread: a worktree of it on this thread\'s branch, as a new folder beside the others in your folder. Use it when the work turns out to need that repository. Returns once the folder is ready.',
		inputSchema: {
			type: 'object',
			properties: { repo: { ...text, description: 'The repository\'s name, as its folder in your folder would be named.' }, reason: { ...text, description: 'Why the work needs it, in a few words; the user sees this.' } },
			required: ['repo', 'reason'],
		},
	},
	{
		name: 'report',
		description: 'Tells the project\'s coordinator about a result, a blocker, or a question only the user can answer. Call it once when your work is done.',
		inputSchema: {
			type: 'object',
			properties: { kind: { type: 'string', enum: ['result', 'blocker', 'question'] }, text: { ...text, description: 'One or two sentences.' } },
			required: ['kind', 'text'],
		},
	},
];

/**
 * Whether a permission request is for one of `tools` from this server. The
 * CLI titles an MCP call by its tool and arguments, without the server's
 * name; only MCP calls offer "Allow all server tools", which together with the
 * tool's name tells the project's tools apart from the user's own servers.
 */
export function isProjectToolCall(request: { readonly toolCall: { readonly title?: string | null }; readonly options: readonly { readonly optionId: string }[] }, tools: readonly McpTool[]): boolean {
	const title = request.toolCall.title ?? '';
	return request.options.some(option => /server/i.test(option.optionId))
		&& tools.some(tool => title === tool.name || title.startsWith(`${tool.name}(`));
}

/** Whether a tool call's title is a call of one of `tools`, as the CLI titles MCP calls. */
export function isProjectToolTitle(title: string, tools: readonly McpTool[]): boolean {
	return tools.some(tool => title === tool.name || title.startsWith(`${tool.name}(`));
}

interface JsonRpcRequest {
	readonly jsonrpc?: string;
	readonly id?: string | number | null;
	readonly method?: string;
	readonly params?: Record<string, unknown>;
}

const maxBodyBytes = 1024 * 1024;
const idPattern = /^[\w-]{1,80}$/;

/** The MCP endpoint: POST `/mcp/<project>/coordinator` or `/mcp/<project>/thread/<id>` with `Authorization: Bearer <token>`. */
export class ProjectMcpServer {

	private readonly secret = randomBytes(32);
	private server: http.Server | undefined;
	private port: number | undefined;
	private starting: Promise<number> | undefined;

	constructor(private readonly host: ProjectToolHost, private readonly version: string) { }

	start(): Promise<number> {
		this.starting ??= new Promise<http.Server>((resolve, reject) => {
			const server = http.createServer((req, res) => void this.handle(req, res));
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => resolve(server));
		}).then(server => {
			this.server = server;
			this.port = (server.address() as AddressInfo).port;
			return this.port;
		}, err => {
			this.starting = undefined;
			throw err;
		});
		return this.starting;
	}

	get listening(): boolean {
		return !!this.port;
	}

	/** The ACP `mcpServers` entry for `caller`; undefined until started. */
	configFor(caller: ProjectCaller): { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] } | undefined {
		const route = routeOf(caller);
		if (!this.port || !route) {
			return undefined;
		}
		return { type: 'http', name: 'geminicode-project', url: `http://127.0.0.1:${this.port}/mcp/${route}`, headers: [{ name: 'Authorization', value: `Bearer ${this.tokenFor(route)}` }] };
	}

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
		const route = /^\/mcp\/(.+)$/.exec(req.url ?? '')?.[1] ?? '';
		const caller = callerOf(route);
		if (!caller) {
			return void res.writeHead(404).end();
		}
		const expected = Buffer.from(`Bearer ${this.tokenFor(route)}`);
		const given = Buffer.from(req.headers.authorization ?? '');
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
			return void res.writeHead(401).end();
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
		const answers = (await Promise.all(messages.map(m => this.answer(caller, m)))).filter(a => a !== undefined);
		if (!answers.length) {
			return void res.writeHead(202).end();
		}
		reply(res, 200, Array.isArray(body) ? answers : answers[0]);
	}

	private async answer(caller: ProjectCaller, message: JsonRpcRequest): Promise<unknown> {
		if (!message || typeof message !== 'object' || message.id === undefined || message.id === null) {
			return undefined;
		}
		const ok = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
		const tools = caller.role === 'coordinator' ? coordinatorTools
			: this.host.multiRepo?.(caller) ? threadTools : threadTools.filter(tool => tool.name !== 'add_repo');
		switch (message.method) {
			case 'initialize':
				return ok({
					protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18',
					capabilities: { tools: {} },
					serverInfo: { name: 'geminicode-project', version: this.version },
					instructions: caller.role === 'coordinator'
						? 'Tools to start and steer the threads of a GeminiCode project.'
						: 'Tools to report back to the coordinator of your GeminiCode project.',
				});
			case 'ping':
				return ok({});
			case 'tools/list':
				return ok({ tools });
			case 'tools/call': {
				const name = typeof message.params?.name === 'string' ? message.params.name : '';
				if (!tools.some(tool => tool.name === name)) {
					return ok({ content: [{ type: 'text', text: `No tool named ${name}.` }], isError: true });
				}
				const args = message.params?.arguments;
				try {
					return ok(await this.host.call(caller, name, typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {}));
				} catch (err) {
					return ok({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
				}
			}
			default:
				return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
		}
	}
}

function routeOf(caller: ProjectCaller): string | undefined {
	if (!idPattern.test(caller.project) || (caller.role === 'thread' && !idPattern.test(caller.thread))) {
		return undefined;
	}
	return caller.role === 'coordinator' ? `${caller.project}/coordinator` : `${caller.project}/thread/${caller.thread}`;
}

function callerOf(route: string): ProjectCaller | undefined {
	const coordinator = /^([\w-]{1,80})\/coordinator$/.exec(route);
	if (coordinator) {
		return { role: 'coordinator', project: coordinator[1] };
	}
	const thread = /^([\w-]{1,80})\/thread\/([\w-]{1,80})$/.exec(route);
	return thread ? { role: 'thread', project: thread[1], thread: thread[2] } : undefined;
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
