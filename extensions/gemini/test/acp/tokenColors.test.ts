/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchTokenColors, readThemeRules } from '../../src/acp/tokenColors';

describe('matchTokenColors', () => {
	it('picks the most specific matching selector, the later rule on a tie', () => {
		const colors = matchTokenColors([
			{ scope: 'keyword', settings: { foreground: '#111111' } },
			{ scope: 'keyword.control', settings: { foreground: '#222222' } },
			{ scope: ['string', 'comment'], settings: { foreground: '#333333' } },
			{ scope: 'comment', settings: { foreground: '#444444', fontStyle: 'italic' } },
			{ scope: 'source.ts entity.name.function', settings: { foreground: '#555555' } },
		]);
		expect(colors.keyword).toEqual({ color: '#111111' });
		expect(colors.string).toEqual({ color: '#333333' });
		expect(colors.comment).toEqual({ color: '#444444', italic: true });
		expect(colors.function).toBeUndefined();
	});

	it('falls back to the next scope of a category', () => {
		expect(matchTokenColors([{ scope: 'support.function', settings: { foreground: '#666666' } }]).function).toEqual({ color: '#666666' });
	});
});

describe('readThemeRules', () => {
	it('reads Dark Modern with the themes it includes', async () => {
		const rules = await readThemeRules(path.join(__dirname, '../../../theme-defaults/themes/dark_modern.json'));
		const colors = matchTokenColors(rules);
		expect(colors.string?.color?.toLowerCase()).toBe('#ce9178');
		expect(colors.keyword?.color?.toLowerCase()).toBe('#569cd6');
		expect(colors.comment?.color?.toLowerCase()).toBe('#6a9955');
	});

	it('reads a missing file as no rules', async () => {
		expect(await readThemeRules('/nonexistent/theme.json')).toEqual([]);
	});
});
