/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The colour theme's syntax colours, for code blocks in chat. A webview gets
// the theme's UI colours as CSS variables but not its token colours, so these
// are read from the theme file and matched the way TextMate themes match
// scopes: the most specific selector that is a prefix of the scope wins.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { stripJsonComments } from './projectSettings';

/** What the chat colours, and the TextMate scopes that stand for each, tried in order. */
export const tokenCategories = {
	keyword: ['keyword', 'storage.type'],
	string: ['string.quoted', 'string'],
	comment: ['comment'],
	number: ['constant.numeric'],
	literal: ['constant.language'],
	function: ['entity.name.function', 'support.function'],
	type: ['entity.name.type', 'entity.name.class', 'support.class', 'support.type'],
	builtin: ['support.function', 'entity.name.function'],
	variable: ['variable.other.readwrite', 'variable.other', 'variable'],
	property: ['support.type.property-name', 'variable.other.property', 'meta.object-literal.key'],
	params: ['variable.parameter'],
	attribute: ['entity.other.attribute-name'],
	tag: ['entity.name.tag'],
	regexp: ['string.regexp'],
	operator: ['keyword.operator'],
	meta: ['meta.preprocessor', 'keyword.control.directive', 'meta.decorator'],
	heading: ['markup.heading', 'entity.name.section'],
	inserted: ['markup.inserted'],
	deleted: ['markup.deleted'],
	escape: ['constant.character.escape'],
} as const;

export type TokenCategory = keyof typeof tokenCategories;

export interface TokenStyle {
	readonly color?: string;
	readonly italic?: boolean;
}

export type TokenColors = Partial<Record<TokenCategory, TokenStyle>>;

export interface TokenRule {
	readonly scope?: string | readonly string[];
	readonly settings?: { readonly foreground?: string; readonly fontStyle?: string };
}

/** Each category's style under `rules`, the theme's token colours in order. */
export function matchTokenColors(rules: readonly TokenRule[]): TokenColors {
	const colors: TokenColors = {};
	for (const [category, scopes] of Object.entries(tokenCategories) as [TokenCategory, readonly string[]][]) {
		for (const scope of scopes) {
			const style = styleFor(rules, scope);
			if (style) {
				colors[category] = style;
				break;
			}
		}
	}
	return colors;
}

function styleFor(rules: readonly TokenRule[], scope: string): TokenStyle | undefined {
	let best: { depth: number; foreground?: string; fontStyle?: string } | undefined;
	for (const rule of rules) {
		const selectors = typeof rule.scope === 'string' ? rule.scope.split(',') : rule.scope ?? [];
		for (const raw of selectors) {
			const selector = raw.trim();
			// Descendant and exclusion selectors need the whole scope stack; a code block has none.
			if (!selector || /\s/.test(selector)) {
				continue;
			}
			if (scope !== selector && !scope.startsWith(selector + '.')) {
				continue;
			}
			const depth = selector.split('.').length;
			if (!best || depth >= best.depth) {
				// A later rule as specific as an earlier one overrides only what it sets.
				best = depth === best?.depth
					? { depth, foreground: rule.settings?.foreground ?? best.foreground, fontStyle: rule.settings?.fontStyle ?? best.fontStyle }
					: { depth, foreground: rule.settings?.foreground, fontStyle: rule.settings?.fontStyle };
			}
		}
	}
	if (!best?.foreground) {
		return undefined;
	}
	return { color: best.foreground, ...(best.fontStyle?.includes('italic') ? { italic: true } : {}) };
}

/**
 * A theme file's token colours, its `include`s first. Themes that keep
 * their colours in a .tmTheme file, or files that cannot be read, give none.
 */
export async function readThemeRules(file: string, depth = 0): Promise<TokenRule[]> {
	if (depth > 5) {
		return [];
	}
	let theme: { include?: unknown; tokenColors?: unknown };
	try {
		theme = JSON.parse(stripJsonComments(await fs.readFile(file, 'utf8')));
	} catch {
		return [];
	}
	const included = typeof theme.include === 'string' ? await readThemeRules(path.join(path.dirname(file), theme.include), depth + 1) : [];
	const own = Array.isArray(theme.tokenColors) ? theme.tokenColors as TokenRule[] : [];
	return [...included, ...own];
}
