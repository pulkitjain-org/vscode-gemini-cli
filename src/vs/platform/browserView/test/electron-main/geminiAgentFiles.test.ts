/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: tests for electron-main/geminiAgentFiles.ts.

import assert from 'assert';
import { Emitter } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IBrowserViewOwner } from '../../common/browserView.js';
import type { BrowserView } from '../../electron-main/browserView.js';
import { GeminiAgentFiles } from '../../electron-main/geminiAgentFiles.js';

type BeforeRequest = (details: Electron.OnBeforeRequestListenerDetails, callback: (response: Electron.CallbackResponse) => void) => void;
type HeadersReceived = (details: Electron.OnHeadersReceivedListenerDetails, callback: (response: Electron.HeadersReceivedResponse) => void) => void;

class TestSession {
	filter: Electron.WebRequestFilter | undefined;
	private beforeRequest: BeforeRequest | undefined;
	private headersReceived: HeadersReceived | undefined;

	readonly webRequest = {
		onBeforeRequest: (filter: Electron.WebRequestFilter | BeforeRequest, listener?: BeforeRequest) => {
			this.filter = typeof filter === 'function' ? undefined : filter;
			this.beforeRequest = typeof filter === 'function' ? filter : listener;
		},
		onHeadersReceived: (_filter: Electron.WebRequestFilter, listener: HeadersReceived) => {
			this.headersReceived = listener;
		},
	};

	asSession(): Electron.Session {
		return this as unknown as Electron.Session;
	}

	/** Whether the session lets a load from the page `webContentsId` (none for a worker or the browser itself) through. */
	load(url: string, webContentsId?: number, resourceType: string = 'subFrame'): Promise<boolean> {
		return new Promise(resolve => this.beforeRequest!({ url, webContentsId, resourceType } as Electron.OnBeforeRequestListenerDetails, response => resolve(!response.cancel)));
	}

	/** The response headers the page `webContentsId` gets for `url`, or undefined when they are left alone. */
	headers(responseHeaders: Record<string, string[]>, webContentsId: number, url = 'file:///w/index.html'): Record<string, string[]> | undefined {
		let result: Record<string, string[]> | undefined;
		this.headersReceived!({ url, webContentsId, responseHeaders } as unknown as Electron.OnHeadersReceivedListenerDetails, response => result = response.responseHeaders as Record<string, string[]> | undefined);
		return result;
	}
}

class TestView {
	private readonly _onDidChangeOwner = new Emitter<IBrowserViewOwner>();
	readonly onDidChangeOwner = this._onDidChangeOwner.event;
	private readonly _onDidClose = new Emitter<void>();
	readonly onDidClose = this._onDidClose.event;
	readonly host = { windowId: 7 };
	readonly webContents: { readonly id: number; getURL(): string };
	readonly session: { readonly electronSession: Electron.Session };
	/** Where the page is. */
	url = 'file:///w/index.html';

	constructor(id: number, session: TestSession, public owner: IBrowserViewOwner) {
		this.webContents = { id, getURL: () => this.url };
		this.session = { electronSession: session.asSession() };
	}

	setOwner(owner: IBrowserViewOwner): void {
		this.owner = owner;
		this._onDidChangeOwner.fire(owner);
	}

	close(): void {
		this._onDidClose.fire();
		this._onDidChangeOwner.dispose();
		this._onDidClose.dispose();
	}

	asView(): BrowserView {
		return this as unknown as BrowserView;
	}
}

const agent: IBrowserViewOwner = { type: 'agent', sessionId: 'gemini-agent:a1' };
const user: IBrowserViewOwner = { type: 'user' };

/** Allows every file but `.env` and every site but the intranet, and records what it was asked. */
function setup() {
	const asked: string[] = [];
	const files = new GeminiAgentFiles(async (windowId, key, url) => {
		asked.push(`${windowId} ${key} ${url}`);
		return !url.endsWith('.env') && !url.includes('intranet');
	});
	const session = new TestSession();
	files.listen(session.asSession());
	const views: TestView[] = [];
	const page = (id: number, owner: IBrowserViewOwner) => {
		const view = new TestView(id, session, owner);
		views.push(view);
		files.track(view.asView());
		return view;
	};
	return { asked, files, session, page, closeAll: () => views.forEach(view => view.close()) };
}

suite('GeminiAgentFiles', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('asks about the files a Gemini agent\'s page loads, and leaves other pages alone', async () => {
		const { asked, session, page, closeAll } = setup();
		page(1, agent);
		page(2, user);
		page(3, { type: 'agent', sessionId: 'copilot:s1' });
		assert.deepStrictEqual({
			filter: session.filter,
			agentPage: await session.load('file:///w/index.html', 1),
			agentSecret: await session.load('file:///w/.env', 1),
			userSecret: await session.load('file:///w/.env', 2),
			otherAgentSecret: await session.load('file:///w/.env', 3),
			asked,
		}, {
			filter: { urls: ['file://*/*', 'http://*/*', 'https://*/*'] },
			agentPage: true,
			agentSecret: false,
			userSecret: true,
			otherAgentSecret: true,
			asked: ['7 a1 file:///w/index.html', '7 a1 file:///w/.env'],
		});
		closeAll();
	});

	test('asks about the sites a Gemini agent\'s local page reaches, and leaves pages on allowed sites alone', async () => {
		const { asked, session, page, closeAll } = setup();
		const local = page(1, agent);
		local.url = 'file:///w/index.html';
		const remote = page(2, agent);
		remote.url = 'https://shop.example/cart';
		const dev = page(3, agent);
		dev.url = 'http://localhost:5173/';
		page(4, user);
		assert.deepStrictEqual({
			fileToIntranet: await session.load('https://intranet.example/api', 1, 'xhr'),
			fileToShop: await session.load('https://shop.example/api', 1, 'xhr'),
			fileToLocal: await session.load('http://127.0.0.1:9000/api', 1, 'xhr'),
			devToIntranet: await session.load('https://intranet.example/api', 3, 'xhr'),
			remoteToIntranet: await session.load('https://intranet.example/api', 2, 'xhr'),
			usersToIntranet: await session.load('https://intranet.example/api', 4, 'xhr'),
			asked,
		}, {
			fileToIntranet: false,
			fileToShop: true,
			fileToLocal: true,
			devToIntranet: false,
			remoteToIntranet: true,
			usersToIntranet: true,
			asked: ['7 a1 https://intranet.example/api', '7 a1 https://shop.example/api', '7 a1 https://intranet.example/api'],
		});
		closeAll();
	});

	test('holds a local page\'s own navigation to another site, which a page the agent wrote could start by itself', async () => {
		const { asked, session, page, closeAll } = setup();
		const local = page(1, agent);
		local.url = 'file:///w/index.html';
		const dev = page(2, agent);
		dev.url = 'http://localhost:5173/';
		const remote = page(3, agent);
		remote.url = 'https://shop.example/cart';
		const fresh = page(4, agent);
		fresh.url = '';
		const users = page(5, user);
		users.url = 'file:///w/index.html';
		assert.deepStrictEqual({
			fileToIntranet: await session.load('https://intranet.example/x?secret', 1, 'mainFrame'),
			fileToShop: await session.load('https://shop.example/', 1, 'mainFrame'),
			fileToLocal: await session.load('http://localhost:3000/', 1, 'mainFrame'),
			devToIntranet: await session.load('https://intranet.example/', 2, 'mainFrame'),
			remoteToIntranet: await session.load('https://intranet.example/', 3, 'mainFrame'),
			freshToIntranet: await session.load('https://intranet.example/', 4, 'mainFrame'),
			usersToIntranet: await session.load('https://intranet.example/', 5, 'mainFrame'),
			asked,
		}, {
			fileToIntranet: false,
			fileToShop: true,
			fileToLocal: true,
			devToIntranet: false,
			remoteToIntranet: true,
			freshToIntranet: true,
			usersToIntranet: true,
			asked: ['7 a1 https://intranet.example/x?secret', '7 a1 https://shop.example/', '7 a1 https://intranet.example/'],
		});
		closeAll();
	});

	test('lets the session\'s own reads through, and refuses other loads without a page once an agent had a page there', async () => {
		const { asked, files, session, page, closeAll } = setup();
		const before = await session.load('file:///w/.env');
		const siteBefore = await session.load('https://intranet.example/api');
		const shared = page(1, user);
		shared.setOwner(agent);
		shared.setOwner(user);
		assert.deepStrictEqual({
			before,
			siteBefore,
			worker: await session.load('file:///w/.env'),
			workerToIntranet: await session.load('https://intranet.example/api'),
			workerToLocal: await session.load('http://localhost:5173/api'),
			ownRead: await files.readOwn(session.asSession(), 'file:///w/.env', () => session.load('file:///w/.env')),
			afterOwnRead: await session.load('file:///w/.env'),
			unknownPage: await session.load('file:///w/index.html', 99),
			asked,
		}, {
			before: true,
			siteBefore: true,
			worker: false,
			workerToIntranet: false,
			workerToLocal: true,
			ownRead: true,
			afterOwnRead: false,
			unknownPage: false,
			asked: [],
		});
		closeAll();
	});

	test('keeps workers off a Gemini agent\'s local documents, files and local sites alike', () => {
		const { session, page, closeAll } = setup();
		page(1, agent);
		page(2, user);
		assert.deepStrictEqual({
			agent: session.headers({ 'content-type': ['text/html'] }, 1),
			agentWithPolicy: session.headers({ 'content-security-policy': ['default-src *'] }, 1),
			agentDevServer: session.headers({ 'content-type': ['text/html'] }, 1, 'http://localhost:5173/'),
			agentLoopback: session.headers({ 'content-type': ['text/html'] }, 1, 'http://127.0.0.1:8080/index.html'),
			agentRemote: session.headers({ 'content-type': ['text/html'] }, 1, 'https://shop.example/'),
			user: session.headers({ 'content-type': ['text/html'] }, 2),
			userDevServer: session.headers({ 'content-type': ['text/html'] }, 2, 'http://localhost:5173/'),
		}, {
			agent: { 'content-type': ['text/html'], 'Content-Security-Policy': ['worker-src \'none\''] },
			agentWithPolicy: { 'content-security-policy': ['default-src *', 'worker-src \'none\''] },
			agentDevServer: { 'content-type': ['text/html'], 'Content-Security-Policy': ['worker-src \'none\''] },
			agentLoopback: { 'content-type': ['text/html'], 'Content-Security-Policy': ['worker-src \'none\''] },
			agentRemote: undefined,
			user: undefined,
			userDevServer: undefined,
		});
		closeAll();
	});

	test('keeps the network filter of an Agent session for other requests', async () => {
		const { asked, files, session, page, closeAll } = setup();
		page(1, agent);
		files.setNetworkFilter(session.asSession(), (details, callback) => callback({ cancel: details.url.includes('blocked') }));
		const filtered = {
			filter: session.filter,
			blocked: await session.load('https://blocked.example/', 1),
			allowed: await session.load('https://allowed.example/', 1),
			secret: await session.load('file:///w/.env', 1),
		};
		files.setNetworkFilter(session.asSession(), null);
		assert.deepStrictEqual({ filtered, unfiltered: session.filter, asked }, {
			filtered: { filter: undefined, blocked: false, allowed: true, secret: false },
			unfiltered: { urls: ['file://*/*', 'http://*/*', 'https://*/*'] },
			asked: ['7 a1 https://blocked.example/', '7 a1 https://allowed.example/', '7 a1 file:///w/.env'],
		});
		closeAll();
	});
});
