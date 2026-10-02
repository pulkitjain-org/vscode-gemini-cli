/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { stableEnd, thoughtPreview } from '../../webview-src/streaming';

describe('stableEnd', () => {
	it('ends after the last blank line', () => {
		const text = 'First paragraph.\n\nSecond one is still stream';
		expect(text.slice(0, stableEnd(text))).toBe('First paragraph.\n\n');
	});

	it('has nothing finished in the first block', () => {
		expect(stableEnd('Just started')).toBe(0);
		const blank = '\n\nLeading blank lines';
		expect(blank.slice(0, stableEnd(blank)).trim()).toBe('');
	});

	it('never ends inside a code fence', () => {
		const text = 'Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;';
		expect(text.slice(0, stableEnd(text))).toBe('Intro.\n\n');
	});

	it('ends after a closed code fence', () => {
		const text = 'Intro.\n\n~~~\nx\n\ny\n~~~\n\nAfter';
		expect(text.slice(0, stableEnd(text))).toBe('Intro.\n\n~~~\nx\n\ny\n~~~\n\n');
	});

	it('keeps a fence open until a long enough marker closes it', () => {
		const text = '````md\n```\n\nstill code';
		expect(stableEnd(text)).toBe(0);
	});
});

describe('thoughtPreview', () => {
	it('shows the latest bold heading', () => {
		expect(thoughtPreview('**Reading the code**\n\nI look at x.\n\n**Planning the fix**\n\nThen')).toBe('Planning the fix');
	});

	it('falls back to the latest line', () => {
		expect(thoughtPreview('first line\nsecond line\n')).toBe('second line');
		expect(thoughtPreview('')).toBe('');
	});
});
