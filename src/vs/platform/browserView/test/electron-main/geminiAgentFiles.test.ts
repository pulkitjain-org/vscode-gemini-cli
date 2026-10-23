/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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
	load(url: string, webContentsId?: number): Promise<boolean> {
		return new Promise(resolve => this.beforeRequest!({ url, webContentsId } as Electron.OnBeforeRequestListenerDetails, response => resolve(!response.cancel)));
	}

	/** The response headers the page `webContentsId` gets, or undefined when they are left alone. */
	headers(responseHeaders: Record<string, string[]>, webContentsId: number): Record<string, string[]> | undefined {
		let result: Record<string, string[]> | undefined;
		this.headersReceived!({ url: 'file:///w/index.html', webContentsId, responseHeaders } as unknown as Electron.OnHeadersReceivedListenerDetails, response => result = response.responseHeaders as Record<string, string[]> | undefined);
		return result;
	}
}

class TestView {
	private readonly _onDidChangeOwner = new Emitter<IBrowserViewOwner>();
	readonly onDidChangeOwner = this._onDidChangeOwner.event;
	private readonly _onDidClose = new Emitter<void>();
	readonly onDidClose = this._onDidClose.event;
	readonly host = { windowId: 7 };
	readonly webContents: { readonly id: number };
	readonly session: { readonly electronSession: Electron.Session };

	constructor(id: number, session: TestSession, public owner: IBrowserViewOwner) {
		this.webContents = { id };
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

/** Allows every file but `.env`, and records what it was asked. */
function setup() {
	const asked: string[] = [];
	const files = new GeminiAgentFiles(async (windowId, key, url) => {
		asked.push(`${windowId} ${key} ${url}`);
		return !url.endsWith('.env');
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
			filter: { urls: ['file://*/*'] },
			agentPage: true,
			agentSecret: false,
			userSecret: true,
			otherAgentSecret: true,
			asked: ['7 a1 file:///w/index.html', '7 a1 file:///w/.env'],
		});
		closeAll();
	});

	test('lets the session\'s own reads through, and refuses other loads without a page once an agent had a page there', async () => {
		const { asked, files, session, page, closeAll } = setup();
		const before = await session.load('file:///w/.env');
		const shared = page(1, user);
		shared.setOwner(agent);
		shared.setOwner(user);
		assert.deepStrictEqual({
			before,
			worker: await session.load('file:///w/.env'),
			ownRead: await files.readOwn(session.asSession(), 'file:///w/.env', () => session.load('file:///w/.env')),
			afterOwnRead: await session.load('file:///w/.env'),
			unknownPage: await session.load('file:///w/index.html', 99),
			asked,
		}, {
			before: true,
			worker: false,
			ownRead: true,
			afterOwnRead: false,
			unknownPage: false,
			asked: [],
		});
		closeAll();
	});

	test('keeps workers off a Gemini agent\'s documents', () => {
		const { session, page, closeAll } = setup();
		page(1, agent);
		page(2, user);
		assert.deepStrictEqual({
			agent: session.headers({ 'content-type': ['text/html'] }, 1),
			agentWithPolicy: session.headers({ 'content-security-policy': ['default-src *'] }, 1),
			user: session.headers({ 'content-type': ['text/html'] }, 2),
		}, {
			agent: { 'content-type': ['text/html'], 'Content-Security-Policy': ['worker-src \'none\''] },
			agentWithPolicy: { 'content-security-policy': ['default-src *', 'worker-src \'none\''] },
			user: undefined,
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
			unfiltered: { urls: ['file://*/*'] },
			asked: ['7 a1 file:///w/.env'],
		});
		closeAll();
	});
});
