/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { mathPlugin } from '../../webview-src/mathRule';

const md = new MarkdownIt().use(mathPlugin);

describe('mathPlugin', () => {
	it('marks inline math in each form', () => {
		expect(md.renderInline('area $\\pi r^2$ here')).toBe('area <span class="math" data-tex="\\pi r^2">$\\pi r^2$</span> here');
		expect(md.renderInline('so \\(a+b\\) holds')).toContain('data-tex="a+b"');
		expect(md.renderInline('so $$x$$ too')).toContain('data-tex="x"');
	});

	it('leaves prices, variables and spaced dollars as text', () => {
		for (const text of ['costs $5 and $10 today', 'echo $HOME', 'a $ b $ c', 'only $ one', 'Prices like $5 and $10 stay as text, and so does `$HOME`.']) {
			expect(md.renderInline(text)).not.toContain('class="math"');
		}
	});

	it('keeps math inside code as code', () => {
		expect(md.renderInline('`$x$`')).toBe('<code>$x$</code>');
		expect(md.render('```\n$$x$$\n```\n')).not.toContain('class="math"');
	});

	it('marks display blocks over one or more lines', () => {
		expect(md.render('$$\na^2 + b^2\n$$\n')).toBe('<div class="math math-display" data-tex="a^2 + b^2">a^2 + b^2</div>\n');
		expect(md.render('\\[x = 1\\]\n')).toContain('class="math math-display" data-tex="x = 1"');
	});

	it('escapes the TeX source', () => {
		expect(md.renderInline('$a<b$')).toContain('data-tex="a&lt;b"');
	});

	it('leaves an unclosed block as text', () => {
		expect(md.render('$$\nx\n')).not.toContain('class="math');
	});
});
