/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { branchExists, commitAll, createWorktree, createWorktreeFrom, currentBranch, folderInRepository, folderSize, freeFolder, git, mainRepository, mergeBranch, mergeRefusal, pathExists, removeWorktree, repositoryRoot, restoreWorktree, unfinishedOperation, worktreesHome, worktreeStatus } from '../../src/acp/worktrees';

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
	it('commits on an agent\'s behalf without running the checkout\'s hooks', async () => {
		const hooks = path.join(repo, 'hooks');
		await fs.mkdir(hooks);
		await fs.writeFile(path.join(hooks, 'pre-commit'), `#!/bin/sh\ntouch "${path.join(root, 'hook-ran')}"\nexit 1\n`, { mode: 0o755 });
		await fs.writeFile(path.join(hooks, 'post-commit'), `#!/bin/sh\ntouch "${path.join(root, 'hook-ran')}"\n`, { mode: 0o755 });
		await git(repo, ['config', 'core.hooksPath', 'hooks']);
		await fs.writeFile(path.join(repo, 'src', 'cart.ts'), 'export const total = 2;\n');
		await commitAll(repo, 'Total');
		expect({ ran: await pathExists(path.join(root, 'hook-ran')), subject: (await git(repo, ['log', '-1', '--format=%s'])).trim() }).toEqual({ ran: false, subject: 'Total' });
	});

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

	it('finds a folder inside its repository through a symlink', async () => {
		const link = path.join(root, 'link');
		await fs.symlink(repo, link);
		expect(await folderInRepository(path.join(link, 'src'))).toBe('src');
		expect(await folderInRepository(link)).toBe('');
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

describe('forking a worktree', () => {
	it('branches from the parent with its uncommitted and untracked changes, leaving the parent as it is', async () => {
		const parent = await createWorktree(repo, 'gemini/refunds', 'src', home);
		await fs.writeFile(path.join(parent.folder, 'src', 'cart.ts'), 'export const total = 2;\n');
		await git(parent.folder, ['add', 'src/cart.ts']);
		await fs.writeFile(path.join(parent.folder, 'src', 'cart.ts'), 'export const total = 3;\n');
		await fs.mkdir(path.join(parent.folder, 'src', 'new'));
		await fs.writeFile(path.join(parent.folder, 'src', 'new', 'refund.ts'), 'export const refund = 0;\n');
		await fs.writeFile(path.join(parent.folder, '.gitignore'), 'build/\n');
		await fs.mkdir(path.join(parent.folder, 'build'));
		await fs.writeFile(path.join(parent.folder, 'build', 'out.js'), 'ignored');
		const parentStatus = await git(parent.folder, ['status', '--porcelain']);

		expect(await mainRepository(parent.folder)).toBe(repo);
		const child = await createWorktreeFrom(parent.cwd, 'gemini/refunds-fork', 'src', home);
		expect(child).toEqual({ folder: path.join(worktreesHome(repo, home), 'refunds-fork'), cwd: path.join(worktreesHome(repo, home), 'refunds-fork', 'src'), branch: 'gemini/refunds-fork', base: 'gemini/refunds' });
		expect(await fs.readFile(path.join(child.cwd, 'cart.ts'), 'utf8')).toBe('export const total = 3;\n');
		expect(await fs.readFile(path.join(child.cwd, 'new', 'refund.ts'), 'utf8')).toBe('export const refund = 0;\n');
		expect(await pathExists(path.join(child.folder, 'build'))).toBe(false);
		expect(await git(parent.folder, ['status', '--porcelain'])).toBe(parentStatus);
		expect(await git(repo, ['stash', 'list'])).toBe('');
		// The child's branch starts where the parent's is, so merging it back brings only its own work.
		expect((await git(child.folder, ['rev-parse', 'HEAD'])).trim()).toBe((await git(parent.folder, ['rev-parse', 'HEAD'])).trim());
	});

	it('forks a clean workspace folder too, and refuses one in the middle of a merge, leaving nothing behind', async () => {
		const child = await createWorktreeFrom(repo, 'gemini/clean', '', home);
		expect(child.base).toBe('main');
		expect(await git(child.folder, ['status', '--porcelain'])).toBe('');

		await git(repo, ['checkout', '--quiet', '-b', 'other']);
		await fs.writeFile(path.join(repo, 'src', 'cart.ts'), 'export const total = 5;\n');
		await commitAll(repo, 'Other');
		await git(repo, ['checkout', '--quiet', 'main']);
		await fs.writeFile(path.join(repo, 'src', 'cart.ts'), 'export const total = 6;\n');
		await commitAll(repo, 'Main');
		await git(repo, ['merge', 'other']).catch(() => undefined);
		expect(await unfinishedOperation(repo)).toBe('merge');
		expect(await mergeRefusal(repo)).toBe('merge');
		await expect(createWorktreeFrom(repo, 'gemini/mid-merge', '', home)).rejects.toThrow(/middle of a merge/);
		expect(await branchExists(repo, 'gemini/mid-merge')).toBe(false);
	});

	it('refuses a merge into a checkout with no branch, and allows one on a branch', async () => {
		expect(await mergeRefusal(repo)).toBeUndefined();
		await git(repo, ['checkout', '--quiet', '--detach']);
		expect(await mergeRefusal(repo)).toBe('detached');
	});
});

describe('cleaning up a merged worktree', () => {
	it('puts the folder back on its branch, with the work it had', async () => {
		const worktree = await createWorktree(repo, 'gemini/fix', '', home);
		await fs.writeFile(path.join(worktree.folder, 'src', 'cart.ts'), 'export const total = 2;\n');
		await commitAll(worktree.folder, 'Fix');
		await fs.mkdir(path.join(worktree.folder, 'node_modules', 'pkg'), { recursive: true });
		await fs.writeFile(path.join(worktree.folder, 'node_modules', 'pkg', 'index.js'), 'x'.repeat(1000));
		expect(await folderSize(worktree.folder)).toBeGreaterThanOrEqual(1000);
		await removeWorktree(repo, worktree, false);
		expect(await folderSize(worktree.folder)).toBe(0);
		expect(await restoreWorktree(repo, worktree)).toBe(true);
		expect(await fs.readFile(path.join(worktree.folder, 'src', 'cart.ts'), 'utf8')).toBe('export const total = 2;\n');
		expect(await currentBranch(worktree.folder)).toBe('gemini/fix');
		expect(await worktreeStatus(worktree, 'main')).toEqual({ uncommitted: 0, commits: 1 });
		// There already: nothing to do.
		expect(await restoreWorktree(repo, worktree)).toBe(true);
	});

	it('cannot put a folder back once its branch is gone', async () => {
		const worktree = await createWorktree(repo, 'gemini/gone', '', home);
		await removeWorktree(repo, worktree, true);
		expect(await restoreWorktree(repo, worktree)).toBe(false);
	});
});
