/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
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
	/** The screen sizes the team's Figma designs have a frame for (`figma.viewports` there), for Add Figma Design. */
	readonly figmaSizes?: readonly string[];
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

/** Where the user's Jira and GitLab are, to find an item's page from its id. */
export interface ToolSites {
	readonly jira?: string;
	readonly gitlab?: string;
}

/** The page of the item a `toolRefId` names; undefined when its tool's site isn't known or the id isn't one. */
export function toolRefUrl(id: string, sites: ToolSites): string | undefined {
	const [tool, ...parts] = id.split(':');
	const base = (site: string | undefined) => site?.replace(/\/+$/, '');
	switch (tool) {
		case 'jira': {
			const key = parts.join(':');
			return base(sites.jira) && /^[A-Z][A-Z0-9_]{1,15}-\d+$/.test(key) ? `${base(sites.jira)}/browse/${key}` : undefined;
		}
		case 'gitlab': {
			const [kind, ...rest] = parts;
			const iid = rest.pop() ?? '';
			const project = rest.join(':');
			return base(sites.gitlab) && project && /^\d+$/.test(iid) && (kind === 'mr' || kind === 'issue')
				? `${base(sites.gitlab)}/${project}/-/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
				: undefined;
		}
		case 'figma': {
			// A node id has a colon of its own (12:34); the link spells it with a dash.
			const [fileKey, ...node] = parts;
			const nodeId = node.join(':');
			return /^[\w-]+$/.test(fileKey ?? '') ? `https://www.figma.com/design/${fileKey}${nodeId ? `?node-id=${encodeURIComponent(nodeId.replace(/:/g, '-'))}` : ''}` : undefined;
		}
	}
	return undefined;
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
export function parseTeamToolCall(title: string): { readonly tool: 'jira' | 'confluence' | 'gitlab' | 'sonar' | 'snyk' | 'figma'; readonly name: string; readonly args: Record<string, unknown> } | undefined {
	const call = parseToolCall(title, /^(jira|confluence|gitlab|sonar|snyk|figma)_[a-z_]+/);
	return call && { tool: call.prefix as 'jira', name: call.name, args: call.args };
}

/** A tool call's name (matching `pattern`, whose first group is `prefix`) and arguments, from a title such as `name ({"a":1})`. */
function parseToolCall(title: string, pattern: RegExp): { readonly prefix: string; readonly name: string; readonly args: Record<string, unknown> } | undefined {
	const match = pattern.exec(title.trim());
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
	return { prefix: match[1], name: match[0], args };
}

/** Verbs for the index tools' friendly titles; `{0}` is what was looked up. */
export interface IndexToolVerbs {
	readonly searchCode: string;
	readonly findSymbol: string;
	readonly related: string;
	readonly outline: string;
	readonly outlineFolder: string;
	readonly searchDocs: string;
	readonly typeOf: string;
	readonly checkErrors: string;
	readonly checkErrorsIn: string;
	readonly callersOf: string;
	readonly callsIn: string;
}

export const englishIndexToolVerbs: IndexToolVerbs = {
	searchCode: 'Search code for {0}',
	findSymbol: 'Look up {0}',
	related: 'Find files related to {0}',
	outline: 'Outline {0}',
	outlineFolder: 'Outline the folder',
	searchDocs: 'Search docs for {0}',
	typeOf: 'Type of {0}',
	checkErrors: 'Check changed files for errors',
	checkErrorsIn: 'Check {0} for errors',
	callersOf: 'Callers of {0}',
	callsIn: 'Calls in {0}',
};

/** "Search code for "discount code"": a friendly title for a geminicode-index call, or undefined for other tools. */
export function indexToolTitle(title: string, verbs: IndexToolVerbs = englishIndexToolVerbs): string | undefined {
	const call = parseToolCall(title, /^(code_search|find_symbol|related_files|repo_map|docs_search|code_type|code_diagnostics|code_calls)\b/);
	if (!call) {
		return undefined;
	}
	const s = (key: string) => typeof call.args[key] === 'string' ? (call.args[key] as string).trim() : '';
	const quoted = (value: string) => value ? `"${value.length > 60 ? `${value.slice(0, 60)}…` : value}"` : '';
	switch (call.prefix) {
		case 'code_search': return fill(verbs.searchCode, quoted(s('query')));
		case 'find_symbol': return fill(verbs.findSymbol, s('name'));
		case 'related_files': return fill(verbs.related, s('path'));
		case 'repo_map': return s('path') ? fill(verbs.outline, s('path')) : verbs.outlineFolder;
		case 'docs_search': return fill(verbs.searchDocs, quoted(s('query')));
		case 'code_type': return fill(verbs.typeOf, s('symbol'));
		case 'code_diagnostics': {
			const paths = Array.isArray(call.args.paths) ? call.args.paths.filter((p): p is string => typeof p === 'string') : [];
			return paths.length ? fill(verbs.checkErrorsIn, paths.length === 1 ? paths[0] : `${paths.length} files`) : verbs.checkErrors;
		}
		case 'code_calls': return fill(s('direction') === 'outgoing' ? verbs.callsIn : verbs.callersOf, s('symbol'));
		default: return undefined;
	}
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
	/** "Merge {0}" */
	readonly merge: string;
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
	readonly designAt: string;
	readonly screenshotAt: string;
	readonly searchPages: string;
	readonly readPage: string;
	readonly draftPage: string;
	/** "this branch's merge request" */
	readonly currentMr: string;
	/** Labels in a confirm-class card's effect: what the tool will record, line by line. */
	readonly effectComment: string;
	readonly effectWork: string;
	readonly effectTitle: string;
	readonly effectDescription: string;
	readonly effectDraft: string;
	readonly effectSquash: string;
	readonly effectDeleteBranch: string;
	readonly effectProjectDefault: string;
}

export const englishTeamToolVerbs: TeamToolVerbs = {
	read: 'Read {0}',
	search: 'Search Jira for {0}',
	comment: 'Comment on {0}',
	move: 'Move {0}',
	logTime: 'Log {0} on {1}',
	openMr: 'Open merge request into {0}',
	merge: 'Merge {0}',
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
	designAt: 'Read the Figma design ({0})',
	screenshotAt: 'Take a screenshot of the Figma frame ({0})',
	searchPages: 'Search Confluence for "{0}"',
	readPage: 'Read the Confluence page',
	draftPage: 'Draft the Confluence page "{0}"',
	currentMr: 'this branch\'s merge request',
	effectComment: 'Comment',
	effectWork: 'Work description',
	effectTitle: 'Title',
	effectDescription: 'Description',
	effectDraft: 'Draft',
	effectSquash: 'Squash',
	effectDeleteBranch: 'Delete source branch',
	effectProjectDefault: 'project default',
};

function fill(template: string, value: string): string {
	return template.replace('{0}', value);
}

/**
 * "Read ACME-412", "Comment on !318": a friendly title for a geminicode-tools
 * call, or undefined for other tools. `text` is what a comment or reply would
 * post; `effect` is a confirm-class action as the tool will record it, line
 * by line (the move, its fields and comment; the time; the merge request).
 */
export function teamToolTitle(title: string, verbs: TeamToolVerbs = englishTeamToolVerbs): { readonly tool: 'jira' | 'confluence' | 'gitlab' | 'sonar' | 'snyk' | 'figma'; readonly title: string; readonly text?: string; readonly effect?: string } | undefined {
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
	const indented = (value: string) => value.split('\n').map(line => `  ${line}`).join('\n');
	const effect = (value: string, lines: readonly string[]) => ({ tool: call.tool, title: value, effect: lines.filter(Boolean).join('\n') });
	switch (call.name) {
		case 'jira_get_issue': return titled(fill(verbs.read, key || 'Jira'));
		case 'jira_search': return titled(fill(verbs.search, s('jql')));
		case 'jira_comment': return titled(fill(verbs.comment, key));
		case 'jira_log_time': return effect(fill(verbs.logTime, s('spent')).replace('{1}', key), [
			`${s('spent')}  ${key}`,
			text ? `${verbs.effectWork}: ${text}` : '',
		]);
		case 'jira_transition': {
			const fields = call.args.fields && typeof call.args.fields === 'object' ? Object.entries(call.args.fields as Record<string, unknown>) : [];
			return effect(fill(verbs.move, s('to') ? `${key} → ${s('to')}` : key), [
				`${key}  → ${s('to')}`,
				...fields.map(([name, value]) => `${name}: ${String(value)}`),
				text ? `${verbs.effectComment}:\n${indented(text)}` : '',
			]);
		}
		case 'gitlab_get_mr': return titled(fill(verbs.read, mrName(s('mr'))));
		case 'gitlab_get_issue': {
			const link = parseToolLink(s('issue'));
			return titled(fill(verbs.read, link ? toolRefLabel(link) : `#${s('issue').replace(/^#/, '')}`));
		}
		case 'gitlab_list_mrs': return titled(s('which') === 'mine' ? verbs.listMine : verbs.listReview);
		case 'gitlab_job_log': return titled(fill(verbs.jobLog, s('job') ? `job ${s('job').replace(/^.*\/jobs\//, '')}` : mrName(s('mr'))));
		case 'gitlab_create_mr': return effect(fill(verbs.openMr, s('target')), [
			`→ ${s('target')}${call.args.draft === true ? `  (${verbs.effectDraft})` : ''}`,
			s('title') ? `${verbs.effectTitle}: ${s('title')}` : '',
			s('description') ? `${verbs.effectDescription}:\n${indented(s('description'))}` : '',
		]);
		case 'gitlab_merge': return effect(fill(verbs.merge, mrName(s('mr'))), [
			mrName(s('mr')),
			`${verbs.effectSquash}: ${call.args.squash === undefined ? verbs.effectProjectDefault : String(call.args.squash)}  ${verbs.effectDeleteBranch}: ${call.args.deleteBranch === undefined ? 'true' : String(call.args.deleteBranch)}`,
		]);
		case 'gitlab_reply': return titled(fill(verbs.reply, mrName(s('mr'))));
		case 'sonar_quality_gate': return titled(verbs.qualityGate);
		case 'sonar_issues': return titled(verbs.sonarIssues);
		case 'snyk_test': return titled(verbs.snykTest);
		case 'snyk_code_test': return titled(verbs.snykCode);
		case 'figma_design': return titled(s('viewport') ? fill(verbs.designAt, s('viewport')) : verbs.design);
		case 'figma_screenshot': return titled(s('viewport') ? fill(verbs.screenshotAt, s('viewport')) : verbs.screenshot);
		case 'confluence_search': return titled(fill(verbs.searchPages, s('query')));
		case 'confluence_get_page': return titled(verbs.readPage);
		case 'confluence_draft_page': return { tool: call.tool, title: fill(verbs.draftPage, s('title')) };
		default: return undefined;
	}
}
