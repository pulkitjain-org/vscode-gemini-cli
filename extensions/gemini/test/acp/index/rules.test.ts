/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { pairsFromLog } from '../../../src/acp/index/cochange';
import { identifierWords, splitIdentifier } from '../../../src/acp/index/identifiers';
import { IgnoreRules } from '../../../src/acp/index/ignore';
import { canInclude, contentSkipReason, pathSkipReason, SkipRules } from '../../../src/acp/index/inventory';
import { isTestPath, queryTerms } from '../../../src/acp/index/query';
import { resolveImport } from '../../../src/acp/index/resolve';

describe('IgnoreRules', () => {
	it('matches names at any depth, anchored paths, folders, ** and negation', () => {
		const rules = new IgnoreRules(['# comment', '*.log', '/dist', 'tmp/', 'docs/**/draft-*.md', '!keep.log']);
		const ignored = ['a.log', 'src/b.log', 'dist/x.js', 'tmp/a.txt', 'src/tmp/a.txt', 'docs/a/b/draft-1.md'].filter(p => rules.ignores(p));
		expect(ignored).toEqual(['a.log', 'src/b.log', 'dist/x.js', 'tmp/a.txt', 'src/tmp/a.txt', 'docs/a/b/draft-1.md']);
		expect(['keep.log', 'src/dist/x.js', 'tmpfile', 'docs/draft.md'].filter(p => rules.ignores(p))).toEqual([]);
	});
});

describe('inventory filters', () => {
	it('leaves out secrets, lock files, binaries and generated files by path', () => {
		const rules = new IgnoreRules([]);
		expect(['.env', 'config/.env.local', 'id_rsa', 'package-lock.json', 'icon.png', 'app.min.js', 'src/a.ts'].map(p => pathSkipReason(p, rules))).toEqual([
			'.env may contain secrets', '.env.local may contain secrets', 'id_rsa may contain secrets', 'a lock file', 'a binary file type', 'generated', undefined,
		]);
	});

	it('leaves out binary and minified content', () => {
		expect(contentSkipReason('abc\0def')).toBe('binary content');
		expect(contentSkipReason('x'.repeat(5000))).toBe('generated (very long lines)');
		expect(contentSkipReason('const a = 1;\n')).toBeUndefined();
	});
});

describe('SkipRules', () => {
	it('indexes included files anyway, except secrets and binary content', () => {
		const rules = new SkipRules(['fixtures/'], ['fixtures/keep.ts', 'package-lock.json', '/big.json', 'app.min.js', '.env', 'bin.dat'], 1024);
		expect([
			rules.pathReason('fixtures/keep.ts'), rules.pathReason('fixtures/other.ts'), rules.pathReason('package-lock.json'), rules.pathReason('.env'),
			rules.sizeReason('big.json', 4096), rules.sizeReason('other.json', 4096), rules.sizeReason('big.json', 32 * 1024 * 1024),
			rules.contentReason('app.min.js', 'x'.repeat(5000)), rules.contentReason('bin.dat', 'a\0b'), rules.contentReason('other.js', 'x'.repeat(5000)),
		]).toEqual([
			undefined, 'excluded by .geminiignore or gemini.index.exclude', undefined, '.env may contain secrets',
			undefined, 'larger than 1 KB', 'larger than 16384 KB',
			undefined, 'binary content', 'generated (very long lines)',
		]);
	});

	it('says which left-out files can be included', () => {
		expect([canInclude('src/big.json', 'larger than 1024 KB'), canInclude('.env', '.env may contain secrets'), canInclude('a.bin', 'binary content')]).toEqual([true, false, false]);
	});
});

describe('identifiers and queries', () => {
	it('splits camelCase and acronyms into words', () => {
		expect(splitIdentifier('parseHTTPResponse2')).toEqual(['parse', 'http', 'response2']);
		expect(identifierWords('const applyDiscount = getHTMLNode(x_y);')).toBe('apply discount get html node');
	});

	it('builds a full-text query that matches words, camelCase and snake_case names', () => {
		expect(queryTerms('where is applyDiscount used for the cart_total?')).toEqual({
			groups: ['("applydiscount"* OR (idents:"apply" AND idents:"discount"))', '"used"*', '("cart" AND "total")'],
			words: ['applydiscount', 'apply', 'discount', 'used', 'cart_total', 'cart', 'total'],
		});
	});
});

describe('isTestPath', () => {
	it('knows tests by folder and by name in common languages', () => {
		const paths = ['src/test/java/com/acme/CartTest.java', 'src/cart.test.ts', 'src/__tests__/cart.ts', 'cart_test.go', 'tests/test_cart.py', 'e2e/checkout.spec.ts', 'src/main/java/com/acme/Cart.java', 'src/testing.ts', 'src/contest/entry.ts'];
		expect(paths.filter(isTestPath)).toEqual(paths.slice(0, 6));
	});
});

describe('resolveImport', () => {
	const files = ['src/cart/cart.ts', 'src/cart/index.ts', 'src/util.js', 'shop/models.py', 'shop/__init__.py', 'src/main/java/com/acme/Cart.java', 'src/lib/mod.rs', 'src/lib/parser.rs', 'include/acme.h'];
	const known = { has: (p: string) => files.includes(p), named: (base: string) => files.filter(f => f.endsWith(`/${base}`) || f === base) };

	it('resolves relative script imports, Python and Java modules, Rust mods and C includes', () => {
		expect([
			resolveImport('src/cart/discount.ts', './cart', 'typescript', known),
			resolveImport('src/app.ts', './cart', 'typescript', known),
			resolveImport('src/cart/x.ts', '../util.js', 'typescript', known),
			resolveImport('src/app.ts', 'react', 'typescript', known),
			resolveImport('shop/views.py', '.models', 'python', known),
			resolveImport('app.py', 'shop.models', 'python', known),
			resolveImport('x/App.java', 'com.acme.Cart', 'java', known),
			resolveImport('src/lib/mod.rs', 'parser', 'rust', known),
			resolveImport('src/main.c', 'acme.h', 'c', known),
		]).toEqual(['src/cart/cart.ts', 'src/cart/index.ts', 'src/util.js', undefined, 'shop/models.py', 'shop/models.py', 'src/main/java/com/acme/Cart.java', 'src/lib/parser.rs', 'include/acme.h']);
	});
});

describe('pairsFromLog', () => {
	it('counts files changed together at least twice, ignoring huge commits', () => {
		const big = Array.from({ length: 40 }, (_, i) => `f${i}.ts`).join('\n');
		const log = `\0\na.ts\nb.ts\n\0\na.ts\nb.ts\nc.ts\n\0\n${big}\n\0\nc.ts\n`;
		expect([...pairsFromLog(log)]).toEqual([['a.ts\0b.ts', 2]]);
	});
});
