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
export const window = {};
`;

/** Exports `name` from the host module at `file` (relative to the extension), bundled with the stand-in for `vscode`. */
async function hostExport<T>(file: string, name: string): Promise<T> {
	const result = await build({
		entryPoints: [path.join(root, file)],
		bundle: true,
		write: false,
		format: 'cjs',
		platform: 'node',
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

/** Runs the page's script, `webview-src/<name>.ts`, once per test file; it is not type-checked with the tests. */
export async function startScript(name: string): Promise<void> {
	await import(`../../webview-src/${name}.ts`);
}

/** Sends the page a message from the extension. */
export function sendToPage(data: unknown): void {
	page.dispatchEvent(new page.MessageEvent('message', { data }));
}
