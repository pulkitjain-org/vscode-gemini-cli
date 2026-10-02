/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles } from '../../src/acp/folderFiles';
import { readGitHead } from '../../src/acp/gitHead';

function repo(head: string): string {
	const root = mkdtempSync(path.join(tmpdir(), 'git-head-'));
	mkdirSync(path.join(root, '.git'));
	writeFileSync(path.join(root, '.git', 'HEAD'), head);
	return root;
}

describe('readGitHead', () => {
	it('reads the branch, also from a subfolder', async () => {
		const root = repo('ref: refs/heads/feature/agents\n');
		mkdirSync(path.join(root, 'src'));
		expect(await readGitHead(root)).toBe('feature/agents');
		expect(await readGitHead(path.join(root, 'src'))).toBe('feature/agents');
	});

	it('shortens a detached commit', async () => {
		expect(await readGitHead(repo('0123456789abcdef0123456789abcdef01234567\n'))).toBe('0123456');
	});

	it('follows a worktree pointer', async () => {
		const main = repo('ref: refs/heads/main\n');
		const worktreeGitDir = path.join(main, '.git', 'worktrees', 'wt');
		mkdirSync(worktreeGitDir, { recursive: true });
		writeFileSync(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/wt-branch\n');
		const worktree = mkdtempSync(path.join(tmpdir(), 'git-wt-'));
		writeFileSync(path.join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`);
		expect(await readGitHead(worktree)).toBe('wt-branch');
	});
});

describe('listFiles', () => {
	it('walks a plain folder and skips dependency folders', async () => {
		const root = mkdtempSync(path.join(tmpdir(), 'list-files-'));
		mkdirSync(path.join(root, 'src'));
		mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
		writeFileSync(path.join(root, 'README.md'), '');
		writeFileSync(path.join(root, 'src', 'a.ts'), '');
		writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), '');
		// Not a repository, so git ls-files fails and the walk runs.
		expect((await listFiles(root)).sort()).toEqual(['README.md', 'src/a.ts']);
	});
});
