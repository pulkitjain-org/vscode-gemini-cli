/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { branchChoices, checkoutForChecks, checkoutOf, listBranches } from '../../src/acp/checksBranch';

describe('branch choices for Run Checks', () => {
	it('offers the current branch, then agents\', local and remote branches, once each', () => {
		const choices = branchChoices('main', [{ branch: 'ACME-412-gift', title: 'ACME-412 Gift message' }], ['main', 'ACME-412-gift', 'develop'], ['main', 'release/2026.11', 'develop']);
		expect(choices).toEqual([
			{ branch: 'main', kind: 'current' },
			{ branch: 'ACME-412-gift', kind: 'agent', agent: 'ACME-412 Gift message' },
			{ branch: 'develop', kind: 'local' },
			{ branch: 'release/2026.11', kind: 'remote' },
		]);
		expect(branchChoices(undefined, [], [], ['x'])).toEqual([{ branch: 'x', kind: 'remote' }]);
	});
});

describe('a checkout for checks', () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function run(cwd: string, ...args: string[]): string {
		return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } });
	}

	it('uses the repository for its own branch, and a reusable worktree for another', async () => {
		dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'checks-branch-')));
		const repo = path.join(dir, 'repo');
		run(dir, 'init', '--quiet', '-b', 'main', repo);
		writeFileSync(path.join(repo, 'a.txt'), 'a\n');
		run(repo, 'add', '.');
		run(repo, 'commit', '--quiet', '-m', 'one');
		run(repo, 'branch', 'feature/x');
		const home = path.join(dir, 'home');

		expect(await listBranches(repo)).toEqual({ locals: ['feature/x', 'main'], remotes: [] });
		expect(await checkoutOf(repo, 'main')).toBe(repo);
		expect(await checkoutOf(repo, 'feature/x')).toBeUndefined();

		const own = await checkoutForChecks(repo, 'origin', 'main', home);
		expect(own).toEqual({ cwd: repo, created: false });

		const made = await checkoutForChecks(repo, 'origin', 'feature/x', home);
		expect(made.created).toBe(true);
		expect(made.worktree?.branch).toBe('feature/x');
		expect(made.cwd.startsWith(path.join(home, '.geminicode', 'worktrees', 'repo', 'checks'))).toBe(true);
		expect(run(made.cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/x');

		const again = await checkoutForChecks(repo, 'origin', 'feature/x', home);
		expect(again.created).toBe(false);
		expect(again.cwd).toBe(made.cwd);
		// The user's checkout did not move.
		expect(run(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
	});
});
