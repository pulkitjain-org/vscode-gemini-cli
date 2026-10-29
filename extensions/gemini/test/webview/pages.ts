/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The webviews' real pages, for DOM tests under happy-dom. A page's HTML and
// strings come from its host module, bundled with a stand-in for `vscode`
// (which only exists in the extension host), so the tests see the markup and
// English strings the app ships. The page's script is then imported as a module.

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { build } from 'esbuild';
import type { Window } from 'happy-dom';

const root = path.join(__dirname, '..', '..');

/**
 * The page the test runs in. `@vitest-environment happy-dom` puts happy-dom's
 * window in the globals; its own types keep the DOM's out of the tests'
 * compilation, which also checks extension code written against Node's.
 */
export const page = globalThis as unknown as Window;

/** What the host modules use of `vscode`: English strings, defaults for every setting, and URIs as plain paths. */
const fakeVscode = `
export const l10n = { t: (message, ...args) => message.replace(/\\{(\\d+)\\}/g, (match, i) => i < args.length ? String(args[i]) : match) };
const none = () => ({ dispose() { } });
export const workspace = {
	getConfiguration: () => ({ get: (key, fallback) => fallback }),
	onDidChangeConfiguration: none,
	// Each watcher's change listeners go to \`fakeWatchers\`, for \`fireWatcher\`.
	createFileSystemWatcher: () => {
		const listeners = [];
		(globalThis.fakeWatchers ??= []).push(listeners);
		return { onDidChange: listener => (listeners.push(listener), { dispose() { } }), onDidCreate: none, onDidDelete: none, dispose() { } };
	},
};
export const Uri = { joinPath: (base, ...parts) => [base, ...parts].join('/'), file: file => file };
export class EventEmitter { event = () => ({ dispose() { } }); fire() { } dispose() { } }
export class RelativePattern { }
export class ThemeIcon { }
export const Disposable = { from: () => ({ dispose() { } }) };
export const ViewColumn = { Active: -1 };
// A panel's messages both ways, for tests that drive a page's host (\`fakePanels\`): what the host posted, and its handler for the page's.
const panels = globalThis.fakePanels ??= [];
export const window = {
	createWebviewPanel: (viewType, title, column) => {
		const panel = { posted: [], receive: undefined, column };
		panels.push(panel);
		return {
			webview: {
				html: '', cspSource: 'webview', asWebviewUri: uri => String(uri),
				onDidReceiveMessage: handler => (panel.receive = handler, { dispose() { } }),
				postMessage: async message => (panel.posted.push(message), true),
			},
			onDidDispose: none,
			reveal() { },
			dispose() { },
		};
	},
};
`;

/** Exports `name` from the host module at `file` (relative to the extension), bundled with the stand-in for `vscode`. */
export async function hostExport<T>(file: string, name: string): Promise<T> {
	return (await hostModule(file))[name] as T;
}

/** Every export of a host module, built with a fake `vscode`. */
async function hostModule(file: string): Promise<Record<string, unknown>> {
	const result = await build({
		entryPoints: [path.join(root, file)],
		bundle: true,
		write: false,
		format: 'cjs',
		platform: 'node',
		// As the extension's own build does (esbuild-extension-common.mts): a package's ES module build, which esbuild can follow, before its UMD one.
		mainFields: ['module', 'main'],
		logLevel: 'silent',
		plugins: [{
			name: 'fake-vscode',
			setup(context) {
				context.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fake-vscode' }));
				context.onLoad({ filter: /.*/, namespace: 'fake-vscode' }, () => ({ contents: fakeVscode, loader: 'js' }));
			},
		}],
	});
	const exports: Record<string, unknown> = {};
	const module = { exports };
	new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, createRequire(path.join(root, file)));
	return module.exports;
}

/** Messages the page posted to the extension. */
export const posted: { type: string;[key: string]: unknown }[] = [];

/** A webview panel a host module made with the stand-in \`vscode\`: what its host posted, and the host's handler for the page's messages. */
export interface FakePanel {
	readonly posted: { type: string;[key: string]: unknown }[];
	receive?: (message: unknown) => void;
	/** The column the panel opened in. */
	readonly column?: unknown;
}

/** The panels host modules made, in order. */
export function fakePanels(): FakePanel[] {
	return (globalThis as { fakePanels?: FakePanel[] }).fakePanels ??= [];
}

/** Calls the change listeners of the file watcher a host module made last, as when the file it watches changes. */
export function fireWatcher(): void {
	for (const listener of (globalThis as { fakeWatchers?: (() => void)[][] }).fakeWatchers?.at(-1) ?? []) {
		listener();
	}
}

/** Puts `html`'s body into the document and gives the page `acquireVsCodeApi`; nothing is fetched, and scripts are not run. */
function showPage(html: string): void {
	page.document.body.innerHTML = html.replace(/^[\s\S]*<body[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/<script([^>]*) src="[^"]*"/g, '<script$1');
	posted.length = 0;
	// Not in happy-dom: the Popover API, which the themed tooltip opens a moment after focus or hover.
	const element = page.HTMLElement.prototype as unknown as { showPopover?: () => void; hidePopover?: () => void };
	element.showPopover ??= () => undefined;
	element.hidePopover ??= () => undefined;
	let saved: unknown;
	Object.assign(globalThis, {
		// Not in happy-dom: idle work (the highlighter, a long chat's older items) runs on a timer.
		requestIdleCallback: (callback: (deadline: { didTimeout: boolean; timeRemaining(): number }) => void) => setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 })),
		cancelIdleCallback: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
		acquireVsCodeApi: () => ({
			postMessage: (message: { type: string }) => posted.push(message),
			getState: () => saved,
			setState: (state: unknown) => saved = state,
		}),
	});
}

const fakeWebview = { asWebviewUri: (uri: unknown) => String(uri), cspSource: 'webview' };

/** The chat view's page, as `chatHtml` draws it; import `webview-src/chat` after it. */
export async function showChatPage(options: { project?: boolean; fork?: boolean } = {}): Promise<void> {
	const html = await hostModule('src/host/chat/chatHtml.ts');
	// The extension loads a project chat's strings from dist/onDemand.js; here they come straight from their module.
	(html.setProjectStrings as (load: () => unknown) => void)(await hostExport<() => unknown>('src/host/chat/projectStrings.ts', 'projectStrings'));
	const chatHtml = html.chatHtml as (webview: unknown, media: string, project: boolean, fork: boolean) => string;
	showPage(chatHtml(fakeWebview, 'media', !!options.project, !!options.fork));
}

/**
 * Runs `webview-src/<name>.ts`, the page's script or one of its modules, once
 * per test file, and returns its exports. The webviews' code is written
 * against the DOM's types, so it is type-checked with the webviews, not here.
 */
export async function startScript(name: string): Promise<Readonly<Record<string, unknown>>> {
	return import(`../../webview-src/${name}.ts`);
}

/** Plan Review's page with its real strings, without the Markdown chunk (the plan shows as text); start `webview-src/planReview` after it. */
export async function showPlanReviewPage(): Promise<void> {
	const strings = (await hostExport<() => unknown>('src/host/planReviewPage.ts', 'planStrings'))();
	showPage(`<body class="plan-page"><main id="page"></main><script type="module" data-strings='${JSON.stringify(strings).replace(/'/g, '&#39;')}'></script></body>`);
}

/** Home's page, as `AgentHome` draws it; start `webview-src/home` after it. */
export async function showHomePage(): Promise<void> {
	const home = await hostExport<{ prototype: { html(webview: unknown, media: string): string } }>('src/host/agentHome.ts', 'AgentHome');
	showPage(home.prototype.html(fakeWebview, 'media'));
}

/** A team flow's page, as `TeamFlowPanel` draws it; start `webview-src/teamFlow` after it. */
export async function showTeamFlowPage(): Promise<void> {
	const TeamFlowPanel = await hostExport<new (extensionUri: string, title: string, icon: string, loading: string, onAction: () => void) => { panel: { webview: { html: string } } }>('src/host/teamFlowPanel.ts', 'TeamFlowPanel');
	showPage(new TeamFlowPanel('extension', 'Open Merge Request', 'gitlab', 'Loading', () => undefined).panel.webview.html);
}

/** Sends the page a message from the extension. */
export function sendToPage(data: unknown): void {
	page.dispatchEvent(new page.MessageEvent('message', { data }));
}

/** The Review Page with its real strings, without the Markdown chunk (the agent's Markdown shows as one paragraph); start `webview-src/confluenceReview` after it. */
export async function showConfluenceReviewPage(): Promise<void> {
	const strings = (await hostExport<() => unknown>('src/host/confluenceReviewPage.ts', 'reviewStrings'))();
	showPage(`<body class="review-page"><main id="page"></main><script type="module" data-strings='${JSON.stringify(strings).replace(/'/g, '&#39;')}'></script></body>`);
}
