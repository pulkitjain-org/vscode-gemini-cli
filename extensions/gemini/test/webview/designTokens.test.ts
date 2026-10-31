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
