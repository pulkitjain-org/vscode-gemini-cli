/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { branchWorktree, reviewWorktree, UnpushedCommitsError } from '../../src/acp/releaseMerge';
import { commitAll, currentBranch, git, reviewsHome, worktreesHome } from '../../src/acp/worktrees';

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

describe('a merge request\'s review', () => {
	it('reuses the worktree of an earlier review of the same merge request, at the new head', async () => {
		const first = await reviewWorktree(clone, 'origin', 'feature/gift', 'review/12-feature-gift', { home });
		await fs.writeFile(path.join(author, 'gift.ts'), 'export const gift = "yes";\n');
		await commitAll(author, 'After review');
		await git(author, ['push', '--quiet', 'origin', 'feature/gift']);
		const second = await reviewWorktree(clone, 'origin', 'feature/gift', 'review/12-feature-gift', { home });
		expect(second.folder).toBe(first.folder);
		expect(await head(second.folder)).toBe(await head(author));
		expect((await git(clone, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(2);
	});

	it('checks out in the reviews folder, which the Gemini CLI never trusts', async () => {
		const review = await reviewWorktree(clone, 'origin', 'feature/gift', 'review/12-feature-gift', { home, subfolder: 'web' });
		expect({ folder: review.folder, cwd: review.cwd, branch: await currentBranch(review.folder) })
			.toEqual({ folder: path.join(reviewsHome(clone, home), '12-feature-gift'), cwd: path.join(reviewsHome(clone, home), '12-feature-gift', 'web'), branch: 'review/12-feature-gift' });
	});

	it('makes a checkout left in the agents\' worktrees folder again in the reviews folder, unless an agent still works there', async () => {
		const old = async (local: string) => {
			const folder = path.join(worktreesHome(clone, home), local.split('/').pop()!);
			await git(clone, ['worktree', 'add', '--quiet', '-b', local, folder, 'origin/main']);
			return folder;
		};
		const idle = await old('review/12-feature-gift');
		const busy = await old('review/13-feature-gift');
		const moved = await reviewWorktree(clone, 'origin', 'feature/gift', 'review/12-feature-gift', { home, inUse: folder => folder === busy });
		const kept = await reviewWorktree(clone, 'origin', 'feature/gift', 'review/13-feature-gift', { home, inUse: folder => folder === busy });
		expect({
			moved: path.relative(home, moved.folder),
			kept: path.relative(home, kept.folder),
			heads: [await head(moved.folder), await head(kept.folder)],
			idleGone: await fs.access(idle).then(() => false, () => true),
		}).toEqual({
			moved: path.join('.geminicode', 'reviews', 'shop', '12-feature-gift'),
			kept: path.join('.geminicode', 'worktrees', 'shop', '13-feature-gift'),
			heads: [await head(author), await head(author)],
			idleGone: true,
		});
	});

	it('resets only GeminiCode\'s own review branches', async () => {
		await expect(reviewWorktree(clone, 'origin', 'feature/gift', 'feature/gift', { home })).rejects.toThrow(/isn't a review branch/);
	});
});
