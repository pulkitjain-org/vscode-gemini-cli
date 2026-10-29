/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: holds every file a Gemini agent's page loads until the agent's file access policy
// allows it (see common/geminiAgentFiles.ts). Each browser session gets one `onBeforeRequest`
// and one `onHeadersReceived` listener for `file:` URLs (Electron keeps one of each per session,
// so upstream's network filter for Agent sessions goes through here too):
// - A load from a page (a frame, object, script, image, fetch) carries the page's webContents.
//   For an agent's page, the page's window asks the Gemini extension, and a refused load fails.
// - Workers load files where neither listener nor the session's `file:` handler sees them, so an
//   agent's documents get `worker-src 'none'`. A service worker registered before that fetches
//   with no page; in a session that has held an agent's page, such loads are refused.
// - The session's `file:` handler (browserSession.ts) reads each file it serves through the
//   session again, also with no page: those reads are let through.

import electron from 'electron';
import { Event } from '../../../base/common/event.js';
import { validatedIpcMain } from '../../../base/parts/ipc/electron-main/ipcMain.js';
import { GeminiAgentFileAnswerChannel, GeminiAgentFileRequestChannel, geminiAgentOf, IGeminiAgentFileRequest } from '../common/geminiAgentFiles.js';
import type { BrowserView } from './browserView.js';

type RequestListener = (details: Electron.OnBeforeRequestListenerDetails, callback: (response: Electron.CallbackResponse) => void) => void;

/** Asks the window `windowId` whether the agent may load the file at `url`. */
export type GeminiAgentFileQuestion = (windowId: number, agent: string, url: string) => Promise<boolean>;

const fileUrls = { urls: ['file://*/*'] };

/** What an agent's documents may not do: start workers, whose loads nothing here sees. */
const agentDocumentPolicy = 'worker-src \'none\'';

export class GeminiAgentFiles {

	/** The browser's pages, by webContents id. */
	private readonly views = new Map<number, BrowserView>();
	/** Sessions that hold or held a Gemini agent's page. */
	private readonly agentSessions = new WeakSet<Electron.Session>();
	/** Upstream's network filter, for each Agent session whose network policy is on. */
	private readonly networkFilters = new WeakMap<Electron.Session, RequestListener>();
	/** The session's own reads of files it serves, by session and URL, while they run. */
	private readonly ownReads = new WeakMap<Electron.Session, Map<string, object[]>>();

	constructor(private readonly ask: GeminiAgentFileQuestion) { }

	/** Watches a page of the browser until it closes, before it loads anything. */
	track(view: BrowserView): void {
		const id = view.webContents.id;
		const session = view.session.electronSession;
		this.views.set(id, view);
		const mark = () => {
			if (geminiAgentOf(view.owner) !== undefined) {
				this.agentSessions.add(session);
			}
		};
		mark();
		const ownerChanges = view.onDidChangeOwner(mark);
		Event.once(view.onDidClose)(() => {
			ownerChanges.dispose();
			this.views.delete(id);
		});
	}

	/** Sets `session`'s listeners, keeping the network filter it has. */
	listen(session: Electron.Session): void {
		const filter = this.networkFilters.get(session);
		const checkFile: RequestListener = (details, callback) => {
			this.mayLoad(session, details).then(allowed => callback({ cancel: !allowed }), () => callback({ cancel: true }));
		};
		if (filter) {
			// The network filter lets every file through (IAgentNetworkFilterService.isUriAllowed), so files skip it.
			session.webRequest.onBeforeRequest((details, callback) => details.url.startsWith('file:') ? checkFile(details, callback) : filter(details, callback));
		} else {
			session.webRequest.onBeforeRequest(fileUrls, checkFile);
		}
		session.webRequest.onHeadersReceived(fileUrls, (details, callback) => callback(this.headers(details)));
	}

	/** Upstream's network filter for an Agent session, or `null` when its policy is off. */
	setNetworkFilter(session: Electron.Session, filter: RequestListener | null): void {
		if (filter) {
			this.networkFilters.set(session, filter);
		} else {
			this.networkFilters.delete(session);
		}
		this.listen(session);
	}

	/** Runs `read`, the session's own read of the file it serves at `url`, which the check lets through. */
	async readOwn<T>(session: Electron.Session, url: string, read: () => Promise<T>): Promise<T> {
		let reads = this.ownReads.get(session);
		if (!reads) {
			reads = new Map();
			this.ownReads.set(session, reads);
		}
		const token = {};
		reads.set(url, [...reads.get(url) ?? [], token]);
		try {
			return await read();
		} finally {
			const left = (reads.get(url) ?? []).filter(t => t !== token);
			if (left.length) {
				reads.set(url, left);
			} else {
				reads.delete(url);
			}
		}
	}

	private async mayLoad(session: Electron.Session, details: Electron.OnBeforeRequestListenerDetails): Promise<boolean> {
		const view = details.webContentsId !== undefined ? this.views.get(details.webContentsId) : undefined;
		if (view) {
			const agent = geminiAgentOf(view.owner);
			return agent === undefined || this.ask(view.host.windowId, agent, details.url);
		}
		if (details.webContentsId === undefined && this.takeOwnRead(session, details.url)) {
			return true;
		}
		// A service worker, or a page this has not seen: nobody to ask.
		return !this.agentSessions.has(session);
	}

	private takeOwnRead(session: Electron.Session, url: string): boolean {
		const reads = this.ownReads.get(session)?.get(url);
		if (!reads?.length) {
			return false;
		}
		reads.shift();
		return true;
	}

	private headers(details: Electron.OnHeadersReceivedListenerDetails): Electron.HeadersReceivedResponse {
		const view = details.webContentsId !== undefined ? this.views.get(details.webContentsId) : undefined;
		if (!view || geminiAgentOf(view.owner) === undefined) {
			return {};
		}
		const headers = { ...details.responseHeaders };
		const name = Object.keys(headers).find(key => key.toLowerCase() === 'content-security-policy') ?? 'Content-Security-Policy';
		headers[name] = [...headers[name] ?? [], agentDocumentPolicy];
		return { responseHeaders: headers };
	}
}

/** How long a window has to answer; a load nobody answers for is refused. */
const answerTimeoutMs = 10_000;

const pendingAnswers = new Map<number, { readonly window: Electron.WebContents; readonly resolve: (allowed: boolean) => void }>();
let lastQuestion = 0;
let listeningForAnswers = false;

function onAnswer(event: Electron.IpcMainEvent, id: unknown, allowed: unknown): void {
	const pending = typeof id === 'number' ? pendingAnswers.get(id) : undefined;
	if (pending && pending.window === event.sender) {
		pendingAnswers.delete(id as number);
		pending.resolve(allowed === true);
	}
}

const askWindow: GeminiAgentFileQuestion = (windowId, agent, url) => {
	const window = electron.BrowserWindow.fromId(windowId);
	if (!window || window.isDestroyed()) {
		return Promise.resolve(false);
	}
	if (!listeningForAnswers) {
		listeningForAnswers = true;
		validatedIpcMain.on(GeminiAgentFileAnswerChannel, onAnswer);
	}
	const id = ++lastQuestion;
	return new Promise<boolean>(resolve => {
		const timeout = setTimeout(() => {
			pendingAnswers.delete(id);
			resolve(false);
		}, answerTimeoutMs);
		pendingAnswers.set(id, {
			window: window.webContents, resolve: allowed => {
				clearTimeout(timeout);
				resolve(allowed);
			}
		});
		const request: IGeminiAgentFileRequest = { id, agent, url };
		window.webContents.send(GeminiAgentFileRequestChannel, request);
	});
};

export const geminiAgentFiles = new GeminiAgentFiles(askWindow);
