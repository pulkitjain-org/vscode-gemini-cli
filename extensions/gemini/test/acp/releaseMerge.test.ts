/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { branchSummary, pushBranch } from '../../src/acp/releaseMerge';
import { commitAll, git } from '../../src/acp/worktrees';

let root: string;
let remote: string;
let clone: string;

beforeAll(() => {
	Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' });
	// The throwaway repositories are never signed, whatever the user's global git config asks for.
	Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' });
});

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'release-merge-')));
	remote = path.join(root, 'shop.git');
	clone = path.join(root, 'shop');
	await git(root, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
	await git(root, ['clone', '--quiet', remote, clone]);
	await fs.writeFile(path.join(clone, 'cart.ts'), 'export const total = 1;\n');
	await commitAll(clone, 'Initial');
	await git(clone, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
	await git(clone, ['fetch', '--quiet', 'origin']);
	await git(clone, ['checkout', '--quiet', '-b', 'feature/cart']);
});

afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('branchSummary', () => {
	it('lists the branch commits, newest first, with the diffstat and diff against the base', async () => {
		await fs.writeFile(path.join(clone, 'cart.ts'), 'export const total = 2;\n');
		await commitAll(clone, 'Count the cart again');
		await fs.writeFile(path.join(clone, 'basket.ts'), 'export const empty = true;\n');
		await git(clone, ['add', '-A']);
		await git(clone, ['commit', '--quiet', '-m', 'Add the basket', '-m', 'It starts empty.']);
		const summary = await branchSummary(clone, 'origin/main');
		expect({
			commits: summary.commits,
			diffStat: summary.diffStat.split('\n').map(line => line.trim()),
			diff: ['+export const total = 2;', '-export const total = 1;', '+export const empty = true;'].every(line => summary.diff.includes(`\n${line}\n`)),
		}).toEqual({
			commits: '- Add the basket\nIt starts empty.\n- Count the cart again',
			diffStat: ['basket.ts | 1 +', 'cart.ts   | 2 +-', '2 files changed, 2 insertions(+), 1 deletion(-)'],
			diff: true,
		});
	});

	it('is empty when the branch has nothing new, or the base does not exist', async () => {
		expect([await branchSummary(clone, 'origin/main'), await branchSummary(clone, 'origin/no-such-branch')]).toEqual([
			{ commits: '', diffStat: '', diff: '' },
			{ commits: '', diffStat: '', diff: '' },
		]);
	});
});

describe('pushBranch', () => {
	it('pushes HEAD to the named branch and tracks it', async () => {
		await fs.writeFile(path.join(clone, 'cart.ts'), 'export const total = 3;\n');
		await commitAll(clone, 'Count once more');
		await pushBranch(clone, 'origin', 'review/cart');
		const head = (await git(clone, ['rev-parse', 'HEAD'])).trim();
		expect({
			remote: (await git(remote, ['rev-parse', 'refs/heads/review/cart'])).trim(),
			upstream: (await git(clone, ['rev-parse', '--abbrev-ref', '@{upstream}'])).trim(),
		}).toEqual({ remote: head, upstream: 'origin/review/cart' });
	});
});
