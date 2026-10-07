/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The browser for Gemini agents: an MCP server GeminiCode hands to each agent
// session (ACP `mcpServers`), whose tools drive a page in the Integrated
// Browser. It listens on 127.0.0.1 only, wants a secret token, and serves each
// agent at its own path, so an agent only ever reaches its own page. The page
// itself is driven by a `BrowserBackend` (the workbench's `_gemini.browser.*`
// commands in the app). Local pages open freely; anything else asks first.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface PageState {
	/** The page's accessibility snapshot, with refs such as e12 for elements. */
	readonly summary: string;
	readonly error?: string;
	/** Where the page is after the action. */
	readonly url?: string;
}

/** What drives an agent's pages. */
export interface BrowserBackend {
	open(agent: string, url: string): Promise<{ readonly pageId: string; readonly summary: string }>;
	/** The agent's pages that are still open. */
	pages(agent: string): Promise<readonly string[]>;
	snapshot(agent: string, pageId: string): Promise<string>;
	act(agent: string, pageId: string, action: BrowserAction, args: readonly unknown[]): Promise<PageState>;
	/** A JPEG, base64. */
	screenshot(agent: string, pageId: string): Promise<string>;
}

export type BrowserAction = 'goto' | 'back' | 'reload' | 'click' | 'hover' | 'type' | 'select' | 'press' | 'scroll' | 'wait';

/** Decides about pages that are not local: asks the user, or follows policy. */
export interface BrowserGate {
	allow(agent: string, url: URL): Promise<boolean>;
}

export interface McpTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

export type McpContent = { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly data: string; readonly mimeType: string };
export interface McpToolResult {
	readonly content: readonly McpContent[];
	readonly isError?: boolean;
}

/** The longest snapshot sent back; a huge page would fill the model's context. */
const maxSummaryChars = 40_000;

const target = {
	ref: { type: 'string', description: 'The element\'s ref from the latest page snapshot, such as e12.' },
	selector: { type: 'string', description: 'A CSS or Playwright selector, when the element has no ref.' },
};

export const browserTools: readonly McpTool[] = [
	{
		name: 'browser_navigate',
		description: 'Open a URL in your page in the GeminiCode browser, which the user can watch. Use it to check a web app you are working on, such as http://localhost:5173. Returns an accessibility snapshot of the page; elements in it have refs (e12) to use with the other browser tools.',
		inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'An absolute http, https or file URL.' } }, required: ['url'] },
	},
	{
		name: 'browser_snapshot',
		description: 'Read your page again: its accessibility snapshot, with element refs.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'browser_click',
		description: 'Click an element on your page. Returns the snapshot afterwards.',
		inputSchema: { type: 'object', properties: { ...target, double: { type: 'boolean', description: 'Double-click.' } } },
	},
	{
		name: 'browser_hover',
		description: 'Move the mouse over an element on your page.',
		inputSchema: { type: 'object', properties: target },
	},
	{
		name: 'browser_type',
		description: 'Replace the text in an input on your page, optionally pressing Enter after.',
		inputSchema: { type: 'object', properties: { ...target, text: { type: 'string' }, submit: { type: 'boolean', description: 'Press Enter after typing.' } }, required: ['text'] },
	},
	{
		name: 'browser_select',
		description: 'Choose options in a select element on your page.',
		inputSchema: { type: 'object', properties: { ...target, values: { type: 'array', items: { type: 'string' } } }, required: ['values'] },
	},
	{
		name: 'browser_press_key',
		description: 'Press a key on your page, such as Enter, Escape, ArrowDown or Control+A.',
		inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
	},
	{
		name: 'browser_scroll',
		description: 'Scroll your page down (positive) or up (negative) by a number of pixels.',
		inputSchema: { type: 'object', properties: { pixels: { type: 'number' } }, required: ['pixels'] },
	},
	{
		name: 'browser_back',
		description: 'Go back to the previous page in your page\'s history.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'browser_wait',
		description: 'Wait up to 10 seconds, for example for an animation or a slow request, then read the page.',
		inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
	},
	{
		name: 'browser_screenshot',
		description: 'See your page: a screenshot of what is visible. Use it to check layout and styling.',
		inputSchema: { type: 'object', properties: {} },
	},
];

/** Pages the agent may open without asking: this machine, and files. */
export function isLocalUrl(url: URL): boolean {
	if (url.protocol === 'file:') {
		return true;
	}
	const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
	return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(host);
}

function failure(value: string): McpToolResult {
	return { content: [{ type: 'text', text: value }], isError: true };
}

function pageText(state: PageState): McpToolResult {
	const summary = state.summary.length > maxSummaryChars ? `${state.summary.slice(0, maxSummaryChars)}\n[Snapshot cut at ${maxSummaryChars} characters.]` : state.summary;
	const lines = [state.url ? `URL: ${state.url}` : '', state.error ? `The action failed: ${state.error}` : '', summary].filter(Boolean);
	return { content: [{ type: 'text', text: lines.join('\n\n') }], ...(state.error ? { isError: true } : {}) };
}

function targetOf(args: Record<string, unknown>): string | undefined {
	if (typeof args.ref === 'string' && /^[\w-]{1,40}$/.test(args.ref)) {
		return `aria-ref=${args.ref}`;
	}
	return typeof args.selector === 'string' && args.selector.trim() ? args.selector : undefined;
}

/** The tools' behaviour, apart from HTTP: one page per agent, created on first use. */
export class BrowserToolHost {

	private readonly pageOf = new Map<string, string>();

	constructor(private readonly backend: BrowserBackend, private readonly gate: BrowserGate) { }

	/** Forgets an agent's page, for an agent that was removed. */
	forget(agent: string): void {
		this.pageOf.delete(agent);
	}

	async call(agent: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
		try {
			return await this.run(agent, name, args);
		} catch (err) {
			return failure(err instanceof Error ? err.message : String(err));
		}
	}

	private async run(agent: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
		if (name === 'browser_navigate') {
			const url = typeof args.url === 'string' ? URL.parse(args.url) : null;
			if (!url || !/^(https?|file):$/.test(url.protocol)) {
				return failure('Give an absolute http, https or file URL.');
			}
			if (!await this.allowed(agent, url)) {
				return failure(`The user did not allow opening ${url.origin}. Ask them before trying another site.`);
			}
			const page = await this.livePage(agent);
			if (!page) {
				const opened = await this.backend.open(agent, url.href);
				this.pageOf.set(agent, opened.pageId);
				return pageText({ summary: opened.summary, url: url.href });
			}
			return this.act(agent, page, 'goto', [url.href]);
		}
		const page = await this.livePage(agent);
		if (!page) {
			return failure('You have no page open. Use browser_navigate first.');
		}
		switch (name) {
			case 'browser_snapshot':
				return pageText({ summary: await this.backend.snapshot(agent, page) });
			case 'browser_screenshot':
				return { content: [{ type: 'image', data: await this.backend.screenshot(agent, page), mimeType: 'image/jpeg' }] };
			case 'browser_back':
				return this.act(agent, page, 'back', []);
			case 'browser_press_key':
				return typeof args.key === 'string' && args.key ? this.act(agent, page, 'press', [args.key]) : failure('Say which key.');
			case 'browser_scroll':
				return typeof args.pixels === 'number' && Number.isFinite(args.pixels) ? this.act(agent, page, 'scroll', [args.pixels]) : failure('Say how many pixels.');
			case 'browser_wait':
				return this.act(agent, page, 'wait', [typeof args.ms === 'number' ? args.ms : 1000]);
		}
		const element = targetOf(args);
		if (!element) {
			return failure('Give the element\'s ref from the latest snapshot, or a selector.');
		}
		switch (name) {
			case 'browser_click':
				return this.act(agent, page, 'click', [element, args.double === true]);
			case 'browser_hover':
				return this.act(agent, page, 'hover', [element]);
			case 'browser_type':
				return typeof args.text === 'string' ? this.act(agent, page, 'type', [element, args.text, args.submit === true]) : failure('Give the text to type.');
			case 'browser_select': {
				const values = Array.isArray(args.values) ? args.values.filter((v): v is string => typeof v === 'string') : [];
				return values.length ? this.act(agent, page, 'select', [element, values]) : failure('Give the options to choose.');
			}
		}
		return failure(`Unknown tool: ${name}`);
	}

	/** Runs an action; when it leads somewhere that is not local and the user does not allow it, goes back. */
	private async act(agent: string, page: string, action: BrowserAction, args: readonly unknown[]): Promise<McpToolResult> {
		const state = await this.backend.act(agent, page, action, args);
		const url = state.url ? URL.parse(state.url) : null;
		if (url && /^https?:$/.test(url.protocol) && !await this.allowed(agent, url)) {
			await this.backend.act(agent, page, 'back', []).catch(() => undefined);
			return failure(`That led to ${url.origin}, which the user did not allow, so the page went back.`);
		}
		return pageText(state);
	}

	private allowed(agent: string, url: URL): Promise<boolean> | boolean {
		return isLocalUrl(url) || url.href === 'about:blank' || this.gate.allow(agent, url);
	}

	private async livePage(agent: string): Promise<string | undefined> {
		const page = this.pageOf.get(agent);
		if (page && (await this.backend.pages(agent)).includes(page)) {
			return page;
		}
		// The user closed it; the next navigate opens another.
		this.pageOf.delete(agent);
		return undefined;
	}
}

/** The largest request body read; tool calls are small. */
const maxBodyBytes = 1024 * 1024;

interface JsonRpcRequest {
	readonly jsonrpc?: string;
	readonly id?: string | number | null;
	readonly method?: string;
	readonly params?: Record<string, unknown>;
}

/**
 * The MCP endpoint, over Streamable HTTP with plain JSON replies (no event
 * stream, which the protocol allows): `initialize`, `ping`, `tools/list` and
 * `tools/call`. POST to `/mcp/<agent>` with `Authorization: Bearer <token>`.
 */
export class BrowserMcpServer {

	private readonly token = randomBytes(24).toString('base64url');
	private server: http.Server | undefined;
	private port: number | undefined;

	constructor(private readonly tools: BrowserToolHost, private readonly version: string) { }

	/** Starts listening, once; resolves with the port. */
	async start(): Promise<number> {
		if (this.port) {
			return this.port;
		}
		const server = http.createServer((req, res) => void this.handle(req, res));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => resolve());
		});
		this.server = server;
		this.port = (server.address() as AddressInfo).port;
		return this.port;
	}

	/** The ACP `mcpServers` entry for an agent; undefined until started. */
	configFor(agent: string): { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] } | undefined {
		if (!this.port || !/^[\w-]{1,80}$/.test(agent)) {
			return undefined;
		}
		return { type: 'http', name: 'geminicode-browser', url: `http://127.0.0.1:${this.port}/mcp/${agent}`, headers: [{ name: 'Authorization', value: `Bearer ${this.token}` }] };
	}

	dispose(): void {
		this.server?.close();
		this.server = undefined;
		this.port = undefined;
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const agent = /^\/mcp\/([\w-]{1,80})$/.exec(req.url ?? '')?.[1];
		if (!agent) {
			return void res.writeHead(404).end();
		}
		if (!this.authorized(req.headers.authorization)) {
			return void res.writeHead(401).end();
		}
		if (req.method === 'DELETE') {
			return void res.writeHead(200).end();
		}
		if (req.method !== 'POST') {
			// No server-to-client stream: everything is a reply to a request.
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

	/** The reply to one message; undefined for a notification. */
	private async answer(agent: string, message: JsonRpcRequest): Promise<unknown> {
		if (!message || typeof message !== 'object' || message.id === undefined || message.id === null) {
			return undefined;
		}
		const ok = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
		switch (message.method) {
			case 'initialize':
				return ok({
					protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18',
					capabilities: { tools: {} },
					serverInfo: { name: 'geminicode-browser', version: this.version },
					instructions: 'Tools for a web page in the GeminiCode browser, which the user can see. Use them to check web apps you build, especially on localhost.',
				});
			case 'ping':
				return ok({});
			case 'tools/list':
				return ok({ tools: browserTools });
			case 'tools/call': {
				const name = typeof message.params?.name === 'string' ? message.params.name : '';
				const args = message.params?.arguments;
				return ok(await this.tools.call(agent, name, typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {}));
			}
			default:
				return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
		}
	}

	private authorized(header: string | undefined): boolean {
		const expected = Buffer.from(`Bearer ${this.token}`);
		const given = Buffer.from(header ?? '');
		return given.length === expected.length && timingSafeEqual(given, expected);
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
