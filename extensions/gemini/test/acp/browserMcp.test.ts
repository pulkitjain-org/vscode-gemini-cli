/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { BrowserAction, BrowserBackend, BrowserMcpServer, BrowserToolHost, isLocalUrl, PageState } from '../../src/acp/browserMcp';

class FakeBrowser implements BrowserBackend {
	readonly calls: string[] = [];
	readonly open_ = new Map<string, string[]>();
	/** Where an action leads, by action name. */
	readonly leadsTo = new Map<string, string>();
	private next = 1;

	async open(agent: string, url: string) {
		const pageId = `p${this.next++}`;
		this.open_.set(agent, [...this.open_.get(agent) ?? [], pageId]);
		this.calls.push(`open ${agent} ${url}`);
		return { pageId, summary: `snapshot of ${url}` };
	}
	async pages(agent: string) {
		return this.open_.get(agent) ?? [];
	}
	async snapshot(_agent: string, pageId: string) {
		return `snapshot ${pageId}`;
	}
	async act(agent: string, pageId: string, action: BrowserAction, args: readonly unknown[]): Promise<PageState> {
		this.calls.push(`${action} ${agent} ${pageId} ${JSON.stringify(args)}`);
		return { summary: `after ${action}`, url: this.leadsTo.get(action) ?? (action === 'goto' ? String(args[0]) : 'http://localhost:5173/') };
	}
	async screenshot() {
		return 'aGk=';
	}
}

function setup(answer = false) {
	const browser = new FakeBrowser();
	const asked: string[] = [];
	const host = new BrowserToolHost(browser, { allow: async (_agent, url) => (asked.push(url.origin), answer) });
	return { browser, asked, host };
}

describe('BrowserToolHost', () => {
	it('opens one page per agent and reuses it', async () => {
		const { browser, host, asked } = setup();
		const first = await host.call('a1', 'browser_navigate', { url: 'http://localhost:5173' });
		expect(first.isError).toBeUndefined();
		expect(first.content[0]).toEqual({ type: 'text', text: 'URL: http://localhost:5173/\n\nsnapshot of http://localhost:5173/' });
		await host.call('a1', 'browser_navigate', { url: 'http://127.0.0.1:3000/cart' });
		await host.call('a2', 'browser_navigate', { url: 'file:///tmp/index.html' });
		await host.call('a1', 'browser_click', { ref: 'e12', double: true });
		await host.call('a1', 'browser_type', { selector: '#q', text: 'shoes', submit: true });
		expect(browser.calls).toEqual([
			'open a1 http://localhost:5173/',
			'goto a1 p1 ["http://127.0.0.1:3000/cart"]',
			'open a2 file:///tmp/index.html',
			'click a1 p1 ["aria-ref=e12",true]',
			'type a1 p1 ["#q","shoes",true]',
		]);
		expect(asked).toEqual([]);
	});

	it('asks before other sites, and goes back when an action leads to one not allowed', async () => {
		const { browser, host, asked } = setup(false);
		const denied = await host.call('a1', 'browser_navigate', { url: 'https://example.com/' });
		expect(denied.isError).toBe(true);
		expect(asked).toEqual(['https://example.com']);
		expect(browser.calls).toEqual([]);

		await host.call('a1', 'browser_navigate', { url: 'http://localhost:5173' });
		browser.leadsTo.set('click', 'https://evil.example/');
		const result = await host.call('a1', 'browser_click', { ref: 'e3' });
		expect(result.isError).toBe(true);
		expect(browser.calls.at(-1)).toBe('back a1 p1 []');

		const allowed = setup(true);
		expect((await allowed.host.call('a1', 'browser_navigate', { url: 'https://example.com/' })).isError).toBeUndefined();
	});

	it('refuses bad input and works without a page only to navigate', async () => {
		const { host } = setup();
		expect((await host.call('a1', 'browser_snapshot', {})).isError).toBe(true);
		expect((await host.call('a1', 'browser_navigate', { url: 'javascript:alert(1)' })).isError).toBe(true);
		await host.call('a1', 'browser_navigate', { url: 'http://localhost' });
		expect((await host.call('a1', 'browser_click', { ref: 'e1"; drop' })).isError).toBe(true);
		expect((await host.call('a1', 'browser_screenshot', {})).content[0]).toEqual({ type: 'image', data: 'aGk=', mimeType: 'image/jpeg' });
		expect((await host.call('a1', 'nope', { ref: 'e1' })).isError).toBe(true);
	});

	it('opens a new page when the user closed the old one', async () => {
		const { browser, host } = setup();
		await host.call('a1', 'browser_navigate', { url: 'http://localhost' });
		browser.open_.set('a1', []);
		await host.call('a1', 'browser_navigate', { url: 'http://localhost/2' });
		expect(browser.calls.filter(c => c.startsWith('open'))).toHaveLength(2);
	});

	it('knows local pages', () => {
		for (const url of ['http://localhost:3000', 'http://app.localhost', 'http://127.0.0.1', 'http://[::1]:8080', 'http://0.0.0.0:5173', 'file:///x']) {
			expect(isLocalUrl(new URL(url)), url).toBe(true);
		}
		for (const url of ['https://example.com', 'http://localhost.evil.com', 'http://10.0.0.1', 'http://128.0.0.1']) {
			expect(isLocalUrl(new URL(url)), url).toBe(false);
		}
	});
});

describe('BrowserMcpServer', () => {
	let server: BrowserMcpServer | undefined;
	afterEach(() => server?.dispose());

	async function post(url: string, headers: Record<string, string>, body: unknown) {
		const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
		return { status: res.status, json: res.status === 200 ? await res.json() : undefined };
	}

	it('speaks MCP over HTTP to the agent it was given to, with the token', async () => {
		const { host, browser } = setup();
		server = new BrowserMcpServer(host, '1.0.0');
		expect(server.configFor('a1')).toBeUndefined();
		await server.start();
		const config = server.configFor('a1')!;
		expect(config).toMatchObject({ type: 'http', name: 'geminicode-browser' });
		expect(server.configFor('../x')).toBeUndefined();
		const auth = { [config.headers[0].name]: config.headers[0].value };

		expect((await post(config.url, {}, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
		expect((await post(config.url, { Authorization: 'Bearer wrong' }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);

		const init = await post(config.url, auth, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
		expect(init.json).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'geminicode-browser' } } });
		expect((await post(config.url, auth, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
		const list = await post(config.url, auth, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
		expect((list.json as { result: { tools: { name: string }[] } }).result.tools.map(t => t.name)).toContain('browser_screenshot');
		const call = await post(config.url, auth, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'http://localhost:5173' } } });
		expect(call.json).toMatchObject({ id: 3, result: { content: [{ type: 'text' }] } });
		expect(browser.calls).toEqual(['open a1 http://localhost:5173/']);
		const missing = await post(config.url, auth, { jsonrpc: '2.0', id: 4, method: 'resources/list' });
		expect(missing.json).toMatchObject({ id: 4, error: { code: -32601 } });

		const get = await fetch(config.url, { headers: auth });
		expect(get.status).toBe(405);
		expect((await fetch(config.url.replace('/mcp/', '/other/'), { method: 'POST', headers: auth })).status).toBe(404);
	});
});
