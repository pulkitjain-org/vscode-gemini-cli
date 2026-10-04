/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { branchExists, commitAll, createWorktree, currentBranch, freeFolder, git, mergeBranch, removeWorktree, repositoryRoot, worktreesHome, worktreeStatus } from '../../src/acp/worktrees';

let root: string;
let repo: string;
let home: string;

beforeAll(() => {
	Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' });
});

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worktrees-')));
	repo = path.join(root, 'shop');
	home = path.join(root, 'home');
	await fs.mkdir(path.join(repo, 'src'), { recursive: true });
	await git(repo, ['init', '--quiet', '--initial-branch=main']);
	await fs.writeFile(path.join(repo, 'src', 'cart.ts'), 'export const total = 1;\n');
	await commitAll(repo, 'Initial');
});

afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('worktrees', () => {
	it('makes a branch in its own folder outside the repository', async () => {
		expect(await repositoryRoot(path.join(repo, 'src'))).toBe(repo);
		expect(await repositoryRoot(root)).toBeUndefined();
		const worktree = await createWorktree(repo, 'gemini/fix-total', 'src', home);
		expect(worktree).toEqual({ folder: path.join(worktreesHome(repo, home), 'fix-total'), cwd: path.join(worktreesHome(repo, home), 'fix-total', 'src'), branch: 'gemini/fix-total', base: 'main' });
		expect(worktreesHome(repo, home)).toBe(path.join(home, '.geminicode', 'worktrees', 'shop'));
		expect(await fs.readFile(path.join(worktree.cwd, 'cart.ts'), 'utf8')).toBe('export const total = 1;\n');
		expect(await currentBranch(worktree.folder)).toBe('gemini/fix-total');
		expect(await currentBranch(repo)).toBe('main');
		expect(await branchExists(repo, 'gemini/fix-total')).toBe(true);
		expect(await freeFolder(worktreesHome(repo, home), 'other/fix-total')).toBe(path.join(worktreesHome(repo, home), 'fix-total-2'));
	});

	it('merges the agent\'s work back after committing it', async () => {
		const worktree = await createWorktree(repo, 'gemini/fix-total', '', home);
		expect(await worktreeStatus(worktree, 'main')).toEqual({ uncommitted: 0, commits: 0 });
		await fs.writeFile(path.join(worktree.folder, 'src', 'cart.ts'), 'export const total = 2;\n');
		await fs.writeFile(path.join(worktree.folder, 'src', 'tax.ts'), 'export const tax = 0;\n');
		expect(await worktreeStatus(worktree, 'main')).toEqual({ uncommitted: 2, commits: 0 });
		await commitAll(worktree.folder, 'Fix the total');
		expect(await worktreeStatus(worktree, 'main')).toEqual({ uncommitted: 0, commits: 1 });
		expect(await mergeBranch(repo, worktree.branch)).toEqual({ kind: 'merged' });
		expect(await fs.readFile(path.join(repo, 'src', 'cart.ts'), 'utf8')).toBe('export const total = 2;\n');
		expect(await worktreeStatus(worktree, 'main')).toEqual({ uncommitted: 0, commits: 0 });
	});

	it('leaves a conflicting merge for the user to finish', async () => {
		const worktree = await createWorktree(repo, 'gemini/fix-total', '', home);
		await fs.writeFile(path.join(worktree.folder, 'src', 'cart.ts'), 'export const total = 2;\n');
		await commitAll(worktree.folder, 'Agent change');
		await fs.writeFile(path.join(repo, 'src', 'cart.ts'), 'export const total = 3;\n');
		await commitAll(repo, 'My change');
		expect(await mergeBranch(repo, worktree.branch)).toEqual({ kind: 'conflicts', files: ['src/cart.ts'] });
	});

	it('refuses a merge that local changes are in the way of', async () => {
		const worktree = await createWorktree(repo, 'gemini/fix-total', '', home);
		await fs.writeFile(path.join(worktree.folder, 'src', 'cart.ts'), 'export const total = 2;\n');
		await commitAll(worktree.folder, 'Agent change');
		await fs.writeFile(path.join(repo, 'src', 'cart.ts'), 'export const total = 3;\n');
		await expect(mergeBranch(repo, worktree.branch)).rejects.toThrow(/local changes/);
	});

	it('removes the folder, and the branch when asked, even with unmerged work', async () => {
		const worktree = await createWorktree(repo, 'gemini/fix-total', '', home);
		await fs.writeFile(path.join(worktree.folder, 'new.ts'), 'x\n');
		await removeWorktree(repo, worktree, false);
		await expect(fs.access(worktree.folder)).rejects.toThrow();
		expect(await branchExists(repo, 'gemini/fix-total')).toBe(true);

		const second = await createWorktree(repo, 'gemini/second', '', home);
		await fs.rm(second.folder, { recursive: true });
		await removeWorktree(repo, second, true);
		expect(await branchExists(repo, 'gemini/second')).toBe(false);
		expect(await git(repo, ['worktree', 'list'])).not.toContain('second');
	});
});
