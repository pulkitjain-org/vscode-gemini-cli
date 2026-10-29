/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The second half of worktrees.test.ts, so the two run in parallel: threads in several repositories, the setup script, project folders, the turn queue, the git lock and git over a server.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allThreadsHome, branchExists, commitAll, createWorktree, createWorktreeAt, currentBranch, freeBranchName, git, gitNetworkProblem, inRepository, pathExists, projectFolders, projectsHome, removeThreadFolder, repositoryRoot, runWorktreeSetup, threadGuide, threadsHome, TurnQueue, worktreeSetup, worktreeSetupCommand, worktreesHome, writeThreadGuide } from '../../src/acp/worktrees';

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

	it('hands over the repository\'s script with its content, to ask before it runs, but not the setting\'s command', async () => {
		await fs.mkdir(path.join(repo, '.gemini'));
		const file = path.join(repo, '.gemini', 'worktree-setup.sh');
		await fs.writeFile(file, 'npm ci\n');
		expect({
			script: await worktreeSetup(repo, undefined),
			setting: await worktreeSetup(repo, 'npm ci'),
		}).toEqual({
			script: { command: `sh '${file}'`, script: { file, content: 'npm ci\n' } },
			setting: { command: 'npm ci' },
		});
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
		const failure = await git(repo, ['fetch', '--quiet', 'ssh://nobody@127.0.0.1:1/shop.git', 'main']).then(() => ({ message: '', stderr: '', problem: 'none' }), (err: unknown) => err as { message: string; stderr: string; problem?: string });
		expect({ message: failure.message, problem: failure.problem }).toEqual({ message: 'Git couldn\'t reach the server. Check your VPN.', problem: 'vpn' });
		expect(failure.stderr).toMatch(/127\.0\.0\.1/);
	});

	it('leaves an ssh the user set alone', async () => {
		const saved = process.env.GIT_SSH_COMMAND;
		process.env.GIT_SSH_COMMAND = 'sh -c "echo own-ssh >&2; exit 1" --';
		try {
			const failure = await git(repo, ['fetch', '--quiet', 'ssh://nobody@gitlab.invalid/shop.git', 'main']).then(() => ({ stderr: '' }), (err: unknown) => err as { stderr: string });
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
