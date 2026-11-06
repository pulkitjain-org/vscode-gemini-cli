/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { fileNamePattern, knownFileNamed } from '../../src/acp/folderFiles';

describe('knownFileNamed', () => {
	it('finds a file the chat wrote outside its folder by the name a reply gives it, the latest first', () => {
		const known = ['/home/u/.gemini/tmp/p/s1/plans/proposal.md', '/home/u/.gemini/tmp/p/s2/plans/proposal.md', '/home/u/.gemini/tmp/p/s2/plans/other.md'];
		expect(['proposal.md', './plans/other.md', 's1/plans/proposal.md', 'posal.md', '../proposal.md', 'plans/../other.md', ''].map(name => knownFileNamed(name, known))).toEqual([
			'/home/u/.gemini/tmp/p/s2/plans/proposal.md', '/home/u/.gemini/tmp/p/s2/plans/other.md', '/home/u/.gemini/tmp/p/s1/plans/proposal.md', undefined, '/home/u/.gemini/tmp/p/s2/plans/proposal.md', undefined, undefined,
		]);
	});
});

describe('fileNamePattern', () => {
	it('finds a file a reply names anywhere in the folder, matching glob characters as any one character', () => {
		expect(['cart.ts', './src/cart.ts', '../../cart.ts', 'a[1]{b}*?!.ts'].map(fileNamePattern)).toEqual([
			'**/cart.ts', '**/src/cart.ts', '**/cart.ts', '**/a?1??b????.ts',
		]);
	});
});
