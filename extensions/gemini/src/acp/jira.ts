/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Jira Cloud over its REST API (v3), with the user's email and API token.
// Descriptions and comments come as Atlassian Document Format; they are
// turned into plain text for the model and the panels, and plain text the
// user wrote is turned back into it.

import { Fetch, normalizeBaseUrl, teamRequest } from './teamHttp';

export interface JiraAuth {
	readonly site: string;
	readonly email: string;
	readonly token: string;
}

export interface JiraUser {
	readonly accountId: string;
	readonly displayName: string;
	readonly emailAddress?: string;
}

export type JiraStatusCategory = 'new' | 'indeterminate' | 'done';

/** Who may see a comment: members of a project role, or of a group. */
export interface JiraCommentVisibility {
	readonly type: 'role' | 'group';
	readonly value: string;
}

/** A file on a ticket. */
export interface JiraAttachment {
	readonly id: string;
	readonly name: string;
	/** Where Jira serves its content, to a signed-in browser. */
	readonly url?: string;
	readonly size?: number;
}

/** The tickets Home and the ticket pickers read: the user's open ones, wherever they are, and their open sprints' done ones, for the sprint's progress. */
export const myTicketsJql = 'assignee = currentUser() AND (statusCategory != Done OR sprint in openSprints())';

export interface JiraIssueSummary {
	readonly key: string;
	readonly summary: string;
	readonly status: string;
	readonly statusCategory: JiraStatusCategory;
	readonly type?: string;
	readonly priority?: string;
	readonly fixVersions: readonly string[];
	readonly updated?: string;
	readonly url: string;
}

export interface JiraComment {
	readonly author: string;
	readonly created: string;
	readonly body: string;
}

export interface JiraIssue extends JiraIssueSummary {
	readonly description: string;
	readonly assignee?: string;
	readonly reporter?: string;
	readonly labels: readonly string[];
	readonly parent?: string;
	readonly comments: readonly JiraComment[];
	/** Links in the description and comments, such as Figma frames and merge requests. */
	readonly links: readonly string[];
}

export interface JiraTransitionField {
	readonly id: string;
	readonly name: string;
	readonly required: boolean;
	/** The values the field allows, when it is a choice (Fix version, Resolution). */
	readonly allowed?: readonly { readonly id: string; readonly name: string }[];
	/** Whether it takes a list (Fix versions). */
	readonly multiple: boolean;
}

export interface JiraTransition {
	readonly id: string;
	readonly name: string;
	readonly to: string;
	readonly toCategory: JiraStatusCategory;
	readonly fields: readonly JiraTransitionField[];
}

export interface JiraSprint {
	readonly id: number;
	readonly name: string;
	readonly endDate?: string;
}

/** A ticket assigned to the user, and whether it is in the sprint running now. */
export interface JiraMyTicket extends JiraIssueSummary {
	readonly inSprint: boolean;
}

/** The tickets assigned to the user, and the sprint running now when Jira says. */
export interface JiraMyTickets {
	readonly sprint?: JiraSprint;
	readonly issues: readonly JiraMyTicket[];
}

const listFields = ['summary', 'status', 'issuetype', 'priority', 'fixVersions', 'updated'];
/** How many of the user's tickets are read: more than any card or list shows. */
const myTicketsMax = 100;

export class JiraClient {

	readonly site: string;
	private sprintField: Promise<string | undefined> | undefined;

	constructor(private readonly auth: JiraAuth, private readonly fetcher: Fetch = fetch) {
		this.site = normalizeBaseUrl(auth.site);
	}

	private request<T>(path: string, init: Parameters<typeof teamRequest>[2] = {}): Promise<T> {
		const basic = Buffer.from(`${this.auth.email}:${this.auth.token}`).toString('base64');
		return teamRequest<T>('jira', `${this.site}${path}`, { ...init, headers: { Authorization: `Basic ${basic}`, ...init.headers } }, this.fetcher);
	}

	myself(): Promise<JiraUser> {
		return this.request<JiraUser>('/rest/api/3/myself');
	}

	issueUrl(key: string): string {
		return `${this.site}/browse/${encodeURIComponent(key)}`;
	}

	async search(jql: string, max = 20): Promise<JiraIssueSummary[]> {
		const result = await this.request<{ issues?: RawIssue[] }>('/rest/api/3/search/jql', {
			method: 'POST',
			body: { jql, fields: listFields, maxResults: Math.min(Math.max(1, max), 100) },
		});
		return (result?.issues ?? []).map(issue => this.summaryOf(issue));
	}

	/**
	 * The tickets assigned to the user (myTicketsJql), newest first, each marked
	 * with whether it is in a sprint running now, and that sprint's name and end.
	 */
	async myTickets(): Promise<JiraMyTickets> {
		const sprintField = await this.findSprintField();
		const result = await this.request<{ issues?: RawIssue[] }>('/rest/api/3/search/jql', {
			method: 'POST',
			body: { jql: `${myTicketsJql} ORDER BY updated DESC`, fields: [...listFields, ...sprintField ? [sprintField] : []], maxResults: myTicketsMax },
		});
		let sprint: JiraSprint | undefined;
		const issues = (result?.issues ?? []).map((issue): JiraMyTicket => {
			const sprints = sprintField ? issue.fields?.[sprintField] : undefined;
			const active = Array.isArray(sprints) ? (sprints as { id?: number; name?: string; state?: string; endDate?: string }[]).find(s => s.state === 'active') : undefined;
			const running: JiraSprint | undefined = active?.id !== undefined && active.name ? { id: active.id, name: active.name, endDate: active.endDate } : undefined;
			sprint ??= running;
			return { ...this.summaryOf(issue), inSprint: !!running };
		});
		return { sprint, issues };
	}

	async issue(key: string): Promise<JiraIssue> {
		const raw = await this.request<RawIssue>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${[...listFields, 'description', 'assignee', 'reporter', 'labels', 'parent', 'comment'].join(',')}`);
		const fields = raw.fields ?? {};
		const description = adfToText(fields.description);
		const comments = ((fields.comment as { comments?: RawComment[] } | undefined)?.comments ?? []).slice(-5).map(comment => ({
			author: comment.author?.displayName ?? '',
			created: comment.created ?? '',
			body: adfToText(comment.body),
		}));
		return {
			...this.summaryOf(raw),
			description,
			assignee: (fields.assignee as RawUser | undefined)?.displayName,
			reporter: (fields.reporter as RawUser | undefined)?.displayName,
			labels: Array.isArray(fields.labels) ? fields.labels as string[] : [],
			parent: (fields.parent as { key?: string } | undefined)?.key,
			comments,
			links: linksIn([description, ...comments.map(c => c.body)].join('\n')),
		};
	}

	/** The moves the ticket's workflow allows from its current status, with the fields each asks for. */
	async transitions(key: string): Promise<JiraTransition[]> {
		const result = await this.request<{ transitions?: RawTransition[] }>(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`);
		return (result?.transitions ?? []).map(t => ({
			id: t.id,
			name: t.name,
			to: t.to?.name ?? t.name,
			toCategory: categoryOf(t.to?.statusCategory?.key),
			fields: Object.entries(t.fields ?? {}).filter(([id]) => id !== 'comment').map(([id, field]) => ({
				id,
				name: field.name ?? id,
				required: !!field.required,
				multiple: field.schema?.type === 'array',
				...(field.allowedValues ? { allowed: field.allowedValues.map(v => ({ id: String(v.id), name: v.name ?? v.value ?? String(v.id) })) } : {}),
			})),
		}));
	}

	/**
	 * Moves the ticket by `transition` (an id or the target status's name),
	 * setting `fields` (field id to an allowed value's id, or ids) and adding
	 * `comment` in the same request.
	 */
	async transition(key: string, transition: string, comment?: string, fields: Record<string, string | readonly string[]> = {}): Promise<JiraTransition> {
		const available = await this.transitions(key);
		const wanted = transition.trim().toLowerCase();
		const match = available.find(t => t.id === transition) ?? available.find(t => t.to.toLowerCase() === wanted || t.name.toLowerCase() === wanted);
		if (!match) {
			throw new Error(`${key} can't move to "${transition}" from its current status. It can move to: ${available.map(t => t.to).join(', ') || 'nothing'}.`);
		}
		const values: Record<string, unknown> = {};
		for (const field of match.fields) {
			const given = fields[field.id] ?? fields[field.name];
			if (given === undefined) {
				if (field.required) {
					throw new Error(`Moving ${key} to ${match.to} needs ${field.name}${field.allowed ? ` (one of: ${field.allowed.map(a => a.name).join(', ')})` : ''}.`);
				}
				continue;
			}
			const ids = (Array.isArray(given) ? given : [given]).map(value => field.allowed?.find(a => a.id === value || a.name.toLowerCase() === String(value).toLowerCase())?.id ?? value);
			values[field.id] = field.multiple ? ids.map(id => ({ id })) : field.allowed ? { id: ids[0] } : ids[0];
		}
		await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
			method: 'POST',
			body: {
				transition: { id: match.id },
				...Object.keys(values).length ? { fields: values } : {},
				...comment?.trim() ? { update: { comment: [{ add: { body: textToAdf(comment) } }] } } : {},
			},
		});
		return match;
	}

	/** Adds a comment; `visibility` limits who can see it to a project role, such as Developers. */
	comment(key: string, text: string, visibility?: string): Promise<{ readonly id?: string }> {
		return this.commentDocument(key, textToAdf(text), visibility ? { type: 'role', value: visibility } : undefined);
	}

	/** Adds a comment already in Jira's rich text (ADF); `visibility` limits who can see it to a project role or a group. */
	async commentDocument(key: string, body: unknown, visibility?: JiraCommentVisibility): Promise<{ readonly id?: string }> {
		const made = await this.request<{ id?: string }>(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
			method: 'POST',
			body: { body, ...visibility ? { visibility } : {} },
		});
		return { ...made?.id ? { id: String(made.id) } : {} };
	}

	/** Uploads `files` to ticket `key`, as Jira's Attach does; Jira's own size limit applies. */
	async attach(key: string, files: readonly { readonly name: string; readonly data: Uint8Array<ArrayBuffer>; readonly mimeType?: string }[]): Promise<JiraAttachment[]> {
		const form = new FormData();
		for (const file of files) {
			form.append('file', new Blob([file.data], file.mimeType ? { type: file.mimeType } : {}), file.name);
		}
		const made = await this.request<{ id?: unknown; filename?: unknown; content?: unknown; size?: unknown }[]>(`/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, {
			method: 'POST',
			// Jira refuses uploads without it, as a guard against forged forms.
			headers: { 'X-Atlassian-Token': 'no-check' },
			body: form,
			timeoutMs: 120_000,
		});
		return (made ?? []).flatMap(a => a.id !== undefined && typeof a.filename === 'string' ? [{
			id: String(a.id), name: a.filename, ...typeof a.content === 'string' ? { url: a.content } : {}, ...typeof a.size === 'number' ? { size: a.size } : {},
		}] : []);
	}

	/** People who can see `key`, matching `query`, for @ in a comment: people only, not apps. */
	async mentionableUsers(key: string, query: string): Promise<JiraUser[]> {
		const users = await this.request<(JiraUser & { accountType?: string; active?: boolean })[]>(`/rest/api/3/user/viewissue/search?issueKey=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}&maxResults=10`);
		return (users ?? []).filter(u => u.accountType !== 'app' && u.active !== false).map(u => ({ accountId: u.accountId, displayName: u.displayName, ...u.emailAddress ? { emailAddress: u.emailAddress } : {} }));
	}

	/** Who a comment on `key` can be limited to, as Jira's comment box offers: the project's roles and the user's groups. */
	async commentVisibilities(key: string): Promise<{ readonly roles: string[]; readonly groups: string[] }> {
		const project = key.replace(/-\d+$/, '');
		const [roles, me] = await Promise.all([
			this.request<Record<string, string>>(`/rest/api/3/project/${encodeURIComponent(project)}/role`).catch(() => ({})),
			this.request<{ groups?: { items?: { name?: string }[] } }>('/rest/api/3/myself?expand=groups').catch(() => undefined),
		]);
		return {
			roles: Object.keys(roles ?? {}).filter(name => name !== 'atlassian-addons-project-access').sort(),
			groups: (me?.groups?.items ?? []).flatMap(g => g.name ? [g.name] : []).sort(),
		};
	}

	/**
	 * Logs time on a ticket: `spent` in Jira's format ("1h 30m", "2d"),
	 * `started` an ISO time (now by default), with an optional comment.
	 */
	async logWork(key: string, spent: string, comment?: string, started: Date = new Date()): Promise<{ readonly id?: string }> {
		const seconds = parseDuration(spent);
		if (!seconds) {
			throw new Error(`"${spent}" isn't a time Jira understands. Use hours and minutes, such as 1h 30m.`);
		}
		const made = await this.request<{ id?: string }>(`/rest/api/3/issue/${encodeURIComponent(key)}/worklog?adjustEstimate=auto`, {
			method: 'POST',
			body: { timeSpentSeconds: seconds, started: jiraTime(started), ...comment?.trim() ? { comment: textToAdf(comment) } : {} },
		});
		return { ...made?.id ? { id: String(made.id) } : {} };
	}

	/** The time logged on a ticket in total, and by the user, in seconds. */
	async worklogTotals(key: string, accountId?: string): Promise<{ total: number; mine: number }> {
		const result = await this.request<{ worklogs?: { timeSpentSeconds?: number; author?: { accountId?: string } }[] }>(`/rest/api/3/issue/${encodeURIComponent(key)}/worklog?maxResults=1000`);
		const logs = result?.worklogs ?? [];
		return {
			total: logs.reduce((sum, w) => sum + (w.timeSpentSeconds ?? 0), 0),
			mine: logs.filter(w => accountId && w.author?.accountId === accountId).reduce((sum, w) => sum + (w.timeSpentSeconds ?? 0), 0),
		};
	}

	/** The people the project lets take `key`, matching `query` when given. */
	async assignableUsers(key: string, query = ''): Promise<JiraUser[]> {
		const users = await this.request<JiraUser[]>(`/rest/api/3/user/assignable/search?issueKey=${encodeURIComponent(key)}&maxResults=50${query ? `&query=${encodeURIComponent(query)}` : ''}`);
		return (users ?? []).map(u => ({ accountId: u.accountId, displayName: u.displayName, ...u.emailAddress ? { emailAddress: u.emailAddress } : {} }));
	}

	/** Assigns `key` to `accountId`, or to nobody with null. */
	async assign(key: string, accountId: string | null): Promise<void> {
		await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, { method: 'PUT', body: { accountId } });
	}

	private findSprintField(): Promise<string | undefined> {
		this.sprintField ??= this.request<{ id: string; schema?: { custom?: string } }[]>('/rest/api/3/field').then(
			fields => fields.find(f => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id,
			() => undefined,
		);
		return this.sprintField;
	}

	private summaryOf(issue: RawIssue): JiraIssueSummary {
		const fields = issue.fields ?? {};
		const status = fields.status as { name?: string; statusCategory?: { key?: string } } | undefined;
		return {
			key: issue.key,
			summary: String(fields.summary ?? ''),
			status: status?.name ?? '',
			statusCategory: categoryOf(status?.statusCategory?.key),
			type: (fields.issuetype as { name?: string } | undefined)?.name,
			priority: (fields.priority as { name?: string } | undefined)?.name,
			fixVersions: Array.isArray(fields.fixVersions) ? (fields.fixVersions as { name?: string }[]).flatMap(v => v.name ? [v.name] : []) : [],
			updated: typeof fields.updated === 'string' ? fields.updated : undefined,
			url: this.issueUrl(issue.key),
		};
	}
}

interface RawIssue {
	readonly key: string;
	readonly fields?: Record<string, unknown>;
}

interface RawUser {
	readonly displayName?: string;
}

interface RawComment {
	readonly author?: RawUser;
	readonly created?: string;
	readonly body?: unknown;
}

interface RawTransition {
	readonly id: string;
	readonly name: string;
	readonly to?: { readonly name?: string; readonly statusCategory?: { readonly key?: string } };
	readonly fields?: Record<string, { readonly name?: string; readonly required?: boolean; readonly schema?: { readonly type?: string }; readonly allowedValues?: { readonly id: string | number; readonly name?: string; readonly value?: string }[] }>;
}

function categoryOf(key: string | undefined): JiraStatusCategory {
	return key === 'done' ? 'done' : key === 'indeterminate' ? 'indeterminate' : 'new';
}

/** A Jira key such as ACME-412. */
export const jiraKeyPattern = /\b([A-Z][A-Z0-9_]{1,15}-\d{1,7})\b/;

/**
 * The Jira key in a branch name, title or link, such as `ACME-412-gift-message`.
 * Lower case (`acme-412-...`) counts only for a project in `projects`, so a
 * branch such as `release-2026` isn't taken for a ticket.
 */
export function jiraKeyIn(text: string, projects: readonly string[] = []): string | undefined {
	const exact = jiraKeyPattern.exec(text)?.[1];
	if (exact) {
		return exact;
	}
	const known = new Set(projects.map(p => p.toUpperCase()));
	for (const match of text.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,15})[-_](\d{1,7})(?![0-9])/g)) {
		if (known.has(match[1].toUpperCase())) {
			return `${match[1].toUpperCase()}-${match[2]}`;
		}
	}
	return undefined;
}

/** Plain text from Atlassian Document Format. */
export function adfToText(node: unknown): string {
	if (typeof node === 'string') {
		return node;
	}
	if (!node || typeof node !== 'object') {
		return '';
	}
	const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown>; marks?: { type?: string; attrs?: { href?: string } }[] };
	const inner = () => (n.content ?? []).map(adfToText).join('');
	switch (n.type) {
		case 'text': {
			const link = n.marks?.find(m => m.type === 'link')?.attrs?.href;
			const code = n.marks?.some(m => m.type === 'code');
			const text = code ? `\`${n.text ?? ''}\`` : n.text ?? '';
			return link && link !== n.text ? `${text} (${link})` : text;
		}
		case 'hardBreak':
			return '\n';
		case 'paragraph':
			return `${inner()}\n\n`;
		case 'heading':
			return `${'#'.repeat(Number(n.attrs?.level ?? 2))} ${inner()}\n\n`;
		case 'bulletList':
			return `${(n.content ?? []).map(item => `- ${adfToText(item).trim().replace(/\n+/g, '\n  ')}`).join('\n')}\n\n`;
		case 'orderedList':
			return `${(n.content ?? []).map((item, i) => `${i + 1}. ${adfToText(item).trim().replace(/\n+/g, '\n   ')}`).join('\n')}\n\n`;
		case 'codeBlock':
			return `\`\`\`\n${inner()}\n\`\`\`\n\n`;
		case 'mention':
			return `@${String(n.attrs?.text ?? '').replace(/^@/, '')}`;
		case 'inlineCard':
		case 'blockCard':
		case 'embedCard':
			return String(n.attrs?.url ?? '');
		case 'emoji':
			return String(n.attrs?.text ?? n.attrs?.shortName ?? '');
		case 'mediaSingle':
		case 'mediaGroup':
			return '[attachment]\n\n';
		case 'table':
			return `${(n.content ?? []).map(row => ((row as { content?: unknown[] }).content ?? []).map(cell => adfToText(cell).trim().replace(/\n+/g, ' ')).join(' | ')).join('\n')}\n\n`;
		default:
			return inner();
	}
}

/** Atlassian Document Format from plain text: a paragraph per blank-line block, line breaks kept. */
export function textToAdf(text: string): unknown {
	const paragraphs = text.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
	return {
		type: 'doc',
		version: 1,
		content: paragraphs.map(paragraph => ({
			type: 'paragraph',
			content: paragraph.split('\n').flatMap((line, i) => [...i ? [{ type: 'hardBreak' }] : [], ...line ? [{ type: 'text', text: line }] : []]),
		})),
	};
}

/** The http(s) links in `text`, once each. */
export function linksIn(text: string): string[] {
	return [...new Set(text.match(/https?:\/\/[^\s)<>"'\]]+/g) ?? [])];
}

/** Seconds in a Jira duration such as "1h 30m", "2d", "45m" or "1.5h"; 0 when it isn't one. Jira's day is 8h and week 5d. */
export function parseDuration(text: string): number {
	const units: Record<string, number> = { w: 5 * 8 * 3600, d: 8 * 3600, h: 3600, m: 60 };
	const trimmed = text.trim().toLowerCase();
	if (!/^(\d+(\.\d+)?\s*[wdhm]\s*)+$/.test(trimmed)) {
		return 0;
	}
	let seconds = 0;
	for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)\s*([wdhm])/g)) {
		seconds += Number(match[1]) * units[match[2]];
	}
	return Math.round(seconds);
}

/** "1h 30m" from seconds, as Jira writes it. */
export function formatDuration(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.round((seconds % 3600) / 60);
	return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '0m';
}

/** Jira's time format: 2026-10-17T14:05:00.000+0000. */
function jiraTime(date: Date): string {
	return date.toISOString().replace('Z', '+0000');
}
