/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { groupLines } from '../../../src/acp/index/fallbackSearch';

describe('groupLines', () => {
	const output = [
		'src\\cart.ts:12:total(cart)',
		'./src/cart.ts:3:export function total(cart: Cart) {',
		'./src/cart.ts:4:\treturn cart.items.length;',
		'./src/basket.ts:7:// total of the basket',
		'README.md:1:Cart TOTAL',
		'not a match line',
	].join('\n');

	it('groups adjacent lines per file, files with more of the words first', () => {
		expect(groupLines(output, ['total', 'cart'], 10)).toEqual({
			hits: [
				{ path: 'src/cart.ts', startLine: 3, endLine: 4, text: 'export function total(cart: Cart) {\n\treturn cart.items.length;' },
				{ path: 'src/cart.ts', startLine: 12, endLine: 12, text: 'total(cart)' },
				{ path: 'README.md', startLine: 1, endLine: 1, text: 'Cart TOTAL' },
				{ path: 'src/basket.ts', startLine: 7, endLine: 7, text: '// total of the basket' },
			],
			total: 4,
			terms: ['total', 'cart'],
		});
	});

	it('returns at most `limit` hits but counts them all', () => {
		const result = groupLines(output, ['total'], 1);
		expect({ paths: result.hits.map(h => h.path), total: result.total }).toEqual({ paths: ['src/cart.ts'], total: 4 });
	});

	it('finds nothing in empty output', () => {
		expect(groupLines('', ['total'], 5)).toEqual({ hits: [], total: 0, terms: ['total'] });
	});
});
