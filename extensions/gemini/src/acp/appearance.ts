/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The choices on the Make It Yours page. No editor API here, so it can be tested.

export const themeIds = ['GeminiCode Dark', 'GeminiCode Light'] as const;

export interface CodeFont {
	readonly id: string;
	readonly label: string;
	/** The `editor.fontFamily` it sets. */
	readonly family: string;
	/** Files, any one of which must exist for the font to draw; none for a font that is always there. */
	readonly needs?: readonly string[];
}

/**
 * Fonts the page offers. JetBrains Mono and Geist Mono ship with GeminiCode.
 * SF Mono comes with macOS but is private to the system: the app can draw it
 * only once the user has installed it (from Terminal or Xcode, say), so
 * without it the editor falls back to Menlo.
 */
export const codeFonts: readonly CodeFont[] = [
	{ id: 'jetbrains', label: 'JetBrains Mono', family: `'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace` },
	{ id: 'geist', label: 'Geist Mono', family: `'Geist Mono', Menlo, Monaco, 'Courier New', monospace` },
	{ id: 'sf', label: 'SF Mono', family: `ui-monospace, 'SF Mono', Menlo, Monaco, 'Courier New', monospace`, needs: sfMonoFiles() },
	{ id: 'menlo', label: 'Menlo', family: `Menlo, Monaco, 'Courier New', monospace` },
];

function sfMonoFiles(): readonly string[] {
	const home = process.env.HOME;
	return ['/Library/Fonts', ...(home ? [`${home}/Library/Fonts`] : [])].flatMap(dir => [`${dir}/SF-Mono-Regular.otf`, `${dir}/SFMono-Regular.otf`]);
}

/** The fonts that can draw here: those that need no file, and those with one of their files present. */
export function availableCodeFonts(exists: (file: string) => boolean): readonly CodeFont[] {
	return codeFonts.filter(font => !font.needs || font.needs.some(exists));
}

/** The font whose family `family` is, if it is one of ours. */
export function codeFontOf(family: string | undefined): CodeFont | undefined {
	const normalize = (f: string) => f.replace(/\s+/g, ' ').trim();
	return codeFonts.find(font => normalize(font.family) === normalize(family ?? ''));
}

type Customizations = Record<string, unknown>;

/**
 * `workbench.colorCustomizations` without the `[GeminiCode …]` blocks that the
 * accent picker of earlier versions wrote, or undefined when there are none.
 * Everything else the user customized is kept.
 */
export function withoutOldAccents(current: Customizations | undefined): Customizations | undefined {
	const keys = Object.keys(current ?? {}).filter(key => key.startsWith('[GeminiCode '));
	if (!current || !keys.length) {
		return undefined;
	}
	const next = { ...current };
	keys.forEach(key => delete next[key]);
	return next;
}
