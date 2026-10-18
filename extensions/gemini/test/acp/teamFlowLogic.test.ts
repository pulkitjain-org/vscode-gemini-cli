/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { checksFixPrompt, findingsFromSnyk, mrFixPrompt, parseReviewFindings, reviewSummary, targetChoices, ticketBranchName } from '../../src/acp/teamFlowLogic';

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

	it('writes fix prompts with the findings, logs and threads', () => {
		const findings = findingsFromSnyk([{ id: 'SNYK-1', severity: 'high', title: 'SSRF', where: 'axios@1.6.0', fix: 'upgrade to axios@1.7.4' }], false);
		expect(checksFixPrompt(findings)).toContain('- Snyk (dependencies) [high] SSRF · axios@1.6.0 · upgrade to axios@1.7.4');
		const prompt = mrFixPrompt({ iid: 318, url: 'u' }, [{ name: 'test:e2e', id: 9, log: 'FAIL' }], [{ id: 'd1', author: 'tom.k', body: 'Trim it?', path: 'a.ts', line: 3 }]);
		expect(prompt).toMatch(/^Fix the failing pipeline job and this review comment on merge request !318/);
		expect(prompt).toContain('[discussion d1] tom.k on a.ts:3: Trim it?');
		expect(prompt).toContain('gitlab_reply');
	});
});
