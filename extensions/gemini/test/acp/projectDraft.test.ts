/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanDraft, draftRequest, repoFacts } from '../../src/acp/projectDraft';

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-draft-'));
});

afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('project memory drafts', () => {
	it('reads what says what a repository is, and its top folders', async () => {
		const repo = path.join(root, 'shop');
		await fs.mkdir(path.join(repo, 'src'), { recursive: true });
		await fs.mkdir(path.join(repo, 'node_modules'));
		await fs.mkdir(path.join(repo, '.git'));
		await fs.writeFile(path.join(repo, 'README.md'), '# Shop\n\nThe checkout.');
		await fs.writeFile(path.join(repo, 'package.json'), '{"name":"shop"}');
		await fs.writeFile(path.join(repo, 'AGENTS.md'), ' ');
		const facts = await repoFacts({ key: 'shop', folder: repo });
		expect(facts.top).toEqual(['AGENTS.md', 'package.json', 'README.md', 'src/']);
		expect(facts.files.map(file => file.name)).toEqual(['README.md', 'package.json']);
	});

	it('asks for how the repositories connect when there are several', () => {
		const one = draftRequest([{ key: 'shop', top: ['src/'], files: [{ name: 'README.md', text: 'The checkout.' }] }]);
		expect(one.system).toContain('what the repository is for');
		expect(one.prompt).toBe('<repository name="shop">\nTop level: src/\n<file name="README.md">\nThe checkout.\n</file>\n</repository>');
		const two = draftRequest([{ key: 'shop', top: [], files: [] }, { key: 'cms', top: [], files: [] }]);
		expect(two.system).toContain('where the repositories meet');
		expect(two.prompt).toContain('Top level: (empty)');
	});

	it('drops a fence or heading around the draft', () => {
		expect(cleanDraft('```markdown\nshop reads cms.\n```')).toBe('shop reads cms.');
		expect(cleanDraft('# Project notes\n\n- one')).toBe('- one');
	});
});
