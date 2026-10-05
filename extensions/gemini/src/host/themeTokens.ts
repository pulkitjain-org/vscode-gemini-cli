/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { matchTokenColors, readThemeRules, TokenColors } from '../acp/tokenColors';

/** Theme files already read, by theme name. */
const cache = new Map<string, Promise<TokenColors>>();
const onDidChangeEmitter = new vscode.EventEmitter<void>();

/** Fires when the colour theme changes; read {@link themeTokenColors} again. */
export const onDidChangeThemeTokens = onDidChangeEmitter.event;

let listening: vscode.Disposable | undefined;

/** The active colour theme's syntax colours; empty when its file can't be read, and the chat's own colours apply. */
export function themeTokenColors(): Promise<TokenColors> {
	listening ??= vscode.window.onDidChangeActiveColorTheme(() => onDidChangeEmitter.fire());
	const name = activeThemeName();
	let colors = cache.get(name);
	if (!colors) {
		colors = readThemeRules(themeFile(name) ?? '').then(matchTokenColors);
		cache.set(name, colors);
	}
	return colors;
}

/** The theme in use: with the theme following the OS, a preferred theme rather than `workbench.colorTheme`. */
function activeThemeName(): string {
	const workbench = vscode.workspace.getConfiguration('workbench');
	const windowSettings = vscode.workspace.getConfiguration('window');
	const kind = vscode.window.activeColorTheme.kind;
	const highContrast = kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight;
	let setting = 'colorTheme';
	if (highContrast && windowSettings.get<boolean>('autoDetectHighContrast')) {
		setting = kind === vscode.ColorThemeKind.HighContrast ? 'preferredHighContrastColorTheme' : 'preferredHighContrastLightColorTheme';
	} else if (!highContrast && windowSettings.get<boolean>('autoDetectColorScheme')) {
		setting = kind === vscode.ColorThemeKind.Dark ? 'preferredDarkColorTheme' : 'preferredLightColorTheme';
	}
	return workbench.get<string>(setting) ?? workbench.get<string>('colorTheme') ?? '';
}

/** The file of the theme whose settings name is `name`. */
function themeFile(name: string): string | undefined {
	for (const extension of vscode.extensions.all) {
		const themes: unknown = extension.packageJSON?.contributes?.themes;
		if (!Array.isArray(themes)) {
			continue;
		}
		const theme = themes.find(t => (t?.id ?? t?.label) === name || t?.label === name);
		if (typeof theme?.path === 'string') {
			return path.join(extension.extensionPath, theme.path);
		}
	}
	return undefined;
}
