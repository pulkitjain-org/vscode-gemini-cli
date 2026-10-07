/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: what the Gemini extension needs from the workbench that the
// extension API does not offer: OS notifications, the Dock badge, agent tab
// descriptions and the code fonts that ship with GeminiCode. The window modes
// are in geminiModes.ts.

import './geminiFonts.css';
import './geminiGlass.css';
import './geminiModes.js';
import './geminiBrowser.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { FontMeasurements } from '../../../../editor/browser/config/fontMeasurements.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FocusMode, INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';

/** The code fonts in geminiFonts.css. */
const bundledFonts = ['JetBrains Mono', 'Geist Mono'];

/**
 * Loads a bundled code font as soon as the editor font names it. Editors
 * measure their font when they open; a font still loading would be measured
 * as its fallback, so the measurements are taken again once it has loaded.
 */
class GeminiCodeFonts extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.geminiCodeFonts';

	constructor(@IConfigurationService private readonly configurationService: IConfigurationService) {
		super();
		this.load();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('editor.fontFamily') || e.affectsConfiguration('terminal.integrated.fontFamily')) {
				this.load();
			}
		}));
	}

	private load(): void {
		const families = `${this.configurationService.getValue('editor.fontFamily')} ${this.configurationService.getValue('terminal.integrated.fontFamily')}`;
		const fonts = bundledFonts.filter(name => families.includes(name)).flatMap(name => [`400 13px '${name}'`, `700 13px '${name}'`]);
		if (!fonts.length) {
			return;
		}
		// `document.fonts.check` answers true for faces that have not loaded, so compare statuses instead.
		const loaded = new Set([...mainWindow.document.fonts].filter(face => face.status === 'loaded'));
		Promise.all(fonts.map(font => mainWindow.document.fonts.load(font))).then(faces => {
			if (faces.flat().some(face => !loaded.has(face))) {
				FontMeasurements.clearAllFontInfos();
			}
		}, () => undefined);
	}
}

registerWorkbenchContribution2(GeminiCodeFonts.ID, GeminiCodeFonts, WorkbenchPhase.BlockStartup);

/**
 * Marks every workbench window with `gemini-glass-light` or `gemini-glass-dark`
 * while a Glass theme is on, for geminiGlass.css: a stable class rather than a
 * match on the theme's class name, which would restyle on every class change.
 */
class GeminiGlassMarker extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.geminiGlassMarker';

	constructor(
		@IWorkbenchThemeService themeService: IWorkbenchThemeService,
		@ILayoutService private readonly layoutService: ILayoutService,
	) {
		super();
		let theme = themeService.getColorTheme();
		this.mark(theme, [...layoutService.containers]);
		this._register(themeService.onDidColorThemeChange(next => {
			theme = next;
			this.mark(theme, [...this.layoutService.containers]);
		}));
		this._register(layoutService.onDidAddContainer(({ container }) => this.mark(theme, [container])));
	}

	private mark(theme: IWorkbenchColorTheme, containers: readonly HTMLElement[]): void {
		// The theme's id ends with its file's path, as in `themes-geminicode-glass-dark-json`.
		const light = theme.id.includes('themes-geminicode-glass-light-json');
		const dark = theme.id.includes('themes-geminicode-glass-dark-json');
		for (const container of containers) {
			container.classList.toggle('gemini-glass', light || dark);
			container.classList.toggle('gemini-glass-light', light);
			container.classList.toggle('gemini-glass-dark', dark);
			// On macOS a Glass window is see-through over the desktop (vibrancy, windows.ts), so the
			// page behind the workbench must be transparent too; the body's colour is set in code.
			container.ownerDocument.body.classList.toggle('gemini-glass-window', (light || dark) && isMacintosh);
		}
	}
}

registerWorkbenchContribution2(GeminiGlassMarker.ID, GeminiGlassMarker, WorkbenchPhase.BlockStartup);

interface GeminiToast {
	readonly title: string;
	readonly body?: string;
	readonly actions?: readonly string[];
	/** A newer toast with the same key replaces the older one. */
	readonly key?: string;
}

const liveToasts = new Map<string, CancellationTokenSource>();

/**
 * Shows an OS notification and bounces the Dock icon. Resolves when the user
 * clicks it (the window comes to the front) or it goes away, with what they
 * clicked: `{ clicked, actionIndex }`, or `{ supported: false }`.
 */
CommandsRegistry.registerCommand('_gemini.showToast', async (accessor, toast: GeminiToast) => {
	const hostService = accessor.get(IHostService);
	if (typeof toast?.title !== 'string') {
		return { supported: false, clicked: false };
	}
	const key = toast.key ?? toast.title;
	liveToasts.get(key)?.dispose(true);
	const cts = new CancellationTokenSource();
	liveToasts.set(key, cts);
	try {
		await hostService.focus(mainWindow, { mode: FocusMode.Notify });
		const result = await hostService.showToast({ title: toast.title, body: toast.body, actions: toast.actions, dedupeKey: `gemini:${key}` }, cts.token);
		if (result.clicked || typeof result.actionIndex === 'number') {
			await hostService.focus(mainWindow, { mode: FocusMode.Force });
		}
		return { supported: result.supported, clicked: result.clicked, actionIndex: result.actionIndex };
	} finally {
		if (liveToasts.get(key) === cts) {
			liveToasts.delete(key);
		}
		cts.dispose();
	}
});

/** Withdraws the toast with `key`, such as once the agent no longer waits. */
CommandsRegistry.registerCommand('_gemini.hideToast', (_accessor, key: string) => {
	liveToasts.get(key)?.dispose(true);
	liveToasts.delete(key);
});

/** Shows `count` on the Dock icon; 0 clears it. The badge goes with the window. */
CommandsRegistry.registerCommand('_gemini.setApplicationBadge', (accessor, count: number, description: string) => {
	const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
	return accessor.get(INativeHostService).setApplicationBadge(n ? { count: n, description: String(description ?? '') } : undefined);
});

interface AgentTab {
	/** The agent's id, also in its tab icon's fragment, as `gemini-agent=<id>`. */
	readonly id?: string;
	readonly title: string;
	/** Shown after the title, such as the agent's line counts; empty for none. */
	readonly description: string;
}

/** The webview type of the Gemini extension's agent tabs, as the workbench names it. */
const agentTabViewType = 'mainThreadWebview-gemini.agent';

/**
 * Sets the description of each agent tab, matched by title. The extension
 * API can set a webview tab's title and icon but not a description.
 */
CommandsRegistry.registerCommand('_gemini.setAgentTabs', (accessor, tabs: readonly AgentTab[]) => {
	const list = Array.isArray(tabs) ? tabs : [];
	const byId = new Map(list.map(tab => [String(tab.id), String(tab.description ?? '')]));
	// Titles can repeat ("New agent"); the id in the icon's fragment can't. The title is only a fallback.
	const byTitle = new Map(list.map(tab => [String(tab.title), String(tab.description ?? '')]));
	for (const editor of accessor.get(IEditorService).editors) {
		if (editor instanceof WebviewInput && editor.viewType === agentTabViewType) {
			const icon = editor.iconPath;
			const fragment = icon && !ThemeIcon.isThemeIcon(icon) ? icon.light.fragment : '';
			const id = fragment.startsWith('gemini-agent=') ? fragment.slice('gemini-agent='.length) : undefined;
			editor.setGeminiDescription((id !== undefined ? byId.get(id) : byTitle.get(editor.getName())) || undefined);
		}
	}
});
