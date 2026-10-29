/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles, listFolder } from '../../src/acp/folderFiles';
import { changedBetween, filesMatchingHead, gitDirs, headPosition, porcelainPaths, readGitHead } from '../../src/acp/gitHead';

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

	it('says when the walk stopped short of the whole folder', async () => {
		const root = mkdtempSync(path.join(tmpdir(), 'list-files-'));
		for (const name of ['a', 'b', 'c', 'd']) {
			mkdirSync(path.join(root, name));
			writeFileSync(path.join(root, name, 'x.ts'), '');
		}
		const cut = await listFolder(root, 2);
		const whole = await listFolder(root, 10);
		expect([cut.files.length, cut.truncated, whole.files.length, whole.truncated]).toEqual([2, true, 4, false]);
	});
});

/** A repository with one commit of `a.ts` and `src/b.ts`. */
function committedRepo(): { readonly root: string; readonly run: (...args: string[]) => string } {
	const root = mkdtempSync(path.join(tmpdir(), 'git-settle-'));
	const run = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
	run('init', '-q', '-b', 'main');
	run('config', 'user.email', 't@example.com');
	run('config', 'user.name', 'T');
	mkdirSync(path.join(root, 'src'));
	writeFileSync(path.join(root, 'a.ts'), 'one\n');
	writeFileSync(path.join(root, 'src', 'b.ts'), 'two\n');
	run('add', '.');
	run('commit', '-q', '-m', 'first');
	return { root, run };
}

describe('headPosition and changedBetween', () => {
	it('says where HEAD is, what two commits differ in, and when it cannot tell', async () => {
		const { root, run } = committedRepo();
		const first = (await headPosition(root))!;
		writeFileSync(path.join(root, 'src', 'b.ts'), 'two, changed\n');
		writeFileSync(path.join(root, 'src', 'c.ts'), 'three\n');
		run('add', 'src');
		run('commit', '-q', '-m', 'second');
		const second = (await headPosition(root))!;
		run('checkout', '-q', '--detach');
		const detached = (await headPosition(root))!;
		expect({
			branch: first.branch,
			sameBranch: second.branch === first.branch && second.commit !== first.commit,
			changed: (await changedBetween(root, first.commit, second.commit))!.sort(),
			none: await changedBetween(root, second.commit, second.commit),
			unknown: await changedBetween(root, '0'.repeat(40), second.commit),
			detached: detached.branch,
			outside: await headPosition(tmpdir()),
		}).toEqual({
			branch: 'refs/heads/main',
			sameBranch: true,
			changed: [path.join(root, 'src', 'b.ts'), path.join(root, 'src', 'c.ts')],
			none: [],
			unknown: undefined,
			detached: undefined,
			outside: undefined,
		});
	});
});

describe('filesMatchingHead', () => {
	it('finds the files whose text is what HEAD has, from the repository or a subfolder', async () => {
		const { root, run } = committedRepo();
		const a = path.join(root, 'a.ts');
		const b = path.join(root, 'src', 'b.ts');
		const created = path.join(root, 'src', 'new file.ts');
		writeFileSync(a, 'one, changed\n');
		writeFileSync(b, 'two, changed\n');
		writeFileSync(created, 'new\n');
		expect(await filesMatchingHead(root, [a, b, created])).toEqual([]);
		// b.ts and the new file are committed; a.ts is staged but not committed.
		run('add', 'src');
		run('commit', '-q', '-m', 'second');
		run('add', 'a.ts');
		expect((await filesMatchingHead(root, [a, b, created])).sort()).toEqual([b, created].sort());
		expect((await filesMatchingHead(path.join(root, 'src'), [a, b, created])).sort()).toEqual([b, created].sort());
	});

	it('does not count a file Git ignores as committed', async () => {
		const { root } = committedRepo();
		writeFileSync(path.join(root, '.gitignore'), 'out.log\n');
		writeFileSync(path.join(root, 'out.log'), 'x');
		expect(await filesMatchingHead(root, [path.join(root, 'out.log')])).toEqual([]);
	});

	it('reads paths from porcelain status, with both sides of a rename', () => {
		expect(porcelainPaths(' M a.ts\0R  new.ts\0old.ts\0?? dir/x y.ts\0')).toEqual(['a.ts', 'new.ts', 'old.ts', 'dir/x y.ts']);
		expect(porcelainPaths('')).toEqual([]);
	});

	it('finds the git directories to watch, also for a worktree', async () => {
		const { root, run } = committedRepo();
		expect(await gitDirs(root)).toEqual({ gitDir: path.join(root, '.git'), commonDir: path.join(root, '.git') });
		const worktree = path.join(mkdtempSync(path.join(tmpdir(), 'git-settle-wt-')), 'wt');
		run('worktree', 'add', '-q', '-b', 'wt', worktree);
		const dirs = await gitDirs(worktree);
		expect(realpathSync(dirs!.commonDir)).toBe(realpathSync(path.join(root, '.git')));
		expect(dirs?.gitDir).not.toBe(dirs?.commonDir);
	});
});

