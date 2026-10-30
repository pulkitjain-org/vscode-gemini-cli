/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The shell every page of GeminiCode's shares: the Audit log, Connections,
// Index, Agent Setup, an agent's Files, Plan Review, the Review Page and the
// team flows. One HTML document (one Content-Security-Policy, the shared
// stylesheets that carry the look's tokens, the page's own script with its
// strings), one panel lifecycle (create, reveal, post, visibility, dispose)
// and one place a message from the webview is routed, so a page holds only
// what is its own: its strings, its view and its answers.

import * as vscode from 'vscode';
import { createNonce, escapeAttribute } from './webviewHtml';

/** The stylesheets every page loads, in order, before its own: the icons, the menus, the pages' shared look and its glass. */
const sharedStyles = ['tokens.css', 'codicon.css', 'menu.css', 'panels.css'] as const;
const glassStyle = 'glass.css';

/** What a page's document is made of. */
export interface PageShell {
	/** The page's script in `media/`, such as `auditLog.js`. */
	readonly script: string;
	/** The page's own stylesheets in `media/`, loaded after the shared ones. */
	readonly styles?: readonly string[];
	/** The document's title, as the page names itself. */
	readonly title: string;
	readonly bodyClass: string;
	/** The class of `<main>`, the element the page's script renders into. */
	readonly mainClass?: string;
	/** The id of `<main>`; `page` unless the page's stylesheet names another. */
	readonly mainId?: string;
	/** The page's words, read by its script from the script tag (`pageStrings` in webview-src/panelDom.ts). */
	readonly strings: unknown;
	/** Other `data-` attributes on the script tag, by name without the prefix. */
	readonly data?: Readonly<Record<string, string>>;
	/** `data-` attributes whose values are files in `media/`, written as the webview's URIs: a chunk the page loads on its own. */
	readonly media?: Readonly<Record<string, string>>;
	/** Whether the page loads more from `media/` than its script and styles: a chunk of its own, or images. */
	readonly loadsMedia?: boolean;
	/** The tabs of a page that is one of several, such as Agent Setup's, drawn above `<main>`; a click posts `openTab`. */
	readonly tabs?: readonly PageTab[];
	/** What the tab strip is, for screen readers. */
	readonly tabsLabel?: string;
}

export interface PageTab {
	readonly id: string;
	readonly label: string;
	readonly active?: boolean;
}

/** The HTML document for `shell`, with one policy: nothing but the page's own script, the stylesheets from `media/`, and data: fonts and images. */
export function pageHtml(webview: vscode.Webview, media: vscode.Uri, shell: PageShell): string {
	const nonce = createNonce();
	const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file));
	const styles = [...sharedStyles, ...shell.styles ?? [], glassStyle].map(file => `<link href="${uri(file)}" rel="stylesheet">`).join('\n\t');
	const more = shell.loadsMedia ? ` ${webview.cspSource}` : '';
	const data = [
		...Object.entries(shell.data ?? {}).map(([name, value]) => ` data-${name}="${escapeAttribute(value)}"`),
		...Object.entries(shell.media ?? {}).map(([name, file]) => ` data-${name}="${uri(file)}"`),
	].join('');
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data: ${webview.cspSource}; img-src data:${more}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'${more};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	${styles}
	<title>${escapeAttribute(shell.title)}</title>
</head>
<body class="${escapeAttribute(shell.bodyClass)}">${tabsHtml(shell)}
	<main id="${escapeAttribute(shell.mainId ?? 'page')}"${shell.mainClass ? ` class="${escapeAttribute(shell.mainClass)}"` : ''}></main>
	<script nonce="${nonce}" type="module" src="${uri(shell.script)}" data-strings="${escapeAttribute(JSON.stringify(shell.strings))}"${data}></script>
</body>
</html>`;
}

/** The tab strip of a page that is one of several, or nothing. */
function tabsHtml(shell: PageShell): string {
	if (!shell.tabs?.length) {
		return '';
	}
	const tabs = shell.tabs.map(tab => `<button type="button" class="page-tab${tab.active ? ' active' : ''}" data-tab="${escapeAttribute(tab.id)}"${tab.active ? ' aria-current="page"' : ''}>${escapeAttribute(tab.label)}</button>`).join('');
	return `\n\t<nav class="page-tabs" aria-label="${escapeAttribute(shell.tabsLabel ?? '')}">${tabs}</nav>`;
}

export interface PagePanelOptions {
	readonly viewType: string;
	readonly title: string;
	/** A theme icon, or an image in `media/` such as a tool's logo. */
	readonly icon?: vscode.ThemeIcon | vscode.Uri;
	/** Where the tab opens; the active group by default. */
	readonly column?: vscode.ViewColumn | { readonly viewColumn: vscode.ViewColumn; readonly preserveFocus?: boolean };
	/** Whether the page keeps its state while hidden; off for a page that rebuilds its view from the host each time it shows. */
	readonly retainContextWhenHidden?: boolean;
	/** A click on one of the shell's tabs (`PageShell.tabs`), by its id. */
	openTab?(tab: string): void;
}

/**
 * A webview panel with the page shell, typed messages both ways, and the
 * lifecycle every page repeats: `post` answers to a page that may be gone,
 * `onDidChangeVisibility` for a page that refreshes when it shows, and
 * `onDidDispose` once, after which nothing is posted.
 */
export class PagePanel<To, From extends { readonly type: string }> implements vscode.Disposable {

	readonly panel: vscode.WebviewPanel;
	private readonly onDidDisposeEmitter = new vscode.EventEmitter<void>();
	/** The user closed the tab, or `dispose` ran. */
	readonly onDidDispose = this.onDidDisposeEmitter.event;
	private readonly onDidChangeVisibilityEmitter = new vscode.EventEmitter<boolean>();
	/** The tab came into view or went out of it. */
	readonly onDidChangeVisibility = this.onDidChangeVisibilityEmitter.event;
	private readonly onDidChangeActiveEmitter = new vscode.EventEmitter<boolean>();
	/** The tab became the active one in its group, or stopped being it. */
	readonly onDidChangeActive = this.onDidChangeActiveEmitter.event;
	private _disposed = false;

	constructor(
		extensionUri: vscode.Uri,
		options: PagePanelOptions,
		shell: PageShell | ((webview: vscode.Webview, media: vscode.Uri) => string),
		onMessage: (message: From) => void | Promise<void>,
		onError: (err: unknown) => void = () => undefined,
	) {
		const media = vscode.Uri.joinPath(extensionUri, 'media');
		this.panel = vscode.window.createWebviewPanel(options.viewType, options.title, options.column ?? vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: !!options.retainContextWhenHidden,
			localResourceRoots: [media],
		});
		if (options.icon) {
			this.panel.iconPath = options.icon;
		}
		this.panel.webview.html = typeof shell === 'function' ? shell(this.panel.webview, media) : pageHtml(this.panel.webview, media, shell);
		this.panel.webview.onDidReceiveMessage((message: From) => {
			if (message.type === 'openTab') {
				options.openTab?.((message as unknown as { readonly tab: string }).tab);
				return;
			}
			try {
				const result = onMessage(message);
				if (result && typeof (result as Promise<void>).catch === 'function') {
					void (result as Promise<void>).catch(onError);
				}
			} catch (err) {
				onError(err);
			}
		});
		this.panel.onDidChangeViewState(e => {
			this.onDidChangeVisibilityEmitter.fire(e.webviewPanel.visible);
			this.onDidChangeActiveEmitter.fire(e.webviewPanel.active);
		});
		this.panel.onDidDispose(() => this.onPanelDisposed());
	}

	get disposed(): boolean {
		return this._disposed;
	}

	get visible(): boolean {
		return this.panel.visible;
	}

	get active(): boolean {
		return this.panel.active;
	}

	/** Sends `message` to the page; nothing once the panel is gone, since a disposed webview throws. */
	post(message: To): void {
		if (!this._disposed) {
			void this.panel.webview.postMessage(message);
		}
	}

	reveal(column?: vscode.ViewColumn, preserveFocus?: boolean): void {
		if (!this._disposed) {
			this.panel.reveal(column, preserveFocus);
		}
	}

	dispose(): void {
		if (!this._disposed) {
			this.panel.dispose();
		}
	}

	private onPanelDisposed(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this.onDidDisposeEmitter.fire();
		this.onDidDisposeEmitter.dispose();
		this.onDidChangeVisibilityEmitter.dispose();
		this.onDidChangeActiveEmitter.dispose();
	}
}

/**
 * A page of which there is one at a time (the Audit log, Connections, Index,
 * Agent Setup): `show` reveals the open one or makes a new one, and forgets it
 * when its tab closes.
 */
export class SinglePage<To, From extends { readonly type: string }> implements vscode.Disposable {

	private current: PagePanel<To, From> | undefined;

	constructor(private readonly create: () => PagePanel<To, From>) { }

	/** The open page, if any. */
	get page(): PagePanel<To, From> | undefined {
		return this.current;
	}

	/** Reveals the page, making it if it is not open; returns whether it was already open. */
	show(): boolean {
		if (this.current) {
			this.current.reveal();
			return true;
		}
		const page = this.current = this.create();
		page.onDidDispose(() => {
			if (this.current === page) {
				this.current = undefined;
			}
		});
		return false;
	}

	post(message: To): void {
		this.current?.post(message);
	}

	dispose(): void {
		this.current?.dispose();
		this.current = undefined;
	}
}
