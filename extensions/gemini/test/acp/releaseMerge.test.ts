/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { branchWorktree, diffFiles, reviewWorktree, splitDiff, UnpushedCommitsError } from '../../src/acp/releaseMerge';
import { commitAll, currentBranch, git } from '../../src/acp/worktrees';

// A clone of a bare "GitLab" with a merge request's branch on it, as Fix and a review see them.
let root: string;
let remote: string;
let clone: string;
let author: string;
let home: string;

beforeAll(() => {
	Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' });
});

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'release-merge-')));
	remote = path.join(root, 'shop.git');
	clone = path.join(root, 'shop');
	author = path.join(root, 'author');
	home = path.join(root, 'home');
	await git(root, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
	await git(root, ['clone', '--quiet', remote, author]);
	await fs.writeFile(path.join(author, 'cart.ts'), 'export const total = 1;\n');
	await commitAll(author, 'Initial');
	await git(author, ['push', '--quiet', 'origin', 'HEAD:main']);
	await git(author, ['checkout', '--quiet', '-b', 'feature/gift']);
	await fs.writeFile(path.join(author, 'gift.ts'), 'export const gift = true;\n');
	await commitAll(author, 'Gift');
	await git(author, ['push', '--quiet', 'origin', 'feature/gift']);
	await git(root, ['clone', '--quiet', remote, clone]);
});

afterEach(() => fs.rm(root, { recursive: true, force: true }));

async function head(folder: string, ref = 'HEAD'): Promise<string> {
	return (await git(folder, ['rev-parse', ref])).trim();
}

describe('Fix on a merge request\'s branch', () => {
	it('keeps unpushed local commits, refusing to check the branch out from the remote', async () => {
		await git(clone, ['branch', '--quiet', '--track', 'feature/gift', 'origin/feature/gift']);
		const fix = await git(clone, ['worktree', 'add', '--quiet', path.join(root, 'local-work'), 'feature/gift']).then(() => path.join(root, 'local-work'));
		await fs.writeFile(path.join(fix, 'gift.ts'), 'export const gift = 1;\n');
		await commitAll(fix, 'Mine, not pushed');
		await fs.writeFile(path.join(fix, 'gift.ts'), 'export const gift = 2;\n');
		await commitAll(fix, 'Mine too');
		await git(clone, ['worktree', 'remove', '--force', fix]);
		const before = await head(clone, 'refs/heads/feature/gift');
		const failure = await branchWorktree(clone, 'origin', 'feature/gift', { home }).catch((err: unknown) => err);
		expect(failure).toBeInstanceOf(UnpushedCommitsError);
		expect((failure as Error).message).toBe('Your local feature/gift has 2 commits that aren\'t pushed. Push them, or move them to another branch, then try again.');
		expect(await head(clone, 'refs/heads/feature/gift')).toBe(before);
	});

	it('uses the branch\'s own checkout, moves a branch that is only behind forward, and tracks a new one', async () => {
		// Only on the remote: a local branch is made from it.
		const made = await branchWorktree(clone, 'origin', 'feature/gift', { home });
		expect(made.existing).toBeUndefined();
		expect(await currentBranch(made.folder)).toBe('feature/gift');
		expect((await git(made.folder, ['rev-parse', '--abbrev-ref', '@{upstream}'])).trim()).toBe('origin/feature/gift');
		// Asked again while it is checked out there: that checkout, as it is.
		const again = await branchWorktree(clone, 'origin', 'feature/gift', { home });
		expect({ folder: again.folder, existing: again.existing }).toEqual({ folder: made.folder, existing: true });
		await git(clone, ['worktree', 'remove', '--force', made.folder]);
		// The author pushes again; the local branch is only behind, so it moves forward.
		await fs.writeFile(path.join(author, 'gift.ts'), 'export const gift = false;\n');
		await commitAll(author, 'Review fix');
		await git(author, ['push', '--quiet', 'origin', 'feature/gift']);
		const moved = await branchWorktree(clone, 'origin', 'feature/gift', { home });
		expect(await head(moved.folder)).toBe(await head(author));
	});
});

describe('a review\'s worktree', () => {
	it('refuses to reset a review branch checked out anywhere GeminiCode did not make', async () => {
		// The user checked GeminiCode's review branch out in their own clone and changed a file there.
		await git(clone, ['checkout', '--quiet', '-b', 'review/7-gift', 'origin/feature/gift']);
		await fs.writeFile(path.join(clone, 'gift.ts'), 'export const gift = "mine";\n');
		await fs.writeFile(path.join(author, 'gift.ts'), 'export const gift = false;\n');
		await commitAll(author, 'Review fix');
		await git(author, ['push', '--quiet', 'origin', 'feature/gift']);
		const before = await head(clone);
		const failure = await reviewWorktree(clone, 'origin', 'feature/gift', 'review/7-gift', { home }).catch((err: unknown) => err);
		expect((failure as Error).message).toBe(`review/7-gift is checked out in ${clone}, which GeminiCode didn't make. Switch branches there first.`);
		expect({ head: await head(clone), file: await fs.readFile(path.join(clone, 'gift.ts'), 'utf8') }).toEqual({ head: before, file: 'export const gift = "mine";\n' });
	});

	it('moves its own checkout to the branch\'s new head', async () => {
		const first = await reviewWorktree(clone, 'origin', 'feature/gift', 'review/7-gift', { home });
		await fs.writeFile(path.join(author, 'gift.ts'), 'export const gift = false;\n');
		await commitAll(author, 'Review fix');
		await git(author, ['push', '--quiet', 'origin', 'feature/gift']);
		const again = await reviewWorktree(clone, 'origin', 'feature/gift', 'review/7-gift', { home, inUse: () => true });
		expect({ folder: again.folder, head: await head(again.folder) }).toEqual({ folder: first.folder, head: await head(author) });
	});
});

describe('the files a range changes', () => {
	it('reads every file\'s diff in one git diff, with names as they are', async () => {
		const base = await head(author, 'refs/heads/main');
		await git(author, ['mv', 'cart.ts', 'basket.ts']);
		await fs.writeFile(path.join(author, 'gift.ts'), 'export const gift = false;\n');
		await fs.writeFile(path.join(author, 'caf\u00e9 "menu".ts'), 'export const menu = 1;\n');
		await fs.writeFile(path.join(author, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
		await commitAll(author, 'Changes');
		await fs.rm(path.join(author, 'gift.ts'));
		await commitAll(author, 'Drop the gift');
		const files = await diffFiles(author, base, 'HEAD');
		expect(files.map(({ diff, ...rest }) => ({ ...rest, hunk: diff.split('\n')[0] }))).toEqual([
			{ oldPath: 'cart.ts', newPath: 'basket.ts', newFile: false, deletedFile: false, hunk: 'diff --git a/cart.ts b/basket.ts' },
			{ oldPath: 'caf\u00e9 "menu".ts', newPath: 'caf\u00e9 "menu".ts', newFile: true, deletedFile: false, hunk: '@@ -0,0 +1 @@' },
			{ oldPath: 'logo.png', newPath: 'logo.png', newFile: true, deletedFile: false, hunk: 'diff --git a/logo.png b/logo.png' },
		]);
		expect(files[1].diff).toBe('@@ -0,0 +1 @@\n+export const menu = 1;\n');
		expect(splitDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-diff --git a/y b/y\n+b\ndiff --git a/y b/y\n')).toEqual(['diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-diff --git a/y b/y\n+b\n', 'diff --git a/y b/y\n']);
	});
});
