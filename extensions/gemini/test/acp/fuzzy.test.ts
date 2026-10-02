/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { combineGlobs, indexPath, rankPaths } from '../../src/acp/fuzzy';

const paths = ['src/chatView.ts', 'src/host/chatProtocol.ts', 'test/chat.test.ts', 'README.md', 'src\\acp\\agentClient.ts'].map(indexPath);

describe('rankPaths', () => {
	it('ranks file-name matches first and drops non-matches', () => {
		expect(rankPaths('chatv', paths, 10).map(p => p.relative)).toEqual(['src/chatView.ts']);
		expect(rankPaths('chat', paths, 10).map(p => p.relative)).toEqual(['src/chatView.ts', 'test/chat.test.ts', 'src/host/chatProtocol.ts']);
	});

	it('matches across folders, ignores case and normalises separators', () => {
		expect(rankPaths('HOST/CP', paths, 10).map(p => p.relative)).toEqual(['src/host/chatProtocol.ts']);
		expect(rankPaths('acp\\agent', paths, 10).map(p => p.relative)).toEqual(['src/acp/agentClient.ts']);
	});

	it('returns everything, shortest first, for an empty query, up to the limit', () => {
		expect(rankPaths('', paths, 2).map(p => p.relative)).toEqual(['README.md', 'src/chatView.ts']);
	});
});

describe('combineGlobs', () => {
	it('joins patterns into one group, expanding their own braces', () => {
		expect(combineGlobs(['**/node_modules', '**/*.{js,map}', '**/{a,b}/{c,d}'])).toBe('{**/node_modules,**/*.js,**/*.map,**/a/c,**/a/d,**/b/c,**/b/d}');
		expect(combineGlobs([])).toBeUndefined();
	});
});
