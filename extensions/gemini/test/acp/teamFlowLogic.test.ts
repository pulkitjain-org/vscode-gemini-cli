/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { checksFixPrompt, findingsFromSnyk, mrFixPrompt, parseReviewFindings, parseSuggestion, reviewPrompt, reviewSummary, suggestPrompt, targetChoices, ticketBranchName } from '../../src/acp/teamFlowLogic';

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

	it('marks the fix version, the project default, recent targets and the unusual ones', () => {
		const choices = targetChoices(['develop', 'release/2026.11', 'VCAN-31542-revamp'], { fixVersions: ['2026.11'], defaultTarget: 'develop', recent: ['VCAN-31542-revamp', 'gone'] });
		expect(choices).toEqual([
			{ branch: 'release/2026.11', release: true, suggested: true, fixVersion: '2026.11', usual: true },
			{ branch: 'develop', release: false, suggested: false, projectDefault: true, usual: true },
			{ branch: 'VCAN-31542-revamp', release: false, suggested: false, recent: true, usual: false },
		]);
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

	it('reads a finding\'s suggested change and range, and replies to threads', () => {
		const reply = '```json\n[{"kind":"bug","file":"a.ts","line":4,"endLine":5,"title":"Secret","comment":"Use the env.","suggestion":"pw: env.PW,\\n"},{"kind":"question","discussion":"d7","comment":"Agreed.","file":"x.ts","line":1},{"kind":"nit","file":"b.ts","endLine":9,"comment":"No line, so no range or suggestion.","suggestion":"x"}]\n```';
		expect(parseReviewFindings(reply)).toEqual([
			{ kind: 'bug', file: 'a.ts', line: 4, endLine: 5, title: 'Secret', comment: 'Use the env.', suggestion: 'pw: env.PW,' },
			{ kind: 'question', title: 'Agreed.', comment: 'Agreed.', discussion: 'd7' },
			{ kind: 'nit', file: 'b.ts', title: 'No line, so no range or suggestion.', comment: 'No line, so no range or suggestion.' },
		]);
	});

	it('asks for a suggestion on a few lines and reads the answer', () => {
		const prompt = suggestPrompt('src/a.ts', 12, 13, 'Use the constant.');
		expect(prompt.split('\n').slice(0, 3)).toEqual(['Suggest a change to lines 12 to 13 of src/a.ts (in your folder, the merge request\'s version) for this review comment:', '', '> Use the constant.']);
		expect(prompt).toContain('sed -n \'7,18p\' src/a.ts');
		expect([parseSuggestion('Here:\n```json\n{"suggestion": "const c = LIMIT;\\n"}\n```'), parseSuggestion('```json\n{"suggestion": null}\n```'), parseSuggestion('No block')]).toEqual(['const c = LIMIT;', null, undefined]);
	});

	it('has a reviewer read the diff a few files at a time from the fetched target, never fetching itself', () => {
		const mr = { iid: 706, title: 'Landing page', url: 'u', author: 'hh', sourceBranch: 'VCAN-1-landing', targetBranch: 'develop' };
		const files = Array.from({ length: 62 }, (_, i) => `src/f${i}.ts`);
		const prompt = reviewPrompt(mr, 'VCAN-1', 'upstream', files).split('\n');
		expect(prompt.filter(line => /upstream\/develop|changed files|^- src\/f(0|59|60)\.ts$/.test(line))).toEqual([
			'1. Read it with gitlab_get_mr. Its target, upstream/develop, is already fetched: don\'t run git fetch, which can\'t sign in from your shell.',
			'2. Start from `git diff --stat upstream/develop...HEAD`, then read the diff a few files at a time with `git diff upstream/develop...HEAD -- <files>`. Never print the whole diff, or a log with patches, in one command: it can be bigger than you can read.',
			'GitLab lists 62 changed files, the first 60 here:',
			'- src/f0.ts',
			'- src/f59.ts',
		]);
		const withThreads = reviewPrompt(mr, undefined, 'origin', [], [{ id: 'd1', author: 'tom.k', body: 'Why a\nfixed wait?', path: 'a.ts', line: 52 }]);
		expect(withThreads).toContain('- [discussion d1] tom.k on a.ts:52: Why a fixed wait?');
		expect(withThreads).toContain('give `"discussion"` (its id)');
		expect(reviewPrompt(mr)).not.toContain('discussion');
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
