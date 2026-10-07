/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The browser for Gemini agents: an MCP server GeminiCode hands to each agent
// session (ACP `mcpServers`), whose tools drive a page in the Integrated
// Browser. It listens on 127.0.0.1 only, wants a secret token, and serves each
// agent at its own path, so an agent only ever reaches its own page. The page
// itself is driven by a `BrowserBackend` (the workbench's `_gemini.browser.*`
// commands in the app). Pages on this machine open freely; files follow the
// agent's file access policy; other sites ask first. Where the page ends up
// (after a redirect, a click, or on its own) is checked again each time.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { checkFileAccess, FileAccessPolicyOptions } from './fileAccess';

export interface PageState {
	/** The page's accessibility snapshot, with refs such as e12 for elements. */
	readonly summary: string;
	readonly error?: string;
	/** Where the page is after the action. */
	readonly url?: string;
}

/** What drives an agent's pages. Each answer says where the page is now. */
export interface BrowserBackend {
	/** Opens a new page; when it throws, the page may still have opened (see `pages`). */
	open(agent: string, url: string): Promise<{ readonly pageId: string; readonly summary: string; readonly url: string }>;
	/** The agent's pages that are still open, oldest first. */
	pages(agent: string): Promise<readonly string[]>;
	snapshot(agent: string, pageId: string): Promise<{ readonly summary: string; readonly url: string }>;
	act(agent: string, pageId: string, action: BrowserAction, args: readonly unknown[]): Promise<PageState>;
	/** `data` is a JPEG, base64. */
	screenshot(agent: string, pageId: string): Promise<{ readonly data: string; readonly url: string }>;
}

export type BrowserAction = 'goto' | 'back' | 'reload' | 'click' | 'hover' | 'type' | 'select' | 'press' | 'scroll' | 'wait';

/** Decides which pages an agent may see. */
export interface BrowserGate {
	/** For a site that is not local: asks the user, or follows policy. */
	allow(agent: string, url: URL): Promise<boolean>;
	/** The file access policy for the agent's `file:` pages, as for its file reads. */
	files(agent: string): FileAccessPolicyOptions;
	/** Whether the browser is on; when it is off every tool call fails. */
	enabled?(): boolean;
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

/** Sites the agent may open without asking: this machine. */
export function isLocalUrl(url: URL): boolean {
	if (!/^https?:$/.test(url.protocol)) {
		return false;
	}
	const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
	return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** A URL as messages show it: a site by its origin, a file in full. */
function where(url: URL): string {
	return url.protocol === 'file:' ? url.href : url.origin;
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
		if (this.gate.enabled && !this.gate.enabled()) {
			return failure('The GeminiCode browser is turned off.');
		}
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
			const refused = await this.refusal(agent, url);
			if (refused) {
				return failure(`Did not open ${where(url)}: ${refused}.${/^https?:$/.test(url.protocol) ? ' Ask the user before trying another site.' : ''}`);
			}
			const page = await this.livePage(agent);
			if (!page) {
				const opened = await this.open(agent, url);
				return await this.leftFor(agent, opened.pageId, opened.url) ?? pageText(opened);
			}
			return this.act(agent, page, 'goto', [url.href]);
		}
		const page = await this.livePage(agent);
		if (!page) {
			return failure('You have no page open. Use browser_navigate first.');
		}
		switch (name) {
			case 'browser_snapshot': {
				const state = await this.backend.snapshot(agent, page);
				return await this.leftFor(agent, page, state.url) ?? pageText(state);
			}
			case 'browser_screenshot': {
				const shot = await this.backend.screenshot(agent, page);
				return await this.leftFor(agent, page, shot.url) ?? { content: [{ type: 'image', data: shot.data, mimeType: 'image/jpeg' }, { type: 'text', text: `URL: ${shot.url}` }] };
			}
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

	/** Opens the agent's page. When that fails part way (a slow page), keeps the page that opened, so the next navigate reuses it. */
	private async open(agent: string, url: URL): Promise<{ readonly pageId: string; readonly summary: string; readonly url: string }> {
		try {
			const opened = await this.backend.open(agent, url.href);
			this.pageOf.set(agent, opened.pageId);
			return opened;
		} catch (err) {
			const newest = (await this.backend.pages(agent).catch(() => [])).at(-1);
			if (newest) {
				this.pageOf.set(agent, newest);
			}
			throw err;
		}
	}

	/** Runs an action, then checks where the page went. */
	private async act(agent: string, page: string, action: BrowserAction, args: readonly unknown[]): Promise<McpToolResult> {
		const state = await this.backend.act(agent, page, action, args);
		return await this.leftFor(agent, page, state.url) ?? pageText(state);
	}

	/**
	 * When the page is at `current` (after a redirect, an action, or on its
	 * own) and the agent may not see it there: sends the page back and answers
	 * with why. Undefined when the page may stay.
	 */
	private async leftFor(agent: string, page: string, current: string | undefined): Promise<McpToolResult | undefined> {
		const url = current ? URL.parse(current) : null;
		const refused = url ? await this.refusal(agent, url) : undefined;
		if (!url || !refused) {
			return undefined;
		}
		await this.backend.act(agent, page, 'back', []).catch(() => undefined);
		return failure(`The page went to ${where(url)}, but ${refused}, so it went back.`);
	}

	/** Why the agent may not see `url`, or undefined when it may. */
	private async refusal(agent: string, url: URL): Promise<string | undefined> {
		if (url.protocol === 'file:') {
			let filePath: string;
			try {
				filePath = fileURLToPath(url);
			} catch {
				return 'that is not a local file';
			}
			return checkFileAccess(filePath, 'read', this.gate.files(agent));
		}
		if (!/^https?:$/.test(url.protocol) || isLocalUrl(url) || await this.gate.allow(agent, url)) {
			// Other schemes (about:blank, an error page) show nothing from elsewhere; navigate opens only http, https and file.
			return undefined;
		}
		return 'the user did not allow that site';
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
 * `tools/call`. POST to `/mcp/<agent>` with `Authorization: Bearer <token>`,
 * where the token is the agent's own (an HMAC of its id), so one agent's
 * token does not reach another agent's page.
 */
export class BrowserMcpServer {

	private readonly secret = randomBytes(32);
	private server: http.Server | undefined;
	private port: number | undefined;
	private starting: Promise<number> | undefined;

	constructor(private readonly tools: BrowserToolHost, private readonly version: string) { }

	/** Starts listening, once (concurrent calls share it); resolves with the port. */
	start(): Promise<number> {
		if (!this.starting) {
			const starting: Promise<number> = listen(http.createServer((req, res) => void this.handle(req, res))).then(server => {
				if (this.starting !== starting) {
					// Disposed while starting.
					server.close();
					throw new Error('The browser tools were stopped.');
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

	/** The ACP `mcpServers` entry for an agent; undefined until started. */
	configFor(agent: string): { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] } | undefined {
		if (!this.port || !/^[\w-]{1,80}$/.test(agent)) {
			return undefined;
		}
		return { type: 'http', name: 'geminicode-browser', url: `http://127.0.0.1:${this.port}/mcp/${agent}`, headers: [{ name: 'Authorization', value: `Bearer ${this.tokenFor(agent)}` }] };
	}

	/** Stops listening and drops open connections, so agents lose the tools at once. */
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
		const agent = /^\/mcp\/([\w-]{1,80})$/.exec(req.url ?? '')?.[1];
		if (!agent) {
			return void res.writeHead(404).end();
		}
		if (!this.authorized(agent, req.headers.authorization)) {
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

	private authorized(agent: string, header: string | undefined): boolean {
		const expected = Buffer.from(`Bearer ${this.tokenFor(agent)}`);
		const given = Buffer.from(header ?? '');
		return given.length === expected.length && timingSafeEqual(given, expected);
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
