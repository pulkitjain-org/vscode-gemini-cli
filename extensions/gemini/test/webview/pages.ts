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
export const workspace = { getConfiguration: () => ({ get: (key, fallback) => fallback }), onDidChangeConfiguration: () => ({ dispose() { } }) };
export const Uri = { joinPath: (base, ...parts) => [base, ...parts].join('/') };
export class EventEmitter { event = () => ({ dispose() { } }); fire() { } dispose() { } }
export const ViewColumn = { Active: -1 };
export const window = {
	createWebviewPanel: () => ({
		webview: { html: '', cspSource: 'webview', asWebviewUri: uri => String(uri), onDidReceiveMessage: () => ({ dispose() { } }), postMessage: async () => true },
		onDidDispose: () => ({ dispose() { } }),
	}),
};
`;

/** Exports `name` from the host module at `file` (relative to the extension), bundled with the stand-in for `vscode`. */
async function hostExport<T>(file: string, name: string): Promise<T> {
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
	const exports: Record<string, T> = {};
	const module = { exports };
	new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, createRequire(path.join(root, file)));
	return module.exports[name];
}

/** Messages the page posted to the extension. */
export const posted: { type: string;[key: string]: unknown }[] = [];

/** Puts `html`'s body into the document and gives the page `acquireVsCodeApi`; nothing is fetched, and scripts are not run. */
function showPage(html: string): void {
	page.document.body.innerHTML = html.replace(/^[\s\S]*<body[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/<script([^>]*) src="[^"]*"/g, '<script$1');
	posted.length = 0;
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
	const chatHtml = await hostExport<(webview: unknown, media: string, project: boolean, fork: boolean) => string>('src/host/chat/chatHtml.ts', 'chatHtml');
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
