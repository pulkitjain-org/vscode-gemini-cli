/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Make It Yours: one page to pick the colour theme, the code font and the file
// icons. Every pick applies at once.

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { codeFontOf, codeFonts, themeIds, withoutOldAccents } from '../acp/appearance';

const iconThemes = [
	{ id: 'geminicode-icons', label: () => vscode.l10n.t("GeminiCode") },
	{ id: 'vs-seti', label: () => vscode.l10n.t("Seti") },
	{ id: null, label: () => vscode.l10n.t("None") },
] as const;

/** What the page shows as chosen. */
interface Choices {
	readonly theme: string;
	readonly font: string | undefined;
	readonly icons: string | null;
}

type FromPage =
	| { readonly type: 'theme'; readonly id: string }
	| { readonly type: 'font'; readonly id: string }
	| { readonly type: 'icons'; readonly id: string | null }
	| { readonly type: 'moreThemes' };

export class Appearance implements vscode.Disposable {

	private panel: vscode.WebviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri) {
		this.disposables.push(
			vscode.commands.registerCommand('gemini.appearance', () => this.show()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (this.panel && ['workbench.colorTheme', 'workbench.iconTheme', 'editor.fontFamily'].some(key => e.affectsConfiguration(key))) {
					void this.panel.webview.postMessage({ type: 'choices', choices: this.choices() });
				}
			}),
		);
		void removeOldAccent();
	}

	dispose(): void {
		this.panel?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** Opens the page, or brings it to the front. */
	show(): void {
		if (this.panel) {
			this.panel.reveal();
			return;
		}
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		const panel = vscode.window.createWebviewPanel('gemini.appearance', vscode.l10n.t("Make It Yours"), vscode.ViewColumn.Active, {
			enableScripts: true,
			localResourceRoots: [media, vscode.Uri.joinPath(this.extensionUri, 'icons')],
		});
		panel.iconPath = vscode.Uri.joinPath(media, 'gemini.svg');
		this.panel = panel;
		panel.onDidDispose(() => this.panel = undefined);
		panel.webview.onDidReceiveMessage((message: FromPage) => void this.onMessage(message));
		panel.webview.html = this.html(panel.webview);
	}

	private choices(): Choices {
		const workbench = vscode.workspace.getConfiguration('workbench');
		return {
			theme: workbench.get<string>('colorTheme', ''),
			font: codeFontOf(vscode.workspace.getConfiguration('editor').get<string>('fontFamily'))?.id,
			icons: workbench.get<string | null>('iconTheme', null),
		};
	}

	private async onMessage(message: FromPage): Promise<void> {
		switch (message.type) {
			case 'theme':
				if ((themeIds as readonly string[]).includes(message.id)) {
					await setOrReset('workbench', 'colorTheme', message.id);
				}
				break;
			case 'font': {
				const font = codeFonts.find(f => f.id === message.id);
				if (font) {
					await setOrReset('editor', 'fontFamily', font.family);
				}
				break;
			}
			case 'icons':
				if (iconThemes.some(theme => theme.id === message.id)) {
					await setOrReset('workbench', 'iconTheme', message.id);
				}
				break;
			case 'moreThemes':
				await vscode.commands.executeCommand('workbench.action.selectTheme');
				break;
		}
	}

	private html(webview: vscode.Webview): string {
		const nonce = randomBytes(16).toString('base64');
		const fonts = vscode.Uri.joinPath(this.extensionUri, 'media', 'fonts');
		const font = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(fonts, file)).toString();
		const data = {
			strings: {
				title: vscode.l10n.t("Make it yours"),
				subtitle: vscode.l10n.t("Pick a theme, a code font and file icons. Each choice applies at once."),
				theme: vscode.l10n.t("Theme"),
				moreThemes: vscode.l10n.t("More themes..."),
				font: vscode.l10n.t("Code font"),
				icons: vscode.l10n.t("File icons"),
			},
			themes: [
				{ id: 'GeminiCode Dark', label: vscode.l10n.t("Dark"), kind: 'dark' },
				{ id: 'GeminiCode Light', label: vscode.l10n.t("Light"), kind: 'light' },
			],
			fonts: codeFonts.map(({ id, label, family }) => ({ id, label, family })),
			icons: iconThemes.map(theme => ({ id: theme.id, label: theme.label() })),
			iconUris: Object.fromEntries(['dark', 'light'].map(kind => [kind, Object.fromEntries(['folder-src', 'typescript', 'json', 'gemini'].map(name =>
				[name, webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'icons', kind, `${name}.svg`)).toString()]))])),
			choices: this.choices(),
		};
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; img-src ${webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style nonce="${nonce}">${pageCss(font)}</style>
</head>
<body>
	<main id="page"></main>
	<script nonce="${nonce}">const data = ${JSON.stringify(data).replace(/</g, '\\u003c')};
${pageScript}</script>
</body>
</html>`;
	}
}

/**
 * Earlier versions offered an accent colour, written as colour customizations
 * for the GeminiCode themes. The themes now have one accent, so a picked accent
 * is removed once, with its setting.
 */
async function removeOldAccent(): Promise<void> {
	const gemini = vscode.workspace.getConfiguration('gemini');
	if (gemini.inspect('appearance.accent')?.globalValue === undefined) {
		return;
	}
	const workbench = vscode.workspace.getConfiguration('workbench');
	const next = withoutOldAccents(workbench.inspect<Record<string, unknown>>('colorCustomizations')?.globalValue);
	if (next) {
		await workbench.update('colorCustomizations', Object.keys(next).length ? next : undefined, vscode.ConfigurationTarget.Global);
	}
	await gemini.update('appearance.accent', undefined, vscode.ConfigurationTarget.Global);
}

/** Sets a setting for the user, or removes their value when `value` is the default. */
async function setOrReset(section: string, key: string, value: string | null): Promise<void> {
	const config = vscode.workspace.getConfiguration(section);
	const isDefault = config.inspect(key)?.defaultValue === value;
	await config.update(key, isDefault ? undefined : value, vscode.ConfigurationTarget.Global);
}

function pageCss(font: (file: string) => string): string {
	return `
@font-face { font-family: 'JetBrains Mono'; font-weight: 100 800; src: url('${font('jetbrains-mono-latin-wght-normal.woff2')}') format('woff2'); }
@font-face { font-family: 'Geist Mono'; font-weight: 100 800; src: url('${font('geist-mono-latin-wght-normal.woff2')}') format('woff2'); }
:root { --line: var(--vscode-widget-border); --muted: var(--vscode-descriptionForeground); --on: var(--vscode-focusBorder); }
body { margin: 0; padding: 34px 48px 48px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; background: var(--vscode-editor-background); }
h1 { font-size: 18px; font-weight: 600; margin: 0; }
h2 { margin: 24px 0 8px; font-size: 11px; font-weight: 500; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
.subtitle { color: var(--muted); margin: 4px 0 0; }
.themes { display: flex; gap: 14px; flex-wrap: wrap; }
.theme { width: 230px; border: 1px solid var(--line); border-radius: 9px; padding: 0; overflow: hidden; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.theme.chosen { border-color: var(--on); box-shadow: 0 0 0 1px var(--on); }
.preview { height: 120px; display: flex; }
.preview .side { width: 30%; }
.preview .main { flex: 1; padding: 12px; display: grid; gap: 7px; align-content: start; }
.preview i { display: block; height: 6px; border-radius: 3px; }
.theme.dark .side { background: #15161A; } .theme.dark .main { background: #1A1B1F; } .theme.dark i { background: #383A42; } .theme.dark i.on { background: #C2C6CF; }
.theme.light .side { background: #F5F5F6; } .theme.light .main { background: #FFFFFF; } .theme.light i { background: #D2D4D8; } .theme.light i.on { background: #41454E; }
.theme .name { padding: 8px 11px; border-top: 1px solid var(--line); }
.more { margin-top: 10px; background: none; border: none; color: var(--vscode-textLink-foreground); font: inherit; padding: 0; cursor: pointer; }
.pills { display: flex; gap: 8px; flex-wrap: wrap; }
.pill { border: 1px solid var(--line); border-radius: 6px; padding: 6px 12px; background: none; color: inherit; font: inherit; cursor: pointer; }
.pill.chosen { border-color: var(--on); box-shadow: 0 0 0 1px var(--on); }
.files { display: flex; gap: 18px; margin-top: 10px; color: var(--muted); }
.files span { display: flex; align-items: center; gap: 6px; }
.files img { width: 16px; height: 16px; }
.files.hidden img { visibility: hidden; }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
`;
}

/** The page's script: draws the choices and posts each pick. `data` comes from the host. */
const pageScript = `
const vscode = acquireVsCodeApi();
const page = document.getElementById('page');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
let choices = data.choices;

function button(cls, chosen, text, message) {
	const b = el('button', cls + (chosen ? ' chosen' : ''), text);
	b.setAttribute('aria-pressed', String(chosen));
	b.addEventListener('click', () => vscode.postMessage(message));
	return b;
}

function render() {
	const s = data.strings;
	const themes = el('div', 'themes');
	for (const t of data.themes) {
		const card = button('theme ' + t.kind, choices.theme === t.id, undefined, { type: 'theme', id: t.id });
		const preview = el('div', 'preview');
		const main = el('div', 'main');
		[['70%'], ['45%', 'on'], ['85%'], ['60%']].forEach(([w, on]) => { const i = el('i', on); i.style.width = w; main.append(i); });
		preview.append(el('div', 'side'), main);
		card.append(preview, el('div', 'name', t.label));
		themes.append(card);
	}
	const more = el('button', 'more', s.moreThemes);
	more.addEventListener('click', () => vscode.postMessage({ type: 'moreThemes' }));

	const fonts = el('div', 'pills');
	for (const f of data.fonts) {
		const b = button('pill', choices.font === f.id, f.label, { type: 'font', id: f.id });
		b.style.fontFamily = f.family;
		fonts.append(b);
	}

	const icons = el('div', 'pills');
	for (const t of data.icons) {
		icons.append(button('pill', choices.icons === t.id, t.label, { type: 'icons', id: t.id }));
	}
	const files = el('div', 'files' + (choices.icons === 'geminicode-icons' ? '' : ' hidden'));
	const kind = document.body.classList.contains('vscode-light') ? 'light' : 'dark';
	for (const [icon, name] of [['folder-src', 'src'], ['typescript', 'checkout.ts'], ['json', 'package.json'], ['gemini', 'GEMINI.md']]) {
		const row = el('span'); const img = el('img'); img.src = data.iconUris[kind][icon]; img.alt = ''; row.append(img, name); files.append(row);
	}

	page.replaceChildren(el('h1', '', s.title), el('p', 'subtitle', s.subtitle),
		el('h2', '', s.theme), themes, more,
		el('h2', '', s.font), fonts,
		el('h2', '', s.icons), icons, files);
}

window.addEventListener('message', event => {
	if (event.data?.type === 'choices') { choices = event.data.choices; render(); }
});
render();
`;
