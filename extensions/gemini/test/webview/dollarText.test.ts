/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The fork's renderMath for upstream's rich Markdown editor (the editor that
// opens the Markdown files Gemini writes), tested here since it is pure.

import { describe, expect, it } from 'vitest';
import { isDollarProse } from '../../../markdown-language-features/markdown-editor-src/geminiDollarProse';

describe('isDollarProse', () => {
	it('treats prices as prose and real inline math as math', () => {
		expect([
			// "Takes $5 off the amount (never below $0)."
			isDollarProse('5 off the amount (never below ', false),
			// "between $ 5 and $10"
			isDollarProse(' 5 and ', false),
			isDollarProse('x^2', false),
			isDollarProse('\\frac{a}{b}', false),
			isDollarProse('a + b ', true),
			isDollarProse('', false),
		]).toEqual([true, true, false, false, false, false]);
	});
});
