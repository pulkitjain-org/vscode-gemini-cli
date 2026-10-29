/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { parseFile } from '../../../src/acp/index/parse';

const symbolsOf = (relative: string, text: string) => parseFile(relative, text).symbols.map(s => `${s.kind} ${s.container ? `${s.container}.` : ''}${s.name} ${s.line}-${s.endLine}${s.exported ? ' exported' : ''}`);

describe('parseFile', () => {
	it('finds TypeScript definitions, and methods only at a class\'s member indentation', () => {
		const text = [
			'import { a } from \'./a\';',
			'export interface Cart { total: number }',
			'export type Code = string;',
			'/** Applies a code. */',
			'export function applyDiscount(cart: Cart, code: Code): Cart {',
			'\treturn helper(cart);',
			'}',
			'const helper = (cart: Cart) => cart;',
			'export class CartService',
			'\textends Base {',
			'\tprivate readonly x = 1;',
			'\tasync load(id: string): Promise<void> {',
			'\t\tif (id) {',
			'\t\t\tthis.save(id);',
			'\t\t}',
			'\t}',
			'\tsave(id: string) { }',
			'}',
			'export const LIMIT = 3;',
		].join('\n');
		expect(symbolsOf('src/cart.ts', text)).toEqual([
			'interface Cart 2-2 exported',
			'type Code 3-3 exported',
			'function applyDiscount 5-7 exported',
			'function helper 8-8',
			'class CartService 9-18 exported',
			'method CartService.load 12-16',
			'method CartService.save 17-17',
			'constant LIMIT 19-19 exported',
		]);
		expect(parseFile('src/cart.ts', text).imports).toEqual(['./a']);
	});

	it('reads Python classes, methods and constants by indentation', () => {
		const text = [
			'from .models import Cart',
			'import os.path',
			'MAX_ITEMS = 10',
			'class Basket:',
			'    """A basket."""',
			'    def add(self, item):',
			'        def inner():',
			'            pass',
			'        return inner',
			'',
			'    def _remove(self):',
			'        pass',
			'',
			'def total(basket):',
			'    return 0',
		].join('\n');
		expect(symbolsOf('shop/basket.py', text)).toEqual([
			'constant MAX_ITEMS 3-3 exported',
			'class Basket 4-12 exported',
			'method Basket.add 6-9 exported',
			'method Basket._remove 11-12',
			'function total 14-15 exported',
		]);
		expect(parseFile('shop/basket.py', text).imports).toEqual(['.models', 'os.path']);
	});

	it('takes a Go method\'s container from its receiver', () => {
		const text = 'package cart\n\ntype Cart struct {\n\tTotal int\n}\n\nfunc (c *Cart) Apply(code string) error {\n\treturn nil\n}\n\nfunc helper() {}\n';
		expect(symbolsOf('cart/cart.go', text)).toEqual([
			'struct Cart 3-5 exported',
			'method Cart.Apply 7-9 exported',
			'function helper 11-11',
		]);
	});

	it('keeps Java methods apart from statements, with Allman braces', () => {
		const text = [
			'package com.acme;',
			'import com.acme.model.Cart;',
			'public class CartService',
			'{',
			'    @Override',
			'    public Cart apply(Cart cart, String code) {',
			'        return discount(cart);',
			'    }',
			'    private int discount(Cart cart) { return 0; }',
			'}',
		].join('\n');
		expect(symbolsOf('src/main/java/com/acme/CartService.java', text)).toEqual([
			'class CartService 3-10 exported',
			'method CartService.apply 6-8 exported',
			'method CartService.discount 9-9',
		]);
		expect(parseFile('x.java', text).imports).toEqual(['com.acme.model.Cart']);
	});

	it('cuts Markdown at headings, skipping fenced code', () => {
		const text = '# Guide\n\nIntro.\n\n## Install\n\n```sh\n# not a heading\nnpm i\n```\n\n## Use\n\nRun it.\n';
		const parsed = parseFile('README.md', text);
		expect(parsed.symbols.map(s => s.name)).toEqual(['Guide', 'Install', 'Use']);
		expect(parsed.chunks.map(c => [c.startLine, c.endLine, c.symbol])).toEqual([[1, 14, 'Guide']]);
	});

	it('chunks at top-level definitions, with their comments, and windows long code', () => {
		const body = Array.from({ length: 150 }, (_, i) => `\tconst v${i} = ${i};`).join('\n');
		const text = `import x from 'x';\n\n// Big one.\nexport function big() {\n${body}\n}\n\nexport function small() {\n\treturn 1;\n}\n`;
		const chunks = parseFile('a.ts', text).chunks;
		expect(chunks.map(c => [c.startLine, c.endLine, c.symbol])).toEqual([
			[1, 1, undefined],
			[3, 62, 'big'],
			[58, 117, 'big'],
			[113, 155, 'big'],
			[157, 159, 'small'],
		]);
		expect(chunks[1].text.startsWith('// Big one.\nexport function big() {')).toBe(true);
	});

	it('parses a generated class with tens of thousands of members in linear time', () => {
		// Ends and chunk names used to look back over every earlier member: 312 ms for 16,000 methods, 21 ms now.
		const members = 32_000;
		const text = ['export class Generated {', ...Array.from({ length: members }, (_, i) => `\tmethod${i}(value: number): number { return value + ${i}; }`), '}'].join('\n');
		const started = performance.now();
		const parsed = parseFile('generated.ts', text);
		const elapsed = performance.now() - started;
		expect([parsed.symbols.length, parsed.symbols[1], parsed.symbols[members], parsed.chunks[1].symbol]).toEqual([
			members + 1,
			{ name: 'method0', kind: 'method', line: 2, endLine: 2, container: 'Generated', exported: false },
			{ name: `method${members - 1}`, kind: 'method', line: members + 1, endLine: members + 1, container: 'Generated', exported: false },
			'Generated.method39',
		]);
		expect(elapsed).toBeLessThan(500);
	});

	it('names a chunk inside a long definition after the innermost one around it', () => {
		const body = Array.from({ length: 100 }, (_, i) => `\t\tconst v${i} = ${i};`).join('\n');
		const text = `export class Outer {\n\tfirst() {\n\t\treturn 1;\n\t}\n\tlong() {\n${body}\n\t}\n}\n`;
		expect(parseFile('a.ts', text).chunks.map(c => [c.startLine, c.symbol])).toEqual([[1, 'Outer'], [5, 'Outer.long'], [60, 'Outer.long']]);
	});

	it('indexes a file of an unknown language by lines', () => {
		const parsed = parseFile('config/app.yaml', 'a: 1\nb: 2\n');
		expect(parsed).toEqual({ lang: 'yaml', symbols: [], imports: [], chunks: [{ startLine: 1, endLine: 2, symbol: undefined, text: 'a: 1\nb: 2' }] });
	});
});
