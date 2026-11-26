/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { contextPack } from '../../src/acp/contextPack';

const none = { imports: [], importedBy: [], tests: [], changedWith: [], known: true };

describe('contextPack', () => {
	it('lists each changed file\'s tests, users and usual companions, paths only', () => {
		const users = Array.from({ length: 7 }, (_, i) => `src/u${i}.ts`);
		expect(contextPack([
			{ file: 'src/cart.ts', related: { ...none, tests: ['test/cart.test.ts'], importedBy: users, changedWith: [{ path: 'src/price.ts', count: 4 }] } },
			{ file: 'README.md', related: none },
			{ file: 'src/new.ts', related: { ...none, known: false } },
			{ file: 'src/x.ts' },
		], 40)?.split('\n')).toEqual([
			'What the workspace index knows around the changed files (the first 4 of 40), from the repository\'s main checkout. You can\'t search the index from here, so it comes with this prompt. Paths only: read what matters, such as the tests of a changed file and the callers a change could break.',
			'- src/cart.ts: tests: test/cart.test.ts; used by: src/u0.ts, src/u1.ts, src/u2.ts, src/u3.ts, src/u4.ts (+2 more); usually changed with: src/price.ts',
			'- README.md: no tests, users or usual companions in the index',
		]);
	});

	it('gives nothing when the index knows none of the files', () => {
		expect(contextPack([{ file: 'a.ts', related: { ...none, known: false } }, { file: 'b.ts' }])).toBeUndefined();
	});
});
