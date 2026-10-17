/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkMerge, mergeInWorktree, mergeUnfinished } from '../../src/acp/releaseMerge';
import {
	checksFixPrompt, findingsFromSnyk, mrFixPrompt, parseMergeTree, parseReviewFindings, releaseMergeBranch, releaseMergeMr, releaseTargets, reviewSummary, targetChoices, ticketBranchName,
} from '../../src/acp/teamFlowLogic';

describe('team flow logic', () => {
	it('names a ticket\'s branch after its key and summary', () => {
		expect(ticketBranchName('ACME-412', 'Gift message at checkout!')).toBe('ACME-412-gift-message-at-checkout');
		expect(ticketBranchName('ACME-1', '…')).toBe('ACME-1');
	});

	it('offers release branches first, newest first, with the fix version suggested', () => {
		const choices = targetChoices(['main', 'develop', 'release/2026.10', 'release/2026.11', 'feature/x', 'ACME-412-gift'], { fixVersions: ['2026.10'], source: 'ACME-412-gift' });
		expect(choices.map(c => c.branch)).toEqual(['release/2026.11', 'release/2026.10', 'develop', 'main', 'feature/x']);
		expect(choices.find(c => c.suggested)?.branch).toBe('release/2026.10');
		expect(targetChoices(['main', 'develop'], { defaultTarget: 'develop' }).find(c => c.suggested)?.branch).toBe('develop');
	});

	it('reads the agent\'s review findings from its last JSON block', () => {
		const reply = 'Looks mostly fine.\n\n```json\n[{"kind":"bug","file":"./wishlist/merge.ts","line":58,"title":"Duplicates","comment":"Compare on SKU?"},{"kind":"odd","comment":"Unused import."},{"kind":"nit"}]\n```';
		expect(parseReviewFindings(reply)).toEqual([
			{ kind: 'bug', file: 'wishlist/merge.ts', line: 58, title: 'Duplicates', comment: 'Compare on SKU?' },
			{ kind: 'shouldFix', title: 'Unused import.', comment: 'Unused import.' },
		]);
		expect(reviewSummary(reply)).toBe('Looks mostly fine.');
		expect(parseReviewFindings('No block here')).toBeUndefined();
		expect(parseReviewFindings('```json\n[]\n```')).toEqual([]);
	});

	it('plans release merges into later release branches, then develop unticked', () => {
		const branches = ['main', 'develop', 'release/2026.12', 'release/2026.10', 'release/2026.11'];
		expect(releaseTargets('release/2026.10', branches)).toEqual([
			{ branch: 'release/2026.11', ticked: true },
			{ branch: 'release/2026.12', ticked: true },
			{ branch: 'develop', ticked: false },
		]);
		expect(releaseMergeBranch('release/2026.10', 'release/2026.12')).toBe('merge/2026.10-into-2026.12');
		expect(releaseMergeMr('release/2026.10', 'develop', ['ACME-1'], true).description).toContain('- ACME-1');
	});

	it('reads git merge-tree output', () => {
		expect(parseMergeTree('abc123\n', 0)).toEqual({ clean: true, files: [] });
		expect(parseMergeTree('abc123\na.ts\nb.ts\n\nAuto-merging a.ts\nCONFLICT (content)\n', 1)).toEqual({ clean: false, files: ['a.ts', 'b.ts'] });
	});

	it('writes fix prompts with the findings, logs and threads', () => {
		const findings = findingsFromSnyk([{ id: 'SNYK-1', severity: 'high', title: 'SSRF', where: 'axios@1.6.0', fix: 'upgrade to axios@1.7.4' }], false);
		expect(checksFixPrompt(findings)).toContain('- Snyk (dependencies) [high] SSRF · axios@1.6.0 · upgrade to axios@1.7.4');
		const prompt = mrFixPrompt({ iid: 318, url: 'u' }, [{ name: 'test:e2e', id: 9, log: 'FAIL' }], [{ id: 'd1', author: 'tom.k', body: 'Trim it?', path: 'a.ts', line: 3 }]);
		expect(prompt).toMatch(/^Fix the failing pipeline job and this review comment on merge request !318/);
		expect(prompt).toContain('[discussion d1] tom.k on a.ts:3: Trim it?');
		expect(prompt).toContain('gitlab_reply');
	});
});

describe('release merges in git', () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function repo() {
		dir = mkdtempSync(path.join(os.tmpdir(), 'release-merge-'));
		const origin = path.join(dir, 'origin');
		const clone = path.join(dir, 'clone');
		const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
		execFileSync('git', ['init', '--quiet', '-b', 'main', origin]);
		writeFileSync(path.join(origin, 'a.txt'), 'one\n');
		writeFileSync(path.join(origin, 'b.txt'), 'b\n');
		run(origin, 'add', '.');
		run(origin, 'commit', '--quiet', '-m', 'base');
		run(origin, 'branch', 'release/1.0');
		run(origin, 'branch', 'release/1.1');
		run(origin, 'checkout', '--quiet', 'release/1.0');
		writeFileSync(path.join(origin, 'a.txt'), 'fixed\n');
		run(origin, 'commit', '--quiet', '-am', 'fix');
		run(origin, 'checkout', '--quiet', 'main');
		writeFileSync(path.join(origin, 'a.txt'), 'changed on main\n');
		run(origin, 'commit', '--quiet', '-am', 'main work');
		execFileSync('git', ['clone', '--quiet', origin, clone]);
		run(clone, 'config', 'user.name', 't');
		run(clone, 'config', 'user.email', 't@t');
		return { clone, home: dir };
	}

	it('tells a clean merge from a conflicting one without touching the checkout', async () => {
		const { clone } = repo();
		expect(await checkMerge(clone, 'origin', 'release/1.0', 'release/1.1')).toEqual({ target: 'release/1.1', behind: 1, clean: true, conflicts: [] });
		expect(await checkMerge(clone, 'origin', 'release/1.0', 'main')).toEqual({ target: 'main', behind: 1, clean: false, conflicts: ['a.txt'] });
		expect(execFileSync('git', ['status', '--porcelain'], { cwd: clone }).toString()).toBe('');
	});

	it('merges in a worktree of its own, leaving conflicts for an agent', async () => {
		const { clone, home } = repo();
		const clean = await mergeInWorktree(clone, 'origin', 'release/1.0', 'release/1.1', 'merge/1.0-into-1.1', home);
		expect(clean.kind).toBe('merged');
		expect(await mergeUnfinished(clean.worktree.folder)).toBe(false);
		const conflicted = await mergeInWorktree(clone, 'origin', 'release/1.0', 'main', 'merge/1.0-into-main', home);
		expect(conflicted).toMatchObject({ kind: 'conflicts', files: ['a.txt'] });
		expect(await mergeUnfinished(conflicted.worktree.folder)).toBe(true);
		for (const w of [clean.worktree, conflicted.worktree]) {
			execFileSync('git', ['worktree', 'remove', '--force', w.folder], { cwd: clone });
		}
	});
});
