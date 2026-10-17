/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Jira tickets, GitLab merge requests and issues, and Figma frames named in
// text the user writes (a key such as ACME-412, or a link), for the
// composer's chips, and friendly titles for the geminicode-tools calls in
// the chat. Shared with the webview, so this module must not import Node or
// VS Code.

export type ToolRef =
	| { readonly tool: 'jira'; readonly key: string }
	| { readonly tool: 'gitlab'; readonly kind: 'mr' | 'issue'; readonly project: string; readonly iid: number; readonly url: string }
	| { readonly tool: 'figma'; readonly url: string; readonly fileKey: string; readonly nodeId?: string };

/** What the view knows of the user's tools, to tell a ticket key from other text. */
export interface ToolRefContext {
	/** The tools the user has connected; refs to other tools aren't found. */
	readonly connected: readonly string[];
	/** The team's Jira projects (from .gemini/geminicode-tools.json), whose keys count in lower case too. */
	readonly jiraProjects?: readonly string[];
}

const jiraKey = /(?:^|[^A-Za-z0-9_-])([A-Z][A-Z0-9_]{1,15}-[1-9]\d{0,6})(?![\w-])/g;
const lowerKey = /(?:^|[^A-Za-z0-9_-])([A-Za-z][A-Za-z0-9]{1,15})-([1-9]\d{0,6})(?![\w-])/g;
const links = /https?:\/\/[^\s<>"'`)\]]+/g;

/** The ref of one link, or undefined when it isn't a Jira, GitLab or Figma one. */
export function parseToolLink(link: string): ToolRef | undefined {
	let url: URL;
	try {
		url = new URL(link.replace(/[.,;:!?]+$/, ''));
	} catch {
		return undefined;
	}
	if (/(^|\.)figma\.com$/i.test(url.hostname)) {
		const fileKey = /^\/(?:design|file|proto)\/([\w-]+)/.exec(url.pathname)?.[1];
		const node = url.searchParams.get('node-id');
		return fileKey ? { tool: 'figma', url: url.href, fileKey, ...node ? { nodeId: node.replace(/-/g, ':') } : {} } : undefined;
	}
	const issueKey = /^\/browse\/([A-Z][A-Z0-9_]{1,15}-\d+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('selectedIssue') ?? '';
	if (/^[A-Z][A-Z0-9_]{1,15}-\d+$/.test(issueKey)) {
		return { tool: 'jira', key: issueKey };
	}
	const gitlab = /^\/(.+?)\/-\/(merge_requests|issues|work_items)\/(\d+)/.exec(url.pathname);
	if (gitlab) {
		const project = decodeURIComponent(gitlab[1]);
		const iid = Number(gitlab[3]);
		const kind = gitlab[2] === 'merge_requests' ? 'mr' : 'issue';
		return { tool: 'gitlab', kind, project, iid, url: `${url.origin}/${project}/-/${gitlab[2]}/${iid}` };
	}
	return undefined;
}

/** The refs in `text` for the connected tools, once each, in order. */
export function findToolRefs(text: string, context: ToolRefContext): ToolRef[] {
	const connected = new Set(context.connected);
	const found: ToolRef[] = [];
	const seen = new Set<string>();
	const add = (ref: ToolRef | undefined) => {
		if (ref && connected.has(ref.tool) && !seen.has(toolRefId(ref))) {
			seen.add(toolRefId(ref));
			found.push(ref);
		}
	};
	const withoutLinks = text.replace(links, link => {
		add(parseToolLink(link));
		return ' ';
	});
	if (connected.has('jira')) {
		const projects = new Set((context.jiraProjects ?? []).map(p => p.toUpperCase()));
		for (const match of withoutLinks.matchAll(jiraKey)) {
			// With known projects, other upper-case keys (UTF-8, ISO-8601) aren't tickets.
			if (!projects.size || projects.has(match[1].split('-')[0])) {
				add({ tool: 'jira', key: match[1] });
			}
		}
		for (const match of withoutLinks.matchAll(lowerKey)) {
			if (projects.has(match[1].toUpperCase())) {
				add({ tool: 'jira', key: `${match[1].toUpperCase()}-${match[2]}` });
			}
		}
	}
	return found;
}

/** The ref when `text` is nothing but one ref (a pasted link or key). */
export function soleToolRef(text: string, context: ToolRefContext): ToolRef | undefined {
	const trimmed = text.trim();
	if (!trimmed || /\s/.test(trimmed)) {
		return undefined;
	}
	const refs = findToolRefs(trimmed, context);
	return refs.length === 1 ? refs[0] : undefined;
}

/** A stable id, for telling two refs to the same thing apart from others. */
export function toolRefId(ref: ToolRef): string {
	switch (ref.tool) {
		case 'jira': return `jira:${ref.key}`;
		case 'gitlab': return `gitlab:${ref.kind}:${ref.project}:${ref.iid}`;
		case 'figma': return `figma:${ref.fileKey}:${ref.nodeId ?? ''}`;
	}
}

/** The short name of a ref: ACME-412, !318, #45, or "Figma frame". */
export function toolRefLabel(ref: ToolRef): string {
	switch (ref.tool) {
		case 'jira': return ref.key;
		case 'gitlab': return ref.kind === 'mr' ? `!${ref.iid}` : `#${ref.iid}`;
		case 'figma': return ref.nodeId ? `Figma ${ref.nodeId}` : 'Figma';
	}
}

/** A geminicode-tools call as the CLI titles it: `jira_get_issue({"key":"ACME-1"})`, or the bare name. */
export function parseTeamToolCall(title: string): { readonly tool: 'jira' | 'gitlab' | 'sonar' | 'snyk' | 'figma'; readonly name: string; readonly args: Record<string, unknown> } | undefined {
	const match = /^(jira|gitlab|sonar|snyk|figma)_[a-z_]+/.exec(title.trim());
	if (!match) {
		return undefined;
	}
	const rest = title.trim().slice(match[0].length).trim();
	let args: Record<string, unknown> = {};
	const json = /^\((\{[\s\S]*\})\)/.exec(rest)?.[1] ?? (/^\{[\s\S]*\}$/.test(rest) ? rest : undefined);
	if (json) {
		try {
			const parsed = JSON.parse(json) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				args = parsed as Record<string, unknown>;
			}
		} catch {
			// Cut off or not JSON: the title stays as it is.
		}
	} else if (rest && !rest.startsWith('(')) {
		return undefined;
	}
	return { tool: match[1] as 'jira', name: match[0], args };
}

/** Verbs for the friendly titles; `{0}` is what the tool acted on. */
export interface TeamToolVerbs {
	readonly read: string;
	readonly search: string;
	readonly comment: string;
	readonly move: string;
	/** `{0}` is the time, `{1}` the ticket. */
	readonly logTime: string;
	readonly openMr: string;
	readonly reply: string;
	readonly listReview: string;
	readonly listMine: string;
	readonly jobLog: string;
	readonly qualityGate: string;
	readonly sonarIssues: string;
	readonly snykTest: string;
	readonly snykCode: string;
	readonly design: string;
	readonly screenshot: string;
	/** "this branch's merge request" */
	readonly currentMr: string;
}

export const englishTeamToolVerbs: TeamToolVerbs = {
	read: 'Read {0}',
	search: 'Search Jira for {0}',
	comment: 'Comment on {0}',
	move: 'Move {0}',
	logTime: 'Log {0} on {1}',
	openMr: 'Open merge request into {0}',
	reply: 'Reply on {0}',
	listReview: 'List merge requests waiting for my review',
	listMine: 'List my merge requests',
	jobLog: 'Read the CI log of {0}',
	qualityGate: 'Check the SonarQube quality gate',
	sonarIssues: 'Read SonarQube issues',
	snykTest: 'Run Snyk on the dependencies',
	snykCode: 'Run Snyk Code on the source',
	design: 'Read the Figma design',
	screenshot: 'Take a screenshot of the Figma frame',
	currentMr: 'this branch\'s merge request',
};

function fill(template: string, value: string): string {
	return template.replace('{0}', value);
}

/** "Read ACME-412", "Comment on !318": a friendly title for a geminicode-tools call, or undefined for other tools. */
export function teamToolTitle(title: string, verbs: TeamToolVerbs = englishTeamToolVerbs): { readonly tool: 'jira' | 'gitlab' | 'sonar' | 'snyk' | 'figma'; readonly title: string; readonly text?: string } | undefined {
	const call = parseTeamToolCall(title);
	if (!call) {
		return undefined;
	}
	const s = (key: string) => typeof call.args[key] === 'string' || typeof call.args[key] === 'number' ? String(call.args[key]).trim() : '';
	const key = s('key').replace(/^.*\/browse\//, '').toUpperCase();
	const mrName = (ref: string) => {
		if (!ref) {
			return verbs.currentMr;
		}
		const link = parseToolLink(ref);
		return link?.tool === 'gitlab' ? toolRefLabel(link) : /^\d+$/.test(ref) ? `!${ref}` : ref;
	};
	const text = s('text') || s('comment') || undefined;
	const titled = (value: string) => ({ tool: call.tool, title: value, ...text ? { text } : {} });
	switch (call.name) {
		case 'jira_get_issue': return titled(fill(verbs.read, key || 'Jira'));
		case 'jira_search': return titled(fill(verbs.search, s('jql')));
		case 'jira_comment': return titled(fill(verbs.comment, key));
		case 'jira_log_time': return titled(fill(verbs.logTime, s('spent')).replace('{1}', key));
		case 'jira_transition': return titled(fill(verbs.move, s('to') ? `${key} → ${s('to')}` : key));
		case 'gitlab_get_mr': return titled(fill(verbs.read, mrName(s('mr'))));
		case 'gitlab_get_issue': {
			const link = parseToolLink(s('issue'));
			return titled(fill(verbs.read, link ? toolRefLabel(link) : `#${s('issue').replace(/^#/, '')}`));
		}
		case 'gitlab_list_mrs': return titled(s('which') === 'mine' ? verbs.listMine : verbs.listReview);
		case 'gitlab_job_log': return titled(fill(verbs.jobLog, s('job') ? `job ${s('job').replace(/^.*\/jobs\//, '')}` : mrName(s('mr'))));
		case 'gitlab_create_mr': return { tool: call.tool, title: fill(verbs.openMr, s('target')), ...s('title') ? { text: s('title') } : {} };
		case 'gitlab_reply': return titled(fill(verbs.reply, mrName(s('mr'))));
		case 'sonar_quality_gate': return titled(verbs.qualityGate);
		case 'sonar_issues': return titled(verbs.sonarIssues);
		case 'snyk_test': return titled(verbs.snykTest);
		case 'snyk_code_test': return titled(verbs.snykCode);
		case 'figma_design': return titled(verbs.design);
		case 'figma_screenshot': return titled(verbs.screenshot);
		default: return undefined;
	}
}
