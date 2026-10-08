/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Make It Yours: one page to pick the colour theme, the accent colour, the
// code font and the file icons. Every pick applies at once. The accent is a
// setting of its own (`gemini.appearance.accent`) that becomes colour
// customizations for the GeminiCode themes, so other themes are untouched.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import { AccentId, accentIds, AccentTable, codeFontOf, codeFonts, themeIds, withAccent } from '../acp/appearance';
import { chatFontSize, setChatFontSize } from './chatFont';
import { configSection } from './configuration';

const accentSetting = 'appearance.accent';
const iconThemes = [
	{ id: 'geminicode-icons', label: () => vscode.l10n.t("GeminiCode") },
	{ id: 'vs-seti', label: () => vscode.l10n.t("Seti") },
	{ id: null, label: () => vscode.l10n.t("None") },
] as const;

/** What the page shows as chosen. */
interface Choices {
	readonly theme: string;
	readonly accent: AccentId;
	readonly font: string | undefined;
	readonly icons: string | null;
	readonly chatFontSize: number;
}

/** The chat text sizes the page offers; the setting takes any size. */
const chatFontSizes = [13, 14, 15, 16];

type FromPage =
	| { readonly type: 'theme'; readonly id: string }
	| { readonly type: 'accent'; readonly id: AccentId }
	| { readonly type: 'font'; readonly id: string }
	| { readonly type: 'icons'; readonly id: string | null }
	| { readonly type: 'chatFontSize'; readonly size: number }
	| { readonly type: 'moreThemes' };

/** The colours a theme card is drawn with. */
interface Swatch {
	readonly id: string;
	readonly label: string;
	readonly bg: string;
	readonly bar: string;
	readonly card: string;
	readonly fg: string;
	readonly muted: string;
	readonly accent: string;
	readonly light: boolean;
}

export class Appearance implements vscode.Disposable {

	private panel: vscode.WebviewPanel | undefined;
	private table: Promise<AccentTable> | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri) {
		this.disposables.push(
			vscode.commands.registerCommand('gemini.appearance', () => this.show()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(`${configSection}.${accentSetting}`) || e.affectsConfiguration('workbench.colorTheme')) {
					void this.applyAccent();
				}
				if (this.panel && ['workbench.colorTheme', 'workbench.iconTheme', 'editor.fontFamily', `${configSection}.${accentSetting}`, `${configSection}.chat.fontSize`].some(key => e.affectsConfiguration(key))) {
					void this.panel.webview.postMessage({ type: 'choices', choices: this.choices() });
				}
			}),
		);
		// Nothing to read or write unless an accent was ever picked.
		void this.applyAccent();
	}

	dispose(): void {
		this.panel?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** Opens the page, or brings it to the front. */
	async show(): Promise<void> {
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
		panel.webview.html = this.html(panel.webview, await this.swatches(), (await this.accentTable()).accents);
	}

	/** Makes `workbench.colorCustomizations` show the chosen accent on the GeminiCode theme in use. */
	private async applyAccent(): Promise<void> {
		const accent = this.accent();
		const workbench = vscode.workspace.getConfiguration('workbench');
		const current = workbench.inspect<Record<string, unknown>>('colorCustomizations')?.globalValue;
		if (accent === 'theme' && !Object.keys(current ?? {}).some(key => key.startsWith('[GeminiCode '))) {
			return;
		}
		try {
			const next = withAccent(current, accent, workbench.get<string>('colorTheme', ''), await this.accentTable());
			if (next) {
				await workbench.update('colorCustomizations', Object.keys(next).length ? next : undefined, vscode.ConfigurationTarget.Global);
			}
		} catch (err) {
			void vscode.window.showWarningMessage(vscode.l10n.t("The accent colour could not be applied: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	private accent(): AccentId {
		const value = vscode.workspace.getConfiguration(configSection).get<string>(accentSetting, 'theme');
		return (accentIds as readonly string[]).includes(value) ? value as AccentId : 'theme';
	}

	private accentTable(): Promise<AccentTable> {
		this.table ??= fs.readFile(vscode.Uri.joinPath(this.extensionUri, 'themes', 'accents.json').fsPath, 'utf8').then(text => JSON.parse(text) as AccentTable);
		return this.table;
	}

	private choices(): Choices {
		const workbench = vscode.workspace.getConfiguration('workbench');
		return {
			theme: workbench.get<string>('colorTheme', ''),
			accent: this.accent(),
			font: codeFontOf(vscode.workspace.getConfiguration('editor').get<string>('fontFamily'))?.id,
			icons: workbench.get<string | null>('iconTheme', null),
			chatFontSize: chatFontSize(),
		};
	}

	private async onMessage(message: FromPage): Promise<void> {
		const global = vscode.ConfigurationTarget.Global;
		switch (message.type) {
			case 'theme':
				if ((themeIds as readonly string[]).includes(message.id)) {
					await setOrReset('workbench', 'colorTheme', message.id);
				}
				break;
			case 'accent':
				if ((accentIds as readonly string[]).includes(message.id)) {
					await vscode.workspace.getConfiguration(configSection).update(accentSetting, message.id === 'theme' ? undefined : message.id, global);
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
			case 'chatFontSize':
				if (chatFontSizes.includes(message.size)) {
					await setChatFontSize(message.size);
				}
				break;
			case 'moreThemes':
				await vscode.commands.executeCommand('workbench.action.selectTheme');
				break;
		}
	}

	/** Each GeminiCode theme's colours, for its card. */
	private async swatches(): Promise<Swatch[]> {
		const table = await this.accentTable();
		const files: Record<string, string> = {
			'GeminiCode Dark': 'geminicode-dark.json',
			'GeminiCode Midnight': 'geminicode-midnight.json',
			'GeminiCode Dusk': 'geminicode-dusk.json',
			'GeminiCode Light': 'geminicode-light.json',
		};
		const labels: Record<string, string> = {
			'GeminiCode Dark': vscode.l10n.t("Dark"),
			'GeminiCode Midnight': vscode.l10n.t("Midnight"),
			'GeminiCode Dusk': vscode.l10n.t("Dusk"),
			'GeminiCode Light': vscode.l10n.t("Light"),
		};
		return Promise.all(themeIds.map(async id => {
			const colors = (JSON.parse(await fs.readFile(vscode.Uri.joinPath(this.extensionUri, 'themes', files[id]).fsPath, 'utf8')) as { colors: Record<string, string> }).colors;
			const solid = (key: string, fallback: string) => (colors[key] ?? fallback).slice(0, 7);
			return {
				id,
				label: labels[id],
				bg: solid('editor.background', '#000000'),
				bar: solid('titleBar.activeBackground', '#000000'),
				card: solid('input.background', '#222222'),
				fg: solid('editor.foreground', '#cccccc'),
				muted: solid('descriptionForeground', '#888888'),
				accent: solid('textLink.foreground', '#8AB4F8'),
				light: table.themes[id]?.kind === 'light',
			};
		}));
	}

	private html(webview: vscode.Webview, swatches: readonly Swatch[], accentColors: AccentTable['accents']): string {
		const nonce = randomBytes(16).toString('base64');
		const fonts = vscode.Uri.joinPath(this.extensionUri, 'media', 'fonts');
		const font = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(fonts, file)).toString();
		const strings = {
			title: vscode.l10n.t("Make it yours"),
			subtitle: vscode.l10n.t("Pick a look. Each choice applies at once, and you can change it any time."),
			theme: vscode.l10n.t("Theme"),
			moreThemes: vscode.l10n.t("More themes..."),
			accent: vscode.l10n.t("Accent"),
			accentHint: vscode.l10n.t("Used for selection, focus, links and the Send button."),
			font: vscode.l10n.t("Code font"),
			icons: vscode.l10n.t("File icons"),
			chatText: vscode.l10n.t("Chat text"),
			chatTextSample: vscode.l10n.t("Fix the rounding in the cart total and add a test."),
			chatTextHint: vscode.l10n.t("For the chat, agent tabs and Agent Home. Code blocks follow the editor font size."),
			accents: {
				theme: vscode.l10n.t("Theme's own"),
				blue: vscode.l10n.t("Blue"),
				violet: vscode.l10n.t("Violet"),
				rose: vscode.l10n.t("Rose"),
				teal: vscode.l10n.t("Teal"),
				amber: vscode.l10n.t("Amber"),
				gradient: vscode.l10n.t("Gemini gradient"),
			},
		};
		const data = {
			strings,
			swatches,
			accents: accentIds.map(id => ({ id, label: strings.accents[id] })),
			accentColors,
			fonts: codeFonts.map(({ id, label }) => ({ id, label })),
			chatFontSizes,
			icons: iconThemes.map(theme => ({ id: theme.id, label: theme.label() })),
			iconUris: Object.fromEntries(['dark', 'light'].map(kind => [kind, Object.fromEntries(['typescript', 'javascript', 'html', 'json', 'gemini', 'folder-src'].map(name =>
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
:root { --radius: 12px; --border: var(--vscode-widget-border, rgba(128, 128, 128, 0.25)); --muted: var(--vscode-descriptionForeground); --accent: var(--vscode-focusBorder); }
body { margin: 0; padding: 32px 48px 48px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; background: var(--vscode-editor-background); }
h1 { font-size: 24px; font-weight: 600; margin: 0; }
h2 { font-size: 13px; font-weight: 600; margin: 0 0 12px; }
.subtitle { color: var(--muted); margin: 6px 0 24px; }
.themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; max-width: 1100px; }
.theme { border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.theme:hover { border-color: var(--muted); }
.theme.chosen { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
.preview { height: 120px; border-radius: 8px; display: grid; grid-template-columns: 30% 1fr; gap: 4px; padding: 14px 4px 4px; position: relative; }
.preview .dots { position: absolute; left: 7px; top: 5px; display: flex; gap: 3px; }
.preview .dots i { width: 5px; height: 5px; border-radius: 50%; display: block; }
.preview .side, .preview .main { border-radius: 5px; padding: 6px; position: relative; }
.preview .line { height: 4px; border-radius: 2px; margin: 4px 0 8px; }
.preview .bubble { margin-left: auto; width: 60%; height: 10px; border-radius: 4px; }
.preview .input { position: absolute; left: 6px; right: 6px; bottom: 6px; height: 16px; border-radius: 5px; border: 1px solid; display: flex; justify-content: flex-end; align-items: center; padding: 0 3px; }
.preview .send { width: 10px; height: 10px; border-radius: 50%; }
.theme .name { margin-top: 8px; display: flex; align-items: center; gap: 6px; }
.more { margin-top: 10px; background: none; border: none; color: var(--vscode-textLink-foreground); font: inherit; padding: 0; cursor: pointer; }
.row { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; margin-top: 24px; max-width: 1100px; }
.card { border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
.accents { display: flex; gap: 12px; flex-wrap: wrap; }
.accent { width: 26px; height: 26px; border-radius: 50%; border: none; padding: 0; cursor: pointer; }
.accent.chosen { box-shadow: 0 0 0 2px var(--vscode-editor-background), 0 0 0 4px var(--vscode-foreground); }
.accent.theme-own { background: conic-gradient(#8AB4F8 0 25%, #B69CF6 0 50%, #F2A28B 0 75%, #1A5FD6 0); }
.hint { color: var(--muted); font-size: 12px; margin-top: 12px; }
.pills { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.pill { border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px; background: none; color: inherit; font: inherit; cursor: pointer; }
.pill.chosen { border-color: var(--accent); color: var(--vscode-textLink-foreground); }
.sample { line-height: 1.6; font-size: 13px; font-variant-ligatures: none; }
.sample .kw { color: var(--vscode-symbolIcon-keywordForeground, #B69CF6); }
.sample .fn { color: var(--vscode-symbolIcon-functionForeground, #8AB4F8); }
.chat-sample { display: inline-block; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--vscode-input-background); line-height: 1.5; }
.files div { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
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
const accentColors = data.accentColors;
const gradient = 'linear-gradient(135deg, #4796e3 10%, #9177c7 55%, #ca6673 90%)';
let choices = data.choices;

function render() {
	const s = data.strings;
	const title = el('h1', '', s.title);
	const subtitle = el('div', 'subtitle', s.subtitle);
	const themes = el('div', 'themes');
	for (const sw of data.swatches) {
		const card = el('button', 'theme' + (choices.theme === sw.id ? ' chosen' : ''));
		card.setAttribute('aria-pressed', String(choices.theme === sw.id));
		const accent = choices.accent === 'theme' ? sw.accent : accentColors[choices.accent][sw.light ? 1 : 0];
		const preview = el('div', 'preview');
		preview.style.background = sw.bar;
		const dots = el('div', 'dots');
		for (const c of ['#ff5f57', '#febc2e', '#28c840']) { const d = el('i'); d.style.background = c; dots.append(d); }
		const side = el('div', 'side');
		side.style.background = sw.bg;
		[80, 64, 72].forEach((w, i) => { const l = el('div', 'line'); l.style.width = w + '%'; l.style.background = i === 0 ? accent : sw.muted; l.style.opacity = i === 0 ? '1' : '0.5'; side.append(l); });
		const main = el('div', 'main');
		main.style.background = sw.bg;
		const bubble = el('div', 'bubble'); bubble.style.background = sw.card; main.append(bubble);
		[90, 75].forEach(w => { const l = el('div', 'line'); l.style.width = w + '%'; l.style.background = sw.fg; l.style.opacity = '0.55'; main.append(l); });
		const input = el('div', 'input'); input.style.background = sw.card; input.style.borderColor = accent;
		const send = el('div', 'send'); send.style.background = choices.accent === 'gradient' ? gradient : accent; input.append(send); main.append(input);
		preview.append(dots, side, main);
		const name = el('div', 'name', sw.label);
		card.append(preview, name);
		card.addEventListener('click', () => vscode.postMessage({ type: 'theme', id: sw.id }));
		themes.append(card);
	}
	const more = el('button', 'more', s.moreThemes);
	more.addEventListener('click', () => vscode.postMessage({ type: 'moreThemes' }));

	const accentCard = el('section', 'card');
	const accents = el('div', 'accents');
	for (const a of data.accents) {
		const b = el('button', 'accent' + (a.id === 'theme' ? ' theme-own' : '') + (choices.accent === a.id ? ' chosen' : ''));
		if (a.id !== 'theme') { b.style.background = a.id === 'gradient' ? gradient : accentColors[a.id][0]; }
		b.title = a.label;
		b.setAttribute('aria-label', a.label);
		b.setAttribute('aria-pressed', String(choices.accent === a.id));
		b.addEventListener('click', () => vscode.postMessage({ type: 'accent', id: a.id }));
		accents.append(b);
	}
	const chosenAccent = data.accents.find(a => a.id === choices.accent);
	accentCard.append(el('h2', '', s.accent + (chosenAccent ? ': ' + chosenAccent.label : '')), accents, el('div', 'hint', s.accentHint));

	const fontCard = el('section', 'card');
	const pills = el('div', 'pills');
	for (const f of data.fonts) {
		const b = el('button', 'pill' + (choices.font === f.id ? ' chosen' : ''), f.label);
		b.style.fontFamily = f.id === 'jetbrains' ? "'JetBrains Mono'" : f.id === 'geist' ? "'Geist Mono'" : f.id === 'sf' ? 'ui-monospace, monospace' : 'Menlo, monospace';
		b.setAttribute('aria-pressed', String(choices.font === f.id));
		b.addEventListener('click', () => vscode.postMessage({ type: 'font', id: f.id }));
		pills.append(b);
	}
	const sample = el('div', 'sample');
	sample.style.fontFamily = choices.font === 'geist' ? "'Geist Mono'" : choices.font === 'sf' ? 'ui-monospace, monospace' : choices.font === 'menlo' ? 'Menlo, monospace' : "'JetBrains Mono', monospace";
	const kw = el('span', 'kw', 'const'); const fn = el('span', 'fn', 'cents');
	sample.append(kw, ' total = ', fn, '(items) => 0;');
	fontCard.append(el('h2', '', s.font), pills, sample);

	const iconCard = el('section', 'card');
	const iconPills = el('div', 'pills');
	for (const t of data.icons) {
		const b = el('button', 'pill' + (choices.icons === t.id ? ' chosen' : ''), t.label);
		b.setAttribute('aria-pressed', String(choices.icons === t.id));
		b.addEventListener('click', () => vscode.postMessage({ type: 'icons', id: t.id }));
		iconPills.append(b);
	}
	const files = el('div', 'files' + (choices.icons === 'geminicode-icons' ? '' : ' hidden'));
	for (const [icon, name] of [['folder-src', 'src'], ['typescript', 'checkout.ts'], ['javascript', 'vite.config.js'], ['html', 'index.html'], ['json', 'package.json'], ['gemini', 'GEMINI.md']]) {
		const row = el('div'); const img = el('img'); img.src = data.iconUris[document.body.classList.contains('vscode-light') ? 'light' : 'dark'][icon]; img.alt = ''; row.append(img, name); files.append(row);
	}
	iconCard.append(el('h2', '', s.icons), iconPills, files);

	const textCard = el('section', 'card');
	const sizes = el('div', 'pills');
	for (const size of data.chatFontSizes) {
		const b = el('button', 'pill' + (choices.chatFontSize === size ? ' chosen' : ''), size + ' px');
		b.setAttribute('aria-pressed', String(choices.chatFontSize === size));
		b.addEventListener('click', () => vscode.postMessage({ type: 'chatFontSize', size }));
		sizes.append(b);
	}
	const bubble = el('div', 'chat-sample', s.chatTextSample);
	bubble.style.fontSize = choices.chatFontSize + 'px';
	textCard.append(el('h2', '', s.chatText), sizes, bubble, el('div', 'hint', s.chatTextHint));

	const row = el('div', 'row');
	row.append(accentCard, fontCard, textCard, iconCard);
	page.replaceChildren(title, subtitle, el('h2', '', s.theme), themes, more, row);
}

window.addEventListener('message', event => {
	if (event.data?.type === 'choices') { choices = event.data.choices; render(); }
});
render();
`;
