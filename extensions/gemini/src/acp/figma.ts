/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Figma through the Figma desktop app's Dev Mode MCP server on this Mac
// (127.0.0.1:3845), so it uses the user's signed-in Figma and their Dev seat
// and needs no token. GeminiCode is a small MCP client of it: it asks for a
// frame's design context (code hints, variables) and screenshot by link.

import { Fetch } from './teamHttp';

export const figmaDesktopUrl = 'http://127.0.0.1:3845/mcp';

export interface FigmaStatus {
	readonly running: boolean;
	readonly problem?: string;
	readonly version?: string;
}

/** The file key and node id of a Figma link such as `https://www.figma.com/design/KEY/Name?node-id=12-34`. */
export function parseFigmaLink(link: string): { readonly fileKey: string; readonly nodeId?: string } | undefined {
	let url: URL;
	try {
		url = new URL(link.trim());
	} catch {
		return undefined;
	}
	if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
		return undefined;
	}
	const key = /^\/(?:design|file|proto|board)\/([\w-]+)/.exec(url.pathname)?.[1];
	if (!key) {
		return undefined;
	}
	const node = url.searchParams.get('node-id');
	return { fileKey: key, ...node ? { nodeId: node.replace(/-/g, ':') } : {} };
}

type FigmaContent = { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

export class FigmaDesktop {

	private session: string | undefined;
	private initialized: Promise<{ tools: readonly string[]; version?: string }> | undefined;
	private nextId = 1;

	constructor(private readonly url = figmaDesktopUrl, private readonly fetcher: Fetch = fetch) { }

	async status(): Promise<FigmaStatus> {
		try {
			const init = await this.init(2500);
			return { running: true, ...init.version ? { version: init.version } : {} };
		} catch {
			this.reset();
			return { running: false, problem: 'Figma isn\'t open, or its Dev Mode MCP server is off. Open the Figma desktop app and turn it on in Preferences.' };
		}
	}

	/** Code hints and variables for the frame at `link`, as text. */
	async designContext(link: string, frameworks = 'React', languages = 'TypeScript,CSS'): Promise<FigmaContent[]> {
		const { tools } = await this.init();
		const nodeId = parseFigmaLink(link)?.nodeId;
		const name = tools.includes('get_design_context') ? 'get_design_context' : 'get_code';
		const content = await this.call(name, { ...nodeId ? { nodeId } : {}, clientFrameworks: frameworks, clientLanguages: languages });
		if (tools.includes('get_variable_defs')) {
			const variables = await this.call('get_variable_defs', { ...nodeId ? { nodeId } : {}, clientFrameworks: frameworks, clientLanguages: languages }).catch(() => []);
			return [...content, ...variables];
		}
		return content;
	}

	async screenshot(link: string): Promise<FigmaContent[]> {
		const nodeId = parseFigmaLink(link)?.nodeId;
		await this.init();
		return this.call('get_screenshot', { ...nodeId ? { nodeId } : {} });
	}

	private reset(): void {
		this.session = undefined;
		this.initialized = undefined;
	}

	private init(timeoutMs = 5000): Promise<{ tools: readonly string[]; version?: string }> {
		this.initialized ??= (async () => {
			const result = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'GeminiCode', version: '1' } }, timeoutMs) as { serverInfo?: { version?: string } };
			await this.rpc('notifications/initialized', undefined, timeoutMs, true);
			const list = await this.rpc('tools/list', {}, timeoutMs) as { tools?: { name: string }[] };
			return { tools: (list.tools ?? []).map(t => t.name), version: result.serverInfo?.version };
		})().catch(err => {
			this.reset();
			throw err;
		});
		return this.initialized;
	}

	private async call(name: string, args: Record<string, unknown>): Promise<FigmaContent[]> {
		try {
			const result = await this.rpc('tools/call', { name, arguments: args }, 60_000) as { content?: FigmaContent[]; isError?: boolean };
			const content = (result.content ?? []).filter(c => c.type === 'text' || c.type === 'image');
			if (result.isError) {
				throw new Error(content.map(c => c.type === 'text' ? c.text : '').join(' ') || `Figma's ${name} failed.`);
			}
			return content;
		} catch (err) {
			// The desktop app restarted: its old session is gone.
			if (/404|session/i.test(String(err))) {
				this.reset();
			}
			throw err;
		}
	}

	private async rpc(method: string, params: unknown, timeoutMs: number, notification = false): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await this.fetcher(this.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...this.session ? { 'Mcp-Session-Id': this.session } : {} },
				body: JSON.stringify({ jsonrpc: '2.0', method, ...notification ? {} : { id: this.nextId++ }, ...params === undefined ? {} : { params } }),
				signal: controller.signal,
			});
			this.session = response.headers.get('mcp-session-id') ?? this.session;
			if (!response.ok) {
				throw new Error(`Figma answered ${response.status}.`);
			}
			if (notification) {
				return undefined;
			}
			const text = await response.text();
			const message = (response.headers.get('content-type') ?? '').includes('text/event-stream') ? lastEvent(text) : JSON.parse(text);
			if (message?.error) {
				throw new Error(String(message.error.message ?? 'Figma refused the request.'));
			}
			return message?.result;
		} finally {
			clearTimeout(timer);
		}
	}
}

/** The last JSON-RPC message in an event stream's text. */
export function lastEvent(text: string): { result?: unknown; error?: { message?: string } } | undefined {
	let last: { result?: unknown; error?: { message?: string } } | undefined;
	for (const block of text.split(/\r?\n\r?\n/)) {
		const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
		if (data) {
			try {
				const parsed = JSON.parse(data);
				if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) {
					last = parsed;
				}
			} catch {
				// Not JSON: a keep-alive.
			}
		}
	}
	return last;
}
