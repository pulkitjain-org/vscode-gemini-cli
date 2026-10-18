/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The team flows' pure parts (src/host/teamFlows.ts): the prompts GeminiCode
// sends an agent (start on a ticket, fix checks, fix a merge request, review
// one), parsing an agent's review back into draft comments, and the target
// branches Open Merge Request offers. Nothing here calls a tool or touches a file.

import type { SnykFinding } from './snyk';
import type { SonarIssue } from './sonar';
import { isReleaseBranch, releaseBranchForVersion, sortReleaseBranches } from './teamDefaults';

/** A branch name for a ticket: `ACME-412-gift-message-at-checkout`. */
export function ticketBranchName(key: string, summary: string): string {
	const slug = summary.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
	return slug ? `${key}-${slug}` : key;
}

/** The first prompt of an agent started on a ticket. */
export function ticketStartPrompt(key: string, summary: string): string {
	return [
		`Work on the Jira ticket ${key}: ${summary}.`,
		'',
		`1. Read the ticket with jira_get_issue, including its acceptance criteria and links. If it links a Figma frame, read it with figma_design.`,
		'2. Read the code it touches and write a short plan that cites the acceptance criteria. Wait for my OK before changing anything.',
		'3. Then build it, with tests, and run the tests.',
	].join('\n');
}

/** One check finding, as the Checks page shows it and an agent gets it. */
export interface CheckFinding {
	readonly id: string;
	readonly source: 'snyk' | 'snykCode' | 'sonar';
	readonly severity: string;
	readonly title: string;
	/** `package@version`, or `file:line`. */
	readonly where: string;
	readonly file?: string;
	readonly line?: number;
	readonly fix?: string;
	readonly url?: string;
}

export function findingsFromSnyk(findings: readonly SnykFinding[], code: boolean): CheckFinding[] {
	return findings.map((f, i) => ({
		id: `${code ? 'snykCode' : 'snyk'}-${i}`,
		source: code ? 'snykCode' : 'snyk',
		severity: f.severity,
		title: f.title,
		where: f.where,
		...f.file ? { file: f.file } : {},
		...f.line ? { line: f.line } : {},
		...f.fix ? { fix: f.fix } : {},
	}));
}

export function findingsFromSonar(issues: readonly SonarIssue[]): CheckFinding[] {
	return issues.map((issue, i) => ({
		id: `sonar-${i}`,
		source: 'sonar',
		severity: issue.severity.toLowerCase(),
		title: issue.message,
		where: issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''}` : '',
		...issue.file ? { file: issue.file } : {},
		...issue.line ? { line: issue.line } : {},
		fix: issue.rule,
		url: issue.url,
	}));
}

const sourceNames: Record<CheckFinding['source'], string> = { snyk: 'Snyk (dependencies)', snykCode: 'Snyk Code', sonar: 'SonarQube' };

/** The prompt that asks an agent to fix `findings`. */
export function checksFixPrompt(findings: readonly CheckFinding[]): string {
	const lines = [findings.length === 1 ? 'Fix this finding from the checks:' : `Fix these ${findings.length} findings from the checks:`, ''];
	for (const f of findings) {
		lines.push(`- ${sourceNames[f.source]} [${f.severity}] ${f.title}${f.where ? ` · ${f.where}` : ''}${f.fix ? ` · ${f.source === 'sonar' ? `rule ${f.fix}` : f.fix}` : ''}`);
	}
	lines.push('', 'Keep each fix small. For a dependency, upgrade to the fixed version and update the lockfile with the package manager. Run the tests afterwards, and say what you changed for each.');
	return lines.join('\n');
}

export interface MrThreadForFix {
	readonly id: string;
	readonly author: string;
	readonly body: string;
	readonly path?: string;
	readonly line?: number;
}

/** The prompt that sends a failed pipeline and review threads to the agent on the MR's branch. */
export function mrFixPrompt(mr: { readonly iid: number; readonly url: string }, jobs: readonly { readonly name: string; readonly id: number; readonly log: string }[], threads: readonly MrThreadForFix[]): string {
	const parts: string[] = [];
	const asks = [jobs.length ? 'the failing pipeline job' + (jobs.length > 1 ? 's' : '') : '', threads.length ? `${threads.length === 1 ? 'this review comment' : 'these review comments'}` : ''].filter(Boolean).join(' and ');
	parts.push(`Fix ${asks} on merge request !${mr.iid} (${mr.url}), commit, run the tests, then push.`);
	for (const job of jobs) {
		parts.push('', `Job ${job.name} (job ${job.id}), end of its log:`, '```', job.log.trim(), '```');
	}
	if (threads.length) {
		parts.push('', 'Review threads:');
		for (const t of threads) {
			parts.push(`- [discussion ${t.id}] ${t.author}${t.path ? ` on ${t.path}${t.line ? `:${t.line}` : ''}` : ''}: ${t.body.trim().replace(/\n/g, '\n  ')}`);
		}
		parts.push('', 'After pushing, draft a one-line reply to each thread saying what you changed (with the commit), and post each with gitlab_reply and resolve: true. I approve each reply first.');
	}
	return parts.join('\n');
}

/** A draft review comment from the agent's review of someone else's MR. */
export interface ReviewFinding {
	readonly kind: 'bug' | 'shouldFix' | 'nit' | 'question';
	readonly file?: string;
	readonly line?: number;
	readonly title: string;
	readonly comment: string;
}

/** The prompt for reviewing merge request `mr`, checked out in the agent's worktree. */
export function reviewPrompt(mr: { readonly iid: number; readonly title: string; readonly url: string; readonly author: string; readonly sourceBranch: string; readonly targetBranch: string }, ticket?: string): string {
	return [
		`Review merge request !${mr.iid} "${mr.title}" by ${mr.author} (${mr.url}). It is checked out in your folder on ${mr.sourceBranch}; it merges into ${mr.targetBranch}.`,
		'',
		`1. Read it with gitlab_get_mr, and the diff against the target with \`git diff origin/${mr.targetBranch}...HEAD\`.`,
		ticket ? `2. Read the linked Jira ticket ${ticket} with jira_get_issue and check the change does what it asks.` : '2. If it links a Jira ticket, read it with jira_get_issue and check the change does what it asks.',
		'3. Look for bugs, missing tests, security and performance problems. Don\'t edit any file, and don\'t post anything to GitLab: I choose what to post.',
		'',
		'Start with two or three sentences on what the change does and whether it is ready. Then end your reply with the findings as a JSON block, worst first, like this:',
		'```json',
		'[{"kind": "bug", "file": "src/a.ts", "line": 58, "title": "Short title", "comment": "The comment to post, written to the author."}]',
		'```',
		'`kind` is one of bug, shouldFix, nit, question. `line` is a line in the new version of the file. Use [] when there is nothing to raise.',
	].join('\n');
}

/** The review findings in an agent's reply: the last ```json block that holds a list of findings. */
export function parseReviewFindings(text: string): ReviewFinding[] | undefined {
	const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
	for (const block of blocks.reverse()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(block);
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) {
			continue;
		}
		return parsed.flatMap((raw): ReviewFinding[] => {
			if (!raw || typeof raw !== 'object') {
				return [];
			}
			const r = raw as Record<string, unknown>;
			const comment = typeof r.comment === 'string' ? r.comment.trim() : '';
			if (!comment) {
				return [];
			}
			const kind = r.kind === 'bug' || r.kind === 'shouldFix' || r.kind === 'nit' || r.kind === 'question' ? r.kind : 'shouldFix';
			const line = Number(r.line);
			return [{
				kind,
				...typeof r.file === 'string' && r.file ? { file: r.file.replace(/^\.?\//, '') } : {},
				...Number.isInteger(line) && line > 0 ? { line } : {},
				title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : comment.split('\n')[0].slice(0, 80),
				comment,
			}];
		});
	}
	return undefined;
}

/** The agent's summary: its reply without the findings block. */
export function reviewSummary(text: string): string {
	return text.replace(/```(?:json)?\s*\n[\s\S]*?```/g, '').trim();
}

/** A branch Open Merge Request offers as the target. */
export interface TargetChoice {
	readonly branch: string;
	readonly release: boolean;
	/** The ticket's fix version names it. */
	readonly suggested: boolean;
}

/**
 * The target branches, release branches first (newest first), then develop
 * and main, then the rest; the one the ticket's fix version names is
 * suggested, else the team's default target.
 */
export function targetChoices(branches: readonly string[], options: { readonly releasePattern?: string; readonly fixVersions?: readonly string[]; readonly defaultTarget?: string; readonly source?: string } = {}): TargetChoice[] {
	const names = branches.filter(b => b !== options.source);
	const releases = sortReleaseBranches(names.filter(b => isReleaseBranch(b, options.releasePattern))).reverse();
	const suggestedRelease = (options.fixVersions ?? []).map(v => releaseBranchForVersion(v, releases)).find(Boolean);
	const suggested = suggestedRelease ?? (options.defaultTarget && names.includes(options.defaultTarget) ? options.defaultTarget : undefined);
	const main = ['develop', 'development', 'main', 'master'].filter(b => names.includes(b));
	const rest = names.filter(b => !releases.includes(b) && !main.includes(b)).sort();
	return [...releases, ...main, ...rest].map(branch => ({ branch, release: releases.includes(branch), suggested: branch === suggested }));
}

/** The direct request that drafts a merge request's description. */
export function mrDescriptionRequest(input: { readonly title: string; readonly ticket?: { readonly key: string; readonly summary: string; readonly description: string; readonly url: string }; readonly commits: string; readonly diffStat: string; readonly diff: string; readonly target: string }): { readonly system: string; readonly prompt: string } {
	return {
		system: [
			'You write GitLab merge request descriptions for a development team. Write Markdown only, with no preamble and no code fence around it.',
			'Shape: a first line "Closes [KEY](url)" when there is a Jira ticket; then "### What changes" with 2 to 5 short bullets a reviewer can check; then "### How to test" with numbered steps. Add "### Notes" only for a risk, a migration or a follow-up.',
			'Plain words, no marketing, no file-by-file list, nothing the diff does not show.',
		].join('\n'),
		prompt: [
			`Title: ${input.title}`,
			`Target branch: ${input.target}`,
			...input.ticket ? [`Jira ticket ${input.ticket.key} (${input.ticket.url}): ${input.ticket.summary}`, input.ticket.description.slice(0, 4000)] : [],
			'',
			'Commits:',
			input.commits.slice(0, 3000),
			'',
			'Files changed:',
			input.diffStat.slice(0, 3000),
			'',
			'Diff (may be cut):',
			input.diff.slice(0, 24_000),
		].join('\n'),
	};
}

/** The direct request that drafts the Jira comment for a status change. */
export function jiraCommentRequest(input: { readonly key: string; readonly summary: string; readonly to: string; readonly mr?: { readonly iid: number; readonly url: string; readonly target: string } }): { readonly system: string; readonly prompt: string } {
	return {
		system: 'You write a short Jira comment (one to three sentences, plain text, no Markdown) a developer adds when moving their ticket to another status. Say what is done and where to look. No greeting, no sign-off.',
		prompt: [
			`Ticket ${input.key}: ${input.summary}`,
			`Moving to: ${input.to}`,
			...input.mr ? [`Merge request !${input.mr.iid} into ${input.mr.target}: ${input.mr.url}`] : [],
		].join('\n'),
	};
}

