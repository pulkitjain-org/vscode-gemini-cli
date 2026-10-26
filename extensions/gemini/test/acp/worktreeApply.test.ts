/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appliedAfterTry, appliedAfterUpdate, applyTrees, changedFiles, contains, deleteRef, deleteRefs, editedSince, filesWithMarkers, forkPoint, mergeTrees, resetFolder, restoreSnapshot, saveSnapshot, sendEdits, snapshotTree, startOf, treeOf, treeWithEntries, treeWithFiles } from '../../src/acp/worktreeApply';
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

	it('tries a thread in two repositories, each in its own checkout', async () => {
		const api = path.join(root, 'api');
		await newRepository(api);
		const shop = await threadWithWork(repo);
		const other = await threadWithWork(api);
		await write(other.worktree.folder, 'src/routes.ts', 'export const routes = [];\n');
		const results = [];
		for (const [repository, thread] of [[repo, shop], [api, other]] as const) {
			results.push(await applyTrees(repository, repository, thread.base, await snapshotTree(thread.worktree.folder), { labels }));
		}
		expect({ results: results.map(result => result.changed), shop: await git(repo, ['status', '--porcelain']), api: await git(api, ['status', '--porcelain']) }).toEqual({
			results: [['src/cart.ts', 'src/old.ts', 'src/tax.ts'], ['src/cart.ts', 'src/old.ts', 'src/routes.ts', 'src/tax.ts']],
			shop: ' M src/cart.ts\n D src/old.ts\n?? src/tax.ts\n',
			api: ' M src/cart.ts\n D src/old.ts\n?? src/routes.ts\n?? src/tax.ts\n',
		});
	});

	it('holds back a file with unsaved edits, which the next update brings', async () => {
		const { worktree, base } = await threadWithWork();
		const tree = await snapshotTree(worktree.folder);
		const result = await applyTrees(repo, repo, base, tree, { labels, skip: file => file === 'src/cart.ts' });
		const recorded = await treeWithEntries(repo, tree, base, result.skipped);
		const later = await applyTrees(repo, repo, recorded, tree, { labels });
		expect({ result, later }).toEqual({
			result: { changed: ['src/old.ts', 'src/tax.ts'], conflicts: [], unmerged: [], skipped: ['src/cart.ts'] },
			later: { changed: ['src/cart.ts'], conflicts: [], unmerged: [], skipped: [] },
		});
	});

	it('counts only edits since Try wrote the files, not what the user had before', async () => {
		const { worktree, base } = await threadWithWork();
		// The user had an uncommitted edit to cart.ts before trying.
		await write(repo, 'src/cart.ts', cart(1, '[0]'));
		const tree = await snapshotTree(worktree.folder);
		await applyTrees(repo, repo, base, tree, { labels });
		const applied = await treeWithFiles(repo, tree, repo, ['src/cart.ts', 'src/old.ts', 'src/tax.ts']);
		const before = await editedSince(repo, repo, applied, ['src/cart.ts', 'src/tax.ts']);
		await write(repo, 'src/tax.ts', 'export const tax = 1;\n');
		expect({ cart: await read(repo, 'src/cart.ts'), before, after: await editedSince(repo, repo, applied, ['src/cart.ts', 'src/tax.ts']), versusTree: await editedSince(repo, repo, tree, ['src/cart.ts']) }).toEqual({
			cart: cart(2, '[0]'),
			before: [],
			after: ['src/tax.ts'],
			versusTree: ['src/cart.ts'],
		});
	});

	it('sends the user\'s edits to the worktree; the next update doesn\'t clash, and Take Back keeps the edits', async () => {
		const { worktree, base } = await threadWithWork();
		const tree = await snapshotTree(worktree.folder);
		await applyTrees(repo, repo, base, tree, { labels });
		const files = await changedFiles(repo, base, tree);
		const applied = await treeWithFiles(repo, tree, repo, files);
		// The user changes the items in cart.ts and the tax, then sends both, as Send My Edits does.
		await write(repo, 'src/cart.ts', cart(2, '[1]'));
		await write(repo, 'src/tax.ts', 'export const tax = 0.2;\n');
		const edits = await editedSince(repo, repo, applied, files);
		const mine = await treeWithFiles(repo, applied, repo, edits);
		const sent = await applyTrees(repo, worktree.folder, applied, mine, { labels, paths: edits });
		const withEdits = (await mergeTrees(repo, tree, applied, mine, edits, 'markers')).tree;
		const back = (await mergeTrees(repo, base, applied, mine, edits, 'theirs')).tree;
		// The thread builds on the edits; the update, from the tree with them in it, brings only its own change.
		await write(worktree.folder, 'src/tax.ts', 'export const tax = 0.2;\nexport const rate = 20;\n');
		const next = await snapshotTree(worktree.folder);
		const update = await applyTrees(repo, repo, withEdits, next, { labels });
		const afterUpdate = { tax: await read(repo, 'src/tax.ts'), cart: await read(repo, 'src/cart.ts') };
		// Take Back removes the thread's changes and keeps the user's: the items stay, the total goes back.
		const takenBack = await applyTrees(repo, repo, next, back, { labels });
		expect({ edits, sent, update, afterUpdate, takenBack, cart: await read(repo, 'src/cart.ts'), tax: await read(repo, 'src/tax.ts'), old: await read(repo, 'src/old.ts') }).toEqual({
			edits: ['src/cart.ts', 'src/tax.ts'],
			sent: { changed: ['src/cart.ts', 'src/tax.ts'], conflicts: [], unmerged: [], skipped: [] },
			update: { changed: ['src/tax.ts'], conflicts: [], unmerged: [], skipped: [] },
			afterUpdate: { tax: 'export const tax = 0.2;\nexport const rate = 20;\n', cart: cart(2, '[1]') },
			takenBack: { changed: ['src/cart.ts', 'src/old.ts', 'src/tax.ts'], conflicts: [], unmerged: [], skipped: [] },
			cart: cart(1, '[1]'),
			// A file the thread added keeps the user's whole version: its edits can't be told from the thread's.
			tax: 'export const tax = 0.2;\n',
			old: 'export const old = true;\n',
		});
	});

	it('sends a resolved conflict as the user resolved it, without markers in the thread\'s folder or its tree', async () => {
		const { worktree, base } = await threadWithWork();
		// The user had changed the same line before trying: the try leaves conflict markers.
		await write(repo, 'src/cart.ts', cart(5, '[]'));
		const tree = await snapshotTree(worktree.folder);
		const files = await changedFiles(repo, base, tree);
		const tried = await applyTrees(repo, repo, base, tree, { labels });
		const applied = await appliedAfterTry(repo, tree, repo, files, tried.conflicts);
		// The user resolves it, keeping both numbers' sum, and sends it.
		await write(repo, 'src/cart.ts', cart(7, '[]'));
		const edits = await editedSince(repo, repo, applied, files);
		const sent = await sendEdits(repo, worktree.folder, { tree, applied, back: base }, edits, labels);
		const inWorktree = await read(worktree.folder, 'src/cart.ts');
		// An update later: a marker in the recorded trees would come back here.
		await write(worktree.folder, 'src/cart.ts', cart(7, '[2]'));
		const next = await snapshotTree(worktree.folder);
		const update = await applyTrees(repo, repo, sent.tree, next, { labels });
		const afterUpdate = await appliedAfterUpdate(repo, sent.applied, sent.tree, next, update.conflicts);
		expect({
			conflicts: tried.conflicts,
			edits,
			result: sent.result,
			worktree: inWorktree,
			tree: (await git(repo, ['show', `${sent.tree}:src/cart.ts`])),
			mixed: sent.mixed,
			update,
			checkout: await read(repo, 'src/cart.ts'),
			edited: await editedSince(repo, repo, afterUpdate, files),
		}).toEqual({
			conflicts: ['src/cart.ts'],
			edits: ['src/cart.ts'],
			result: { changed: ['src/cart.ts'], conflicts: [], unmerged: [], skipped: [] },
			worktree: cart(7, '[]'),
			tree: cart(7, '[]'),
			// Take Back can't separate the user's line from the thread's, so it leaves the file and says so.
			mixed: ['src/cart.ts'],
			update: { changed: ['src/cart.ts'], conflicts: [], unmerged: [], skipped: [] },
			checkout: cart(7, '[2]'),
			edited: [],
		});
	});

	it('records a file left with markers by an update as the thread\'s version', async () => {
		const { worktree, base } = await threadWithWork();
		const first = await snapshotTree(worktree.folder);
		await applyTrees(repo, repo, base, first, { labels });
		const applied = await appliedAfterTry(repo, first, repo, await changedFiles(repo, base, first), []);
		await write(repo, 'src/cart.ts', cart(9, '[]'));
		await write(worktree.folder, 'src/cart.ts', cart(3, '[]'));
		const second = await snapshotTree(worktree.folder);
		const update = await applyTrees(repo, repo, first, second, { labels });
		const after = await appliedAfterUpdate(repo, applied, first, second, update.conflicts);
		expect({ conflicts: update.conflicts, recorded: await git(repo, ['show', `${after}:src/cart.ts`]) }).toEqual({ conflicts: ['src/cart.ts'], recorded: cart(3, '[]') });
	});

	it('reads files as checked out with core.autocrlf set to yes, and reports a file it can\'t read without losing the rest', async () => {
		await git(repo, ['config', 'core.autocrlf', 'yes']);
		const names = Array.from({ length: 30 }, (_, i) => `docs/page${i}.md`);
		for (const name of names) {
			await write(repo, name, 'one\r\ntwo\r\n');
		}
		await commitAll(repo, 'Pages');
		const { worktree, base } = await emptyThread();
		for (const name of names) {
			await write(worktree.folder, name, 'one\r\ntwo, by the thread\r\n');
		}
		await write(worktree.folder, 'src/old.ts', 'export const old = 2;\n');
		const tree = await snapshotTree(worktree.folder);
		await fs.chmod(path.join(repo, 'src', 'old.ts'), 0o000);
		const started = Date.now();
		const result = await applyTrees(repo, repo, base, tree, { labels });
		const took = Date.now() - started;
		await fs.chmod(path.join(repo, 'src', 'old.ts'), 0o644);
		expect({ changed: result.changed.length, conflicts: result.conflicts, unmerged: result.unmerged, page: await read(repo, 'docs/page7.md'), quick: took < 5000 }).toEqual({
			changed: 30,
			conflicts: [],
			unmerged: ['src/old.ts'],
			page: 'one\r\ntwo, by the thread\r\n',
			quick: true,
		});
	});

	it('saves a worktree before resetting it, restores it, and deletes what it saved', async () => {
		const { worktree, start } = await threadWithWork();
		const saved = await saveSnapshot(worktree.folder, 'refs/geminicode/discarded/t1', 'Discarded');
		await saveSnapshot(worktree.folder, 'refs/geminicode/discarded/t1-replaced-1', 'Replaced');
		await resetFolder(worktree.folder, start);
		const reset = await git(worktree.folder, ['status', '--porcelain']);
		const resetTree = (await snapshotTree(worktree.folder)) === await treeOf(worktree.folder, start);
		await restoreSnapshot(worktree.folder, saved.commit, saved.head);
		await deleteRef(worktree.folder, 'refs/geminicode/discarded/t1');
		const left = await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/geminicode/']);
		await deleteRefs(repo, 'refs/geminicode/discarded/t1');
		expect({ reset, resetTree, restored: await git(worktree.folder, ['status', '--porcelain']), staged: await git(worktree.folder, ['diff', '--cached', '--name-only']), tax: await read(worktree.folder, 'src/tax.ts'), left, after: await git(repo, ['for-each-ref', 'refs/geminicode/']) }).toEqual({
			reset: '',
			resetTree: true,
			restored: ' M src/cart.ts\n D src/old.ts\n?? src/tax.ts\n',
			staged: '',
			tax: 'export const tax = 0;\n',
			left: 'refs/geminicode/discarded/t1-replaced-1\n',
			after: '',
		});
	});
});
