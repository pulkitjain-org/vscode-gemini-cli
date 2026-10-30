/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTrees, changedFiles, contains, editedSince, filesWithMarkers, forkPoint, snapshotTree, startOf, treeOf, treeWithFiles } from '../../src/acp/worktreeApply';
import { commitAll, createWorktree, git } from '../../src/acp/worktrees';

let root: string;
let repo: string;
let home: string;
const labels = { ours: 'yours', theirs: 'thread' };

beforeAll(() => {
	Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' });
});

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-apply-')));
	repo = path.join(root, 'shop');
	home = path.join(root, 'home');
	await newRepository(repo);
});

afterEach(() => fs.rm(root, { recursive: true, force: true }));

async function newRepository(folder: string): Promise<void> {
	await fs.mkdir(path.join(folder, 'src'), { recursive: true });
	await git(folder, ['init', '--quiet', '--initial-branch=main']);
	await fs.writeFile(path.join(folder, 'src', 'cart.ts'), cart(1, '[]'));
	await fs.writeFile(path.join(folder, 'src', 'old.ts'), 'export const old = true;\n');
	await commitAll(folder, 'Initial');
}

/** cart.ts, with its two values far enough apart that edits to each merge cleanly. */
const cart = (total: number, items: string) => `export const total = ${total};\n\n// Totals.\n// Items.\n\nexport const items = ${items};\n`;
const read = (folder: string, file: string) => fs.readFile(path.join(folder, file), 'utf8').catch(() => undefined);
const write = async (folder: string, file: string, data: string | Buffer) => {
	await fs.mkdir(path.dirname(path.join(folder, file)), { recursive: true });
	await fs.writeFile(path.join(folder, file), data);
};

/** A worktree whose agent changed cart.ts, added tax.ts and deleted old.ts, without committing. */
async function threadWithWork(repository = repo) {
	const worktree = await createWorktree(repository, 'gemini/fix-total', '', path.join(home, path.basename(repository)));
	await write(worktree.folder, 'src/cart.ts', cart(2, '[]'));
	await write(worktree.folder, 'src/tax.ts', 'export const tax = 0;\n');
	await fs.rm(path.join(worktree.folder, 'src', 'old.ts'));
	const start = (await startOf(repository, worktree.branch, worktree.base))!;
	return { worktree, start, base: await treeOf(repository, start) };
}

/** A worktree with nothing changed yet, from what `repo` has out now, and its base tree. */
async function emptyThread() {
	const worktree = await createWorktree(repo, 'gemini/other', '', home);
	return { worktree, base: await treeOf(repo, (await startOf(repo, worktree.branch, worktree.base))!) };
}

describe('worktreeApply', () => {
	it('brings a worktree\'s uncommitted work into the checkout, unstaged, and takes it back', async () => {
		const { worktree, base } = await threadWithWork();
		const tree = await snapshotTree(worktree.folder);
		// The worktree's own index is untouched by the snapshot.
		expect(await git(worktree.folder, ['diff', '--cached', '--name-only'])).toBe('');
		const files = await changedFiles(repo, base, tree);
		const tried = await applyTrees(repo, repo, base, tree, { labels });
		const status = await git(repo, ['status', '--porcelain']);
		const back = await applyTrees(repo, repo, tree, base, { labels });
		expect({ files, tried, status, back, cart: await read(repo, 'src/cart.ts'), statusAfter: await git(repo, ['status', '--porcelain']) }).toEqual({
			files: ['src/cart.ts', 'src/old.ts', 'src/tax.ts'],
			tried: { changed: ['src/cart.ts', 'src/old.ts', 'src/tax.ts'], conflicts: [], unmerged: [], skipped: [] },
			status: ' M src/cart.ts\n D src/old.ts\n?? src/tax.ts\n',
			back: { changed: ['src/cart.ts', 'src/old.ts', 'src/tax.ts'], conflicts: [], unmerged: [], skipped: [] },
			cart: cart(1, '[]'),
			statusAfter: '',
		});
	});

	it('keeps the user\'s own edits and what they staged, and marks a clash', async () => {
		const { worktree, base } = await threadWithWork();
		const first = await snapshotTree(worktree.folder);
		await applyTrees(repo, repo, base, first, { labels });
		// The user edits another line of cart.ts and stages an unrelated file.
		await write(repo, 'src/cart.ts', cart(2, '[1]'));
		await write(repo, 'notes.md', 'mine\n');
		await git(repo, ['add', 'notes.md']);
		// The thread's next turn changes the total again: an update merges around the user's line.
		await write(worktree.folder, 'src/cart.ts', cart(3, '[]'));
		const second = await snapshotTree(worktree.folder);
		const edited = await editedSince(repo, repo, first, ['src/cart.ts', 'src/tax.ts']);
		const update = await applyTrees(repo, repo, first, second, { labels });
		const merged = await read(repo, 'src/cart.ts');
		// Then both change the same line.
		await write(repo, 'src/cart.ts', cart(10, '[1]'));
		await write(worktree.folder, 'src/cart.ts', cart(4, '[]'));
		const third = await snapshotTree(worktree.folder);
		const clash = await applyTrees(repo, repo, second, third, { labels });
		expect({ edited, update, merged, clash, marked: await filesWithMarkers(repo, ['src/cart.ts', 'src/tax.ts']), staged: await git(repo, ['diff', '--cached', '--name-only']) }).toEqual({
			edited: ['src/cart.ts'],
			update: { changed: ['src/cart.ts'], conflicts: [], unmerged: [], skipped: [] },
			merged: cart(3, '[1]'),
			clash: { changed: ['src/cart.ts'], conflicts: ['src/cart.ts'], unmerged: [], skipped: [] },
			marked: ['src/cart.ts'],
			staged: 'notes.md\n',
		});
	});

	it('leaves a file that can\'t be merged as it is: deleted on one side, or binary on both', async () => {
		await write(repo, 'logo.png', Buffer.from([0x89, 0x50, 0, 1, 2]));
		await commitAll(repo, 'Logo');
		const { worktree, base } = await threadWithWork();
		await write(worktree.folder, 'logo.png', Buffer.from([0x89, 0x50, 0, 9, 9]));
		const tree = await snapshotTree(worktree.folder);
		// The user edited the file the thread deleted, and changed the logo too.
		await write(repo, 'src/old.ts', 'export const old = false;\n');
		await write(repo, 'logo.png', Buffer.from([0x89, 0x50, 0, 7, 7]));
		const result = await applyTrees(repo, repo, base, tree, { labels });
		expect({ result, old: await read(repo, 'src/old.ts'), logo: [...await fs.readFile(path.join(repo, 'logo.png'))] }).toEqual({
			result: { changed: ['src/cart.ts', 'src/tax.ts'], conflicts: [], unmerged: ['logo.png', 'src/old.ts'], skipped: [] },
			old: 'export const old = false;\n',
			logo: [0x89, 0x50, 0, 7, 7],
		});
	});

	it('takes a binary file and a mode-only change the user didn\'t touch', async () => {
		await write(repo, 'logo.png', Buffer.from([0x89, 0x50, 0, 1, 2]));
		await write(repo, 'run.sh', '#!/bin/sh\necho hi\n');
		await commitAll(repo, 'Logo and script');
		const { worktree, base } = await emptyThread();
		await write(worktree.folder, 'logo.png', Buffer.from([0x89, 0x50, 0, 9, 9]));
		await fs.chmod(path.join(worktree.folder, 'run.sh'), 0o755);
		const tree = await snapshotTree(worktree.folder);
		const result = await applyTrees(repo, repo, base, tree, { labels });
		const mode = (await fs.stat(path.join(repo, 'run.sh'))).mode & 0o111;
		expect({ result, logo: [...await fs.readFile(path.join(repo, 'logo.png'))], executable: mode !== 0, status: await git(repo, ['status', '--porcelain']) }).toEqual({
			result: { changed: ['logo.png', 'run.sh'], conflicts: [], unmerged: [], skipped: [] },
			logo: [0x89, 0x50, 0, 9, 9],
			executable: true,
			status: ' M logo.png\n M run.sh\n',
		});
	});

	it('never writes through a link: a re-pointed file or a linked folder leading out of the checkout', async () => {
		await write(repo, 'notes.txt', 'notes\n');
		await write(repo, 'out/keep.txt', 'keep\n');
		await fs.symlink('notes.txt', path.join(repo, 'current'));
		await commitAll(repo, 'Notes, a folder and a link');
		const outside = path.join(root, 'outside');
		await write(outside, 'secret.txt', 'secret\n');
		const { worktree, base } = await emptyThread();
		await write(worktree.folder, 'notes.txt', 'notes, by the thread\n');
		await write(worktree.folder, 'out/new.txt', 'new\n');
		await fs.rm(path.join(worktree.folder, 'current'));
		await fs.symlink('out/keep.txt', path.join(worktree.folder, 'current'));
		await fs.symlink('notes.txt', path.join(worktree.folder, 'latest'));
		const tree = await snapshotTree(worktree.folder);
		// In the user's checkout, notes.txt is now a link to a file elsewhere, and out/ a link to a folder elsewhere.
		await fs.rm(path.join(repo, 'notes.txt'));
		await fs.symlink(path.join(outside, 'secret.txt'), path.join(repo, 'notes.txt'));
		await fs.rm(path.join(repo, 'out'), { recursive: true });
		await fs.symlink(outside, path.join(repo, 'out'));
		const result = await applyTrees(repo, repo, base, tree, { labels });
		expect({
			result,
			secret: await read(outside, 'secret.txt'),
			leaked: await read(outside, 'new.txt'),
			current: await fs.readlink(path.join(repo, 'current')),
			latest: await fs.readlink(path.join(repo, 'latest')),
		}).toEqual({
			result: { changed: ['current', 'latest'], conflicts: [], unmerged: ['notes.txt', 'out/new.txt'], skipped: [] },
			secret: 'secret\n',
			leaked: undefined,
			current: 'out/keep.txt',
			latest: 'notes.txt',
		});
	});

	it('compares and writes files as checked out, so line endings set by attributes aren\'t edits', async () => {
		await write(repo, '.gitattributes', '*.txt eol=crlf\n');
		await commitAll(repo, 'Attributes');
		await write(repo, 'notes.txt', 'one\r\ntwo\r\n');
		await commitAll(repo, 'Notes');
		const { worktree, base } = await emptyThread();
		await write(worktree.folder, 'notes.txt', 'one\r\ntwo, by the thread\r\n');
		const tree = await snapshotTree(worktree.folder);
		const result = await applyTrees(repo, repo, base, tree, { labels });
		const applied = await treeWithFiles(repo, tree, repo, ['notes.txt']);
		expect({ result, notes: await read(repo, 'notes.txt'), edited: await editedSince(repo, repo, tree, ['notes.txt']), applied: applied === tree, status: await git(repo, ['status', '--porcelain']) }).toEqual({
			result: { changed: ['notes.txt'], conflicts: [], unmerged: [], skipped: [] },
			notes: 'one\r\ntwo, by the thread\r\n',
			edited: [],
			applied: true,
			status: ' M notes.txt\n',
		});
	});

	it('starts from where the thread started, not where the user\'s checkout meets it', async () => {
		await git(repo, ['branch', 'old']);
		await write(repo, 'src/new.ts', 'export const fresh = true;\n');
		await commitAll(repo, 'Newer');
		const { worktree, start } = await threadWithWork();
		const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
		// The user goes back to an older branch, which hasn't the commit the thread started from.
		await git(repo, ['checkout', '--quiet', 'old']);
		const tree = await snapshotTree(worktree.folder);
		const base = await treeOf(repo, start);
		const mergeBase = (await forkPoint(repo, worktree.branch))!;
		expect({
			start: start === head,
			// From the branch's reflog, with HEAD on the older branch and no branch to meet.
			again: await startOf(repo, worktree.branch) === head,
			contained: await contains(repo, start),
			fromMergeBase: await changedFiles(repo, await treeOf(repo, mergeBase), tree),
			files: await changedFiles(repo, base, tree),
		}).toEqual({
			start: true,
			again: true,
			contained: false,
			fromMergeBase: ['src/cart.ts', 'src/new.ts', 'src/old.ts', 'src/tax.ts'],
			files: ['src/cart.ts', 'src/old.ts', 'src/tax.ts'],
		});
	});
});
