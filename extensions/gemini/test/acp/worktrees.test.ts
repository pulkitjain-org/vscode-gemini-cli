/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allThreadsHome, branchExists, commitAll, createWorktree, createWorktreeAt, createWorktreeFrom, currentBranch, folderInRepository, folderSize, freeBranchName, freeFolder, git, gitNetworkProblem, inRepository, mainRepository, mergeBranch, pathExists, projectFolders, projectsHome, removeThreadFolder, removeWorktree, repositoryRoot, restoreWorktree, runWorktreeSetup, threadGuide, threadsHome, TurnQueue, unfinishedOperation, worktreeSetupCommand, worktreesHome, worktreeStatus, writeThreadGuide } from '../../src/acp/worktrees';

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
		await expect(createWorktreeFrom(repo, 'gemini/mid-merge', '', home)).rejects.toThrow(/middle of a merge/);
		expect(await branchExists(repo, 'gemini/mid-merge')).toBe(false);
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

describe('threads in several repositories', () => {
	it('puts a worktree of each repository side by side in the thread\'s folder', async () => {
		const cms = path.join(root, 'cms');
		await fs.mkdir(cms);
		await git(cms, ['init', '--quiet', '--initial-branch=trunk']);
		await fs.writeFile(path.join(cms, 'labels.json'), '{}\n');
		await commitAll(cms, 'Initial');
		const folder = path.join(threadsHome('p1', home), 'gift');
		expect(threadsHome('p/1', home)).toBe(path.join(allThreadsHome(home), 'p-1'));
		const shop = await createWorktreeAt(repo, 'gemini/gift', path.join(folder, 'shop'));
		const content = await createWorktreeAt(cms, 'gemini/gift', path.join(folder, 'cms'));
		expect(shop).toEqual({ folder: path.join(folder, 'shop'), cwd: path.join(folder, 'shop'), branch: 'gemini/gift', base: 'main' });
		expect(content.base).toBe('trunk');
		expect(await currentBranch(content.folder)).toBe('gemini/gift');
		await writeThreadGuide(folder, threadGuide([{ key: 'shop' }, { key: 'cms', about: 'the content' }], 'gemini/gift', 'shop reads cms labels.'));
		const guide = await fs.readFile(path.join(folder, 'GEMINI.md'), 'utf8');
		expect(guide).toContain('- `shop/`\n- `cms/`: the content');
		expect(guide).toContain('all on the branch `gemini/gift`');
		expect(guide).toContain('# Project memory');
		expect(guide).toContain('shop reads cms labels.');
		expect(await fs.readFile(path.join(folder, '.geminiignore'), 'utf8')).toContain('node_modules/');
		// The thread's folder is not a repository of its own.
		expect(await repositoryRoot(folder)).toBeUndefined();
	});

	it('names a branch free in every repository, and removes the thread\'s worktrees and folder', async () => {
		const cms = path.join(root, 'cms');
		await fs.mkdir(cms);
		await git(cms, ['init', '--quiet', '--initial-branch=main']);
		await fs.writeFile(path.join(cms, 'labels.json'), '{}\n');
		await commitAll(cms, 'Initial');
		await git(cms, ['branch', 'gemini/gift']);
		await git(cms, ['branch', 'gemini/gift-2']);
		const branch = await freeBranchName([repo, cms], 'gemini/gift');
		const folder = path.join(threadsHome('p1', home), 'gift');
		const repos = await Promise.all([repo, cms].map(async repository => ({ ...await createWorktreeAt(repository, branch, path.join(folder, path.basename(repository))), key: path.basename(repository), repository })));
		await removeThreadFolder(repos, folder, true, home);
		expect({
			branch,
			free: await freeBranchName([repo], 'gemini/other'),
			folder: await pathExists(folder),
			threadsHome: await pathExists(threadsHome('p1', home)),
			branches: [await branchExists(repo, branch), await branchExists(cms, branch)],
		}).toEqual({ branch: 'gemini/gift-3', free: 'gemini/other', folder: false, threadsHome: true, branches: [false, false] });
	});

	it('leaves the memory out of the guide when there is none', () => {
		expect(threadGuide([{ key: 'shop' }], 'b')).not.toContain('# Project memory');
	});
});

describe('worktree setup', () => {
	it('uses the setting, else the repository\'s own script, else nothing', async () => {
		expect(await worktreeSetupCommand(repo, '  npm ci  ')).toBe('npm ci');
		expect(await worktreeSetupCommand(repo, '')).toBeUndefined();
		await fs.mkdir(path.join(repo, '.gemini'));
		await fs.writeFile(path.join(repo, '.gemini', 'worktree-setup.sh'), 'echo hi\n');
		expect(await worktreeSetupCommand(repo, undefined)).toBe(`sh '${path.join(repo, '.gemini', 'worktree-setup.sh')}'`);
	});

	it('runs in the new folder, knows where it came from, and reports the exit code', async () => {
		await fs.writeFile(path.join(repo, '.env'), 'KEY=1\n');
		const worktree = await createWorktree(repo, 'gemini/setup', '', home);
		let output = '';
		const code = await runWorktreeSetup('cp "$GEMINI_SOURCE_REPOSITORY/.env" . && echo copied on $GEMINI_BRANCH', worktree, repo, text => output += text);
		expect(code).toBe(0);
		expect(output.trim()).toBe('copied on gemini/setup');
		expect(await fs.readFile(path.join(worktree.folder, '.env'), 'utf8')).toBe('KEY=1\n');
		expect(await runWorktreeSetup('exit 3', worktree, repo, () => undefined)).toBe(3);
	});
});

describe('project folders', () => {
	it('names the folders a project needs trusted', () => {
		expect([projectFolders(repo, false, home), projectFolders(repo, true, home)]).toEqual([
			[projectsHome(home), worktreesHome(repo, home)],
			[projectsHome(home), worktreesHome(repo, home), allThreadsHome(home)],
		]);
	});
});

describe('TurnQueue', () => {
	it('runs tasks one at a time per key, after a failed one too, and other keys at once', async () => {
		const queue = new TurnQueue();
		const order: string[] = [];
		let release!: () => void;
		const first = queue.run('a', () => new Promise<void>(resolve => { release = resolve; }).then(() => { order.push('a1'); }));
		const failed = queue.run('a', async () => { order.push('a2'); throw new Error('no'); });
		const third = queue.run('a', async () => { order.push('a3'); return 3; });
		await queue.run('b', async () => { order.push('b1'); });
		release();
		await first;
		await expect(failed).rejects.toThrow('no');
		expect({ third: await third, order }).toEqual({ third: 3, order: ['b1', 'a1', 'a2', 'a3'] });
	});
});

describe('one git lock per repository', () => {
	it('queues writes to a repository by its main checkout, however it is named, and lets other repositories run', async () => {
		const worktree = await createWorktree(repo, 'gemini/lock', '', home);
		const other = path.join(root, 'other');
		await fs.mkdir(other);
		await git(other, ['init', '--quiet', '--initial-branch=main']);
		const order: string[] = [];
		let release!: () => void;
		const first = inRepository(repo, () => new Promise<void>(resolve => { release = resolve; }).then(() => { order.push('repo'); }));
		// Wait until the first task holds the lock.
		await new Promise(resolve => setTimeout(resolve, 50));
		const second = inRepository(worktree.folder, async () => { order.push('worktree'); });
		await inRepository(other, async () => { order.push('other'); });
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(['other', 'repo', 'worktree']);
		// Several at once, in a fixed order, so two callers never wait on each other.
		expect(await Promise.all([inRepository([repo, other], async () => 1), inRepository([other, repo], async () => 2)])).toEqual([1, 2]);
	});
});

describe('git that talks to a server', () => {
	it('names the usual problems in plain words', () => {
		expect([
			'ssh: connect to host gitlab.acme.internal port 22: Operation timed out\nfatal: Could not read from remote repository.',
			'fatal: unable to access \'https://gitlab.acme.internal/x.git/\': Could not resolve host: gitlab.acme.internal',
			'git@gitlab.acme.internal: Permission denied (publickey).',
			'fatal: could not read Username for \'https://gitlab.acme.internal\': terminal prompts disabled',
			'error: failed to push some refs',
		].map(gitNetworkProblem)).toEqual(['vpn', 'vpn', 'signIn', 'signIn', undefined]);
	});

	it('fails a fetch from a host that refuses in plain words, keeping the raw output', async () => {
		const failure = await git(repo, ['fetch', '--quiet', 'ssh://nobody@127.0.0.1:1/shop.git', 'main']).catch((err: unknown) => err as { message: string; stderr: string; problem?: string });
		expect({ message: failure.message, problem: failure.problem }).toEqual({ message: 'Git couldn\'t reach the server. Check your VPN.', problem: 'vpn' });
		expect(failure.stderr).toMatch(/127\.0\.0\.1/);
	});

	it('leaves an ssh the user set alone', async () => {
		const saved = process.env.GIT_SSH_COMMAND;
		process.env.GIT_SSH_COMMAND = 'sh -c "echo own-ssh >&2; exit 1" --';
		try {
			const failure = await git(repo, ['fetch', '--quiet', 'ssh://nobody@gitlab.invalid/shop.git', 'main']).catch((err: unknown) => err as { stderr: string });
			expect(failure.stderr).toContain('own-ssh');
		} finally {
			if (saved === undefined) {
				delete process.env.GIT_SSH_COMMAND;
			} else {
				process.env.GIT_SSH_COMMAND = saved;
			}
		}
	});
});
