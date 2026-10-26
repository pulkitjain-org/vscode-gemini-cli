/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The team flows' pure parts (src/host/teamFlows.ts): the prompts GeminiCode
// sends an agent (start on a ticket, fix checks, fix a merge request, review
// one), parsing an agent's review back into draft comments, and the target
// branches Open Merge Request offers. Nothing here calls a tool or touches a file.

import type { SnykFinding } from './snyk';
import type { SonarIssue } from './sonar';
import { isReleaseBranch, releaseBranchForVersion, sortReleaseBranches } from './teamDefaults';
import { external } from './externalText';

/** Where a flow works, and whether the window gave no hint between several folders, which a picker would settle. */
export interface WorkFolder {
	readonly folder?: string;
	/** Several folders are open and neither the agent in front nor the active editor says which: `folder` is the first. */
	readonly ambiguous: boolean;
}

/**
 * The folder a team flow (Start on Ticket, Run Checks, the team's defaults)
 * works in: the agent in front's workspace, else the active editor's folder,
 * else the first open folder.
 */
export function resolveWorkFolder(hints: { readonly agentFolder?: string; readonly editorFolder?: string; readonly folders: readonly string[] }): WorkFolder {
	const hinted = hints.agentFolder ?? hints.editorFolder;
	if (hinted) {
		return { folder: hinted, ambiguous: false };
	}
	return { ...hints.folders.length ? { folder: hints.folders[0] } : {}, ambiguous: hints.folders.length > 1 };
}

/** One choice of "Run Checks in which folder?": the agent last in front, or an open folder. */
export interface WorkFolderChoice {
	/** The agent's id, for the agent's own choice. */
	readonly agent?: string;
	/** What it is called: the agent's title, or the folder's name. */
	readonly label: string;
	/** Where it works, shown under the label: the agent's own folder, or the open folder. */
	readonly path: string;
	/** The folder the flow works in: the agent's workspace, or the open folder. */
	readonly folder: string;
}

/**
 * The choices when `resolveWorkFolder` found the window ambiguous: the agent
 * last in front first (when there is one), then each open folder, once each.
 */
export function workFolderChoices(agent: { readonly id: string; readonly title: string; readonly cwd: string; readonly folder: string } | undefined, folders: readonly string[]): WorkFolderChoice[] {
	const name = (folder: string) => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
	return [
		...agent ? [{ agent: agent.id, label: agent.title, path: agent.cwd, folder: agent.folder }] : [],
		...[...new Set(folders)].map(folder => ({ label: name(folder), path: folder, folder })),
	];
}

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

/** The issues SonarQube's analysers found on this Mac in the branch's changed files. */
export function findingsFromLocalSonar(issues: readonly { readonly file: string; readonly line?: number; readonly rule: string; readonly message: string; readonly severity: string }[]): CheckFinding[] {
	return issues.map((issue, i) => ({
		id: `sonar-local-${i}`,
		source: 'sonar',
		severity: issue.severity.toLowerCase(),
		title: issue.message,
		where: `${issue.file}${issue.line ? `:${issue.line}` : ''}`,
		file: issue.file,
		...issue.line ? { line: issue.line } : {},
		fix: issue.rule,
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

/**
 * The prompt that sends a failed pipeline and review threads to the agent on
 * the MR's branch. The job logs and the threads are other people's text, so
 * they are framed as data. The agent commits but doesn't push: its shell
 * can't sign in to GitLab, so GeminiCode pushes when the turn ends, then asks
 * for the thread replies (`mrFixRepliesPrompt`).
 */
export function mrFixPrompt(mr: { readonly iid: number; readonly url: string }, jobs: readonly { readonly name: string; readonly id: number; readonly log: string }[], threads: readonly MrThreadForFix[]): string {
	const parts: string[] = [];
	const asks = [jobs.length ? 'the failing pipeline job' + (jobs.length > 1 ? 's' : '') : '', threads.length ? `${threads.length === 1 ? 'this review comment' : 'these review comments'}` : ''].filter(Boolean).join(' and ');
	parts.push(`Fix ${asks} on merge request !${mr.iid} (${mr.url}). Commit your changes and run the tests. Don't push: your shell can't sign in to GitLab, so GeminiCode pushes your commits when your turn ends.`);
	for (const job of jobs) {
		parts.push('', `Job ${job.name} (job ${job.id}), end of its log:`, external('gitlab', `job ${job.id}`, job.log.trim()));
	}
	if (threads.length) {
		parts.push('', 'Review threads:', external('gitlab', `!${mr.iid} threads`, threads.map(threadLine).join('\n')));
		parts.push('', 'Once your commits are pushed, I\'ll ask you to reply to each thread.');
	}
	return parts.join('\n');
}

/** After GeminiCode pushed a fix agent's commits: reply to each thread the fix was for. */
export function mrFixRepliesPrompt(pushed: { readonly branch: string; readonly head: string; readonly commits: number }, threads: readonly Pick<MrThreadForFix, 'id'>[]): string {
	return [
		`GeminiCode pushed your ${pushed.commits === 1 ? 'commit' : `${pushed.commits} commits`} to ${pushed.branch} (now at ${pushed.head.slice(0, 8)}).`,
		`Now draft a one-line reply to ${threads.length === 1 ? 'the review thread' : `each of the ${threads.length} review threads`} (${threads.map(t => `discussion ${t.id}`).join(', ')}) saying what you changed, with the commit, and post each with gitlab_reply and resolve: true. I approve each reply first.`,
	].join('\n');
}

function threadLine(t: MrThreadForFix): string {
	return `- [discussion ${t.id}] ${t.author}${t.path ? ` on ${t.path}${t.line ? `:${t.line}` : ''}` : ''}: ${t.body.trim().replace(/\n/g, '\n  ')}`;
}

/** A draft review comment from the agent's review of someone else's MR. */
export interface ReviewFinding {
	readonly kind: 'bug' | 'shouldFix' | 'nit' | 'question';
	readonly file?: string;
	readonly line?: number;
	/** The last line the comment covers, when it covers more than `line`. */
	readonly endLine?: number;
	readonly title: string;
	readonly comment: string;
	/** Text that replaces lines `line` to `endLine`, posted as a GitLab suggestion. */
	readonly suggestion?: string;
	/** A reply to this thread of the merge request rather than a new comment. */
	readonly discussion?: string;
}

/** One of the merge request's open threads, as a review prompt lists it. */
export interface ReviewThread {
	readonly id: string;
	readonly author: string;
	readonly body: string;
	readonly path?: string;
	readonly line?: number;
}

/** Open threads a review prompt lists, at most, and how much of each. */
const maxPromptThreads = 30;
const maxThreadText = 300;

/** Changed files a review prompt names; GitLab's list and `git diff --stat` give the rest. */
const maxReviewFiles = 60;

/**
 * The prompt for reviewing merge request `mr`, checked out in the agent's
 * worktree with `remote`'s target branch fetched for it. The agent's shell
 * can't sign in to fetch, and a whole diff can outgrow the model's context
 * (the CLI caps no tool output in ACP mode), so it reads the diff a few files
 * at a time from GitLab's list of `files`.
 */
export function reviewPrompt(mr: { readonly iid: number; readonly title: string; readonly url: string; readonly author: string; readonly sourceBranch: string; readonly targetBranch: string }, ticket?: string, remote = 'origin', files: readonly string[] = [], threads: readonly ReviewThread[] = []): string {
	const range = `${remote}/${mr.targetBranch}...HEAD`;
	const shown = files.slice(0, maxReviewFiles);
	const listed = threads.slice(0, maxPromptThreads);
	return [
		`Review merge request !${mr.iid} by ${mr.author} (${mr.url}). It is checked out in your folder on ${mr.sourceBranch}; it merges into ${mr.targetBranch}. Its title, as the author wrote it:`,
		external('gitlab', `!${mr.iid}`, mr.title),
		'',
		`1. Read it with gitlab_get_mr. Its target, ${remote}/${mr.targetBranch}, is already fetched: don't run git fetch, which can't sign in from your shell.`,
		`2. Start from \`git diff --stat ${range}\`, then read the diff a few files at a time with \`git diff ${range} -- <files>\`. Never print the whole diff, or a log with patches, in one command: it can be bigger than you can read.`,
		ticket ? `3. Read the linked Jira ticket ${ticket} with jira_get_issue and check the change does what it asks.` : '3. If it links a Jira ticket, read it with jira_get_issue and check the change does what it asks.',
		'4. Look for bugs, missing tests, security and performance problems. Don\'t edit any file, and don\'t post anything to GitLab: I choose what to post.',
		...shown.length ? [
			'',
			`GitLab lists ${files.length === 1 ? '1 changed file' : `${files.length} changed files`}${files.length > shown.length ? `, the first ${shown.length} here` : ''}:`,
			...shown.map(file => `- ${file}`),
		] : [],
		...listed.length ? [
			'',
			`Reviewers already opened ${threads.length === 1 ? 'this thread' : `these ${threads.length} threads`}${threads.length > listed.length ? `, the first ${listed.length} here` : ''}. Don't raise what they already raised:`,
			external('gitlab', `!${mr.iid} threads`, listed.map(t => `- [discussion ${t.id}] ${t.author}${t.path ? ` on ${t.path}${t.line ? `:${t.line}` : ''}` : ''}: ${oneLine(t.body, maxThreadText)}`).join('\n')),
		] : [],
		'',
		'Start with two or three sentences on what the change does and whether it is ready. Then end your reply with the findings as a JSON block, worst first, like this:',
		'```json',
		'[{"kind": "bug", "file": "src/a.ts", "line": 58, "title": "Short title", "comment": "The comment to post, written to the author."}]',
		'```',
		'`kind` is one of bug, shouldFix, nit, question. `line` is a line in the new version of the file. Use [] when there is nothing to raise.',
		'When the fix is small and certain, add `"suggestion"`: the exact text that replaces lines `line` to `endLine` (`endLine` defaults to `line`), indented as in the file. Only for lines the merge request changes.',
		...listed.length ? ['To add to one of the threads above instead, give `"discussion"` (its id) and `"comment"`, the reply, without `file` or `line`. Only when you have something the thread lacks.'] : [],
	].join('\n');
}

/** `text` on one line, cut to `max` characters. */
function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The request for a suggested change to lines `line` to `endLine` of `file`,
 * for one comment: the reviewer reads only those lines and answers with a
 * JSON block (`parseSuggestion`).
 */
export function suggestPrompt(file: string, line: number, endLine: number, comment: string): string {
	const range = endLine > line ? `lines ${line} to ${endLine}` : `line ${line}`;
	return [
		`Suggest a change to ${range} of ${file} (in your folder, the merge request's version) for this review comment:`,
		'',
		...comment.trim().split('\n').map(l => `> ${l}`),
		'',
		`Read only those lines and a few around them, for example with \`sed -n '${Math.max(1, line - 5)},${endLine + 5}p' ${file}\`. Don't edit any file, and don't post anything.`,
		`Then end your reply with a JSON block holding the exact text that replaces ${range}, indented as in the file:`,
		'```json',
		'{"suggestion": "the new text"}',
		'```',
		'Use {"suggestion": null} when no small change does it.',
	].join('\n');
}

/** The suggested text in an agent's answer to `suggestPrompt`: null when it has none, undefined when there is no block. */
export function parseSuggestion(text: string): string | null | undefined {
	const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
	for (const block of blocks.reverse()) {
		try {
			const parsed = JSON.parse(block) as unknown;
			const value = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { suggestion?: unknown }).suggestion : undefined;
			if (typeof value === 'string') {
				return value.replace(/\n$/, '');
			}
			if (value === null) {
				return null;
			}
		} catch {
			// Not the answer's block.
		}
	}
	return undefined;
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
			const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : comment.split('\n')[0].slice(0, 80);
			if (typeof r.discussion === 'string' && r.discussion.trim()) {
				return [{ kind, title, comment, discussion: r.discussion.trim() }];
			}
			const line = Number(r.line);
			const endLine = Number(r.endLine);
			const hasLine = Number.isInteger(line) && line > 0;
			return [{
				kind,
				...typeof r.file === 'string' && r.file ? { file: r.file.replace(/^\.?\//, '') } : {},
				...hasLine ? { line } : {},
				...hasLine && Number.isInteger(endLine) && endLine > line ? { endLine } : {},
				title,
				comment,
				...hasLine && typeof r.suggestion === 'string' ? { suggestion: r.suggestion.replace(/\n$/, '') } : {},
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
	/** The ticket's fix version names it, or (without one) it is the team's default target. */
	readonly suggested: boolean;
	/** The fix version that names it. */
	readonly fixVersion?: string;
	/** The team's default target. */
	readonly projectDefault?: boolean;
	/** A target the user chose before in this project. */
	readonly recent?: boolean;
	/** A usual target: develop, main or a release branch. */
	readonly usual: boolean;
}

const mainBranches = ['develop', 'development', 'main', 'master'];

/** Whether `branch` is a usual merge target: develop, main or a release branch. */
export function isUsualTarget(branch: string, releasePattern?: string): boolean {
	return mainBranches.includes(branch) || isReleaseBranch(branch, releasePattern);
}

/**
 * The target branches, release branches first (newest first), then develop
 * and main, then the rest; the one the ticket's fix version names is
 * suggested, else the team's default target. `recent` are the targets the
 * user chose before in this project, the last first.
 */
export function targetChoices(branches: readonly string[], options: { readonly releasePattern?: string; readonly fixVersions?: readonly string[]; readonly defaultTarget?: string; readonly source?: string; readonly recent?: readonly string[] } = {}): TargetChoice[] {
	const names = branches.filter(b => b !== options.source);
	const releases = sortReleaseBranches(names.filter(b => isReleaseBranch(b, options.releasePattern))).reverse();
	const fixVersion = (options.fixVersions ?? []).find(v => releaseBranchForVersion(v, releases));
	const suggestedRelease = fixVersion ? releaseBranchForVersion(fixVersion, releases) : undefined;
	const projectDefault = options.defaultTarget && names.includes(options.defaultTarget) ? options.defaultTarget : undefined;
	const suggested = suggestedRelease ?? projectDefault;
	const main = mainBranches.filter(b => names.includes(b));
	const rest = names.filter(b => !releases.includes(b) && !main.includes(b)).sort();
	const recent = (options.recent ?? []).filter(b => names.includes(b));
	return [...releases, ...main, ...rest].map(branch => ({
		branch,
		release: releases.includes(branch),
		suggested: branch === suggested,
		...branch === suggestedRelease && fixVersion ? { fixVersion } : {},
		...branch === projectDefault ? { projectDefault: true } : {},
		...recent.includes(branch) ? { recent: true } : {},
		usual: releases.includes(branch) || main.includes(branch),
	}));
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

