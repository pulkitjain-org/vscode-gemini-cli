/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { fileIcon, maxRecents, sortEntries, withRecent, type TreeEntry } from '../../src/acp/agentFiles';

const entry = (name: string, folder = false): TreeEntry => ({ name, path: `/r/${name}`, folder, ignored: false });

describe('agent files', () => {
	it('sorts folders first, then files, by name as the Explorer does', () => {
		const sorted = sortEntries([entry('b.ts'), entry('src', true), entry('A.md'), entry('.gemini', true), entry('file10.txt'), entry('file9.txt')]);
		expect(sorted.map(each => each.name)).toEqual(['.gemini', 'src', 'A.md', 'b.ts', 'file9.txt', 'file10.txt']);
	});

	it('keeps recent files newest first, once each, up to the limit', () => {
		const many = Array.from({ length: maxRecents }, (_, i) => `/r/${i}`);
		expect([withRecent(['/r/a', '/r/b'], '/r/b'), withRecent(many, '/r/new').length]).toEqual([['/r/b', '/r/a'], maxRecents]);
	});

	it('picks an icon by the kind of file', () => {
		const names = ['README.md', 'package.json', 'app.ts', '.env', '.prettierrc', 'flake.toml', 'Dockerfile-frontend', 'logo.png', 'notes.txt'];
		expect(names.map(fileIcon)).toEqual(['markdown', 'json', 'file-code', 'gear', 'gear', 'gear', 'gear', 'file-media', 'file']);
	});
});
