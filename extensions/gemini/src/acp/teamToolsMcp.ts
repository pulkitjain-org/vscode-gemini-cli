/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The `geminicode-tools` MCP server: the team's tools (teamTools.ts) for every
// agent session. The same shape as the browser's server (browserMcp.ts):
// Streamable HTTP with plain JSON replies on 127.0.0.1, one URL and HMAC token
// per agent, and slots for spare sessions that no agent has taken yet. The
// calls to Jira, GitLab and SonarQube run here, on the user's machine, with
// tokens the agent never sees.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { callTeamTool, TeamToolContext, teamToolsFor, teamToolsServerName } from './teamTools';

const maxBodyBytes = 1024 * 1024;

interface JsonRpcRequest {
	readonly jsonrpc?: string;
	readonly id?: string | number | null;
	readonly method?: string;
	readonly params?: Record<string, unknown>;
}

export type McpHttpConfig = { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] };

export class TeamToolsMcpServer {

	private readonly secret = randomBytes(32);
	private server: http.Server | undefined;
	private port: number | undefined;
	private starting: Promise<number> | undefined;
	private readonly slots = new Map<string, string | undefined>();

	constructor(private readonly context: TeamToolContext, private readonly version: string) { }

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

	configFor(agent: string): McpHttpConfig | undefined {
		if (!this.port || !/^[\w-]{1,80}$/.test(agent)) {
			return undefined;
		}
		return { type: 'http', name: teamToolsServerName, url: `http://127.0.0.1:${this.port}/mcp/${agent}`, headers: [{ name: 'Authorization', value: `Bearer ${this.tokenFor(agent)}` }] };
	}

	/** An entry for a spare session, bound to the agent that takes it with `bind`. */
	configForSlot(): McpHttpConfig | undefined {
		if (!this.port) {
			return undefined;
		}
		const slot = `slot-${randomBytes(12).toString('hex')}`;
		this.slots.set(slot, undefined);
		return this.configFor(slot);
	}

	bind(url: string, agent: string): boolean {
		const slot = /\/mcp\/(slot-[\w-]+)$/.exec(url)?.[1];
		if (!slot || !this.slots.has(slot)) {
			return false;
		}
		this.slots.set(slot, agent);
		return true;
	}

	dispose(): void {
		this.starting = undefined;
		this.server?.close();
		this.server?.closeAllConnections();
		this.server = undefined;
		this.port = undefined;
	}

	private tokenFor(agent: string): string {
		return createHmac('sha256', this.secret).update(agent).digest('base64url');
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const id = /^\/mcp\/([\w-]{1,80})$/.exec(req.url ?? '')?.[1];
		if (!id) {
			return void res.writeHead(404).end();
		}
		const expected = Buffer.from(`Bearer ${this.tokenFor(id)}`);
		const given = Buffer.from(req.headers.authorization ?? '');
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
			return void res.writeHead(401).end();
		}
		const agent = id.startsWith('slot-') ? this.slots.get(id) : id;
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
		const answers = (await Promise.all(messages.map(m => this.answer(agent, m)))).filter(a => a !== undefined);
		if (!answers.length) {
			return void res.writeHead(202).end();
		}
		reply(res, 200, Array.isArray(body) ? answers : answers[0]);
	}

	private async answer(agent: string | undefined, message: JsonRpcRequest): Promise<unknown> {
		if (!message || typeof message !== 'object' || message.id === undefined || message.id === null) {
			return undefined;
		}
		const ok = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
		switch (message.method) {
			case 'initialize':
				return ok({
					protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18',
					capabilities: { tools: {} },
					serverInfo: { name: teamToolsServerName, version: this.version },
					instructions: 'The team\'s tools, with the user\'s own accounts: Jira tickets, GitLab merge requests and CI logs, SonarQube and Snyk checks, Figma designs. Use them instead of web_fetch for these sites, which are behind the user\'s VPN and sign-in. Read freely; comments, status changes and merge requests are shown to the user to approve.',
				});
			case 'ping':
				return ok({});
			case 'tools/list':
				return ok({ tools: teamToolsFor(this.context.connected()) });
			case 'tools/call': {
				if (!agent) {
					return ok({ content: [{ type: 'text', text: 'The team tools are not ready for this session yet.' }], isError: true });
				}
				const name = typeof message.params?.name === 'string' ? message.params.name : '';
				const args = message.params?.arguments;
				return ok(await callTeamTool(this.context, agent, name, typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {}));
			}
			default:
				return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
		}
	}
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
