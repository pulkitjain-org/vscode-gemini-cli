/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Every page's stylesheet draws from media/tokens.css: sizes, radii, shadows
// and durations come from the scale, never from a number of its own, so the
// pages read as one. The third-party sheets (KaTeX, codicons) are theirs.

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const media = path.join(__dirname, '..', '..', 'media');
const own = readdirSync(media).filter(file => file.endsWith('.css') && !/^(katex|codicon|tokens)/.test(file));

/** Each declaration in `css` with the property named, without comments. */
function declarations(css: string, property: string): string[] {
	const pattern = new RegExp(`(?<![\\w-])${property}\\s*:\\s*([^;}]+)`, 'g');
	return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(pattern)].map(match => match[1].trim());
}

describe('design tokens', () => {
	it('declares the scale once', () => {
		const tokens = readFileSync(path.join(media, 'tokens.css'), 'utf8');
		for (const token of ['--gc-text-md', '--gc-space-4', '--gc-radius-md', '--gc-radius-pill', '--gc-control', '--gc-menu-row', '--gc-focus-ring', '--gc-shadow', '--gc-motion']) {
			expect(tokens, token).toContain(`${token}:`);
		}
	});

	it('loads tokens.css on every page whose own HTML loads panels.css', () => {
		// Without it every size in panels.css is unset and the page falls back to the browser's 16px (the Changes panel did).
		const host = path.join(__dirname, '..', '..', 'src', 'host');
		const pages = readdirSync(host, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts'));
		const missing = pages.filter(file => {
			const source = readFileSync(path.join(host, file), 'utf8');
			return source.includes('\'panels.css\'') && !source.includes('\'tokens.css\'');
		});
		expect(missing).toEqual([]);
	});

	it.each(own.filter(file => file !== 'glass.css'))('%s defines no control, radius alias or focus ring of its own', file => {
		// The pill, the button set and the tabs are tokens.css's, as is the focus ring; a page adds colour modifiers
		// (`.plan-pill.cm`, `.permission-actions button.reject`) and scoped sizes (`.dash-row > button.secondary`) only.
		// glass.css is the one sheet that restyles them, for every page at once.
		const css = readFileSync(path.join(media, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
		const shared = /^(button)?\.(pill|dash-pill|state-pill|plan-pill|permission-pill|primary|secondary|quiet|link-button|link|icon-button|small|tabs|tab|page-tab|composer-tab)(:hover(:not\(:disabled\))?|:disabled|\.(ok|warn|error|info|muted|active)|\[aria-selected="true"\])?$/;
		const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(match => match[1].split(',').map(selector => selector.trim().replace(/\s+/g, ' ')));
		const offenders = [
			...selectors.filter(selector => shared.test(selector)).map(selector => `control: ${selector}`),
			...selectors.filter(selector => /:focus(-visible)?$/.test(selector) && new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{[^}]*outline:\\s*(?!\\s*none)`).test(css)).map(selector => `focus ring: ${selector}`),
			...declarations(css, '--gemini-radius(-small|-large)?').map(value => `radius alias: ${value}`),
		];
		expect(offenders).toEqual([]);
	});

	it.each(own)('%s writes no size, radius, shadow or duration of its own', file => {
		const css = readFileSync(path.join(media, file), 'utf8');
		// A size relative to its text (em, %) scales a reply's headings and the like with the page; absolute ones come from the scale.
		const literal = (value: string) => /^-?\d/.test(value) && !/(em|%)$/.test(value) && !/^0(px)?$/.test(value);
		const offenders = [
			...declarations(css, 'font-size').filter(literal).map(value => `font-size: ${value}`),
			...declarations(css, 'border-radius').filter(value => /\d/.test(value) && !value.includes('var(') && !/^(0|50%)$/.test(value)).map(value => `border-radius: ${value}`),
			...declarations(css, 'box-shadow').filter(value => !value.includes('var(--gc-') && value !== 'none').map(value => `box-shadow: ${value}`),
			...declarations(css, 'transition').filter(value => /\d+m?s/.test(value)).map(value => `transition: ${value}`),
			...declarations(css, 'transition-duration').filter(value => /\d/.test(value)).map(value => `transition-duration: ${value}`),
		];
		expect(offenders).toEqual([]);
	});
});
