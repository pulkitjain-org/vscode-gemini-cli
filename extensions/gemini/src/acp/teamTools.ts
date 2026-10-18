/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The tools of the `geminicode-tools` MCP server: a handful per connected
// tool, so their schemas cost little in every prompt. Reading tools run
// without a question. The ones that change something are answered by the
// user on the permission card, and the confirm class among them (a status
// change, a time log, a new merge request, a merge) asks every time, with
// no "Allow for this session". Answers are trimmed text, never raw JSON, and
// text that came from a ticket, a merge request, a job log or a design is
// marked as such, so the model reads it as data.

import type { AuditLog } from './auditLog';
import type { McpContent, McpTool, McpToolResult } from './browserMcp';
import { FigmaDesktop, parseFigmaLink } from './figma';
import { describeMr, GitLabClient, parseMrRef, projectPathFromRemote } from './gitlab';
import { JiraClient } from './jira';
import { describeSnyk, SnykCli } from './snyk';
import { describeSonar, SonarClient, sonarProjectKeyIn, SonarTarget } from './sonar';
import type { TeamDefaults } from './teamDefaults';
import { clip, TeamToolError, TeamToolId } from './teamHttp';
import { git } from './worktrees';

/** The clients for the tools the user has connected; a tool not connected is absent. */
export interface TeamConnectors {
	readonly jira?: JiraClient;
	readonly gitlab?: GitLabClient;
	readonly sonar?: SonarClient;
	readonly snyk?: SnykCli;
	readonly figma?: FigmaDesktop;
}

export interface TeamToolContext {
	/** Where every write is recorded, before and after it happens. */
	readonly audit?: AuditLog;
	/** The connected tools now, for `tools/list`. */
	connected(): ReadonlySet<TeamToolId>;
	connectors(): TeamConnectors;
	/** The agent's working folder. */
	folder(agent: string): string | undefined;
	defaults(folder: string): Promise<TeamDefaults>;
}

/** The server's name in a session's MCP servers and in `mcp.allowed`. */
export const teamToolsServerName = 'geminicode-tools';

const text = { type: 'string' } as const;
const mrParam = { ...text, description: 'A merge request link, or its number such as 318 or !318. Leave out for the merge request of your current branch.' };
const targetParams = {
	branch: { ...text, description: 'The branch to look at. Leave out for your current branch.' },
	mr: { ...text, description: 'A merge request number, to look at its analysis instead of a branch\'s.' },
};

interface TeamTool extends McpTool {
	readonly tool: TeamToolId;
	/** Changes something, so the user answers a permission card. */
	readonly write?: boolean;
	/** Hard to take back, so the card asks every time and offers no session approval. */
	readonly confirm?: boolean;
}

export const teamTools: readonly TeamTool[] = [
	{
		tool: 'jira', name: 'jira_get_issue',
		description: 'Reads a Jira ticket: summary, status, description with acceptance criteria, fix versions, the last comments and links in it (Figma frames, merge requests).',
		inputSchema: { type: 'object', properties: { key: { ...text, description: 'The ticket key, such as ACME-412, or its link.' } }, required: ['key'] },
	},
	{
		tool: 'jira', name: 'jira_search',
		description: 'Finds Jira tickets with JQL, such as `assignee = currentUser() AND sprint in openSprints()`.',
		inputSchema: { type: 'object', properties: { jql: text, max: { type: 'number', description: 'At most this many (default 20).' } }, required: ['jql'] },
	},
	{
		tool: 'jira', name: 'jira_comment', write: true,
		description: 'Adds a comment to a Jira ticket. The user sees the exact text and approves it first.',
		inputSchema: { type: 'object', properties: { key: text, text: { ...text, description: 'Plain text; blank lines start paragraphs.' } }, required: ['key', 'text'] },
	},
	{
		tool: 'jira', name: 'jira_transition', write: true, confirm: true,
		description: 'Moves a Jira ticket to another status its workflow allows, optionally with a comment and the fields that move asks for (such as Fix version). Call it without `to` to list the allowed moves; the user approves the move itself.',
		inputSchema: {
			type: 'object',
			properties: {
				key: text,
				to: { ...text, description: 'The status to move to, such as In Review. Leave out to list the allowed moves.' },
				comment: { ...text, description: 'A comment added with the move.' },
				fields: { type: 'object', description: 'Field name or id to the value\'s name, for fields the move asks for.', additionalProperties: { type: 'string' } },
			},
			required: ['key'],
		},
	},
	{
		tool: 'jira', name: 'jira_log_time', write: true, confirm: true,
		description: 'Logs time the user spent on a Jira ticket. Only when the user asks; they approve it first.',
		inputSchema: {
			type: 'object',
			properties: { key: text, spent: { ...text, description: 'Time spent, such as 1h 30m or 45m.' }, comment: { ...text, description: 'What the time was spent on.' } },
			required: ['key', 'spent'],
		},
	},
	{
		tool: 'jira', name: 'jira_assign', write: true,
		description: 'Assigns a Jira ticket to someone the project allows (by name or email), to the user ("me"), or to nobody ("unassigned"). The user approves it first. Call it without `to` to list who can take the ticket.',
		inputSchema: {
			type: 'object',
			properties: { key: text, to: { ...text, description: 'A name or email to search for, "me", or "unassigned". Leave out to list the people who can take the ticket.' } },
			required: ['key'],
		},
	},
	{
		tool: 'gitlab', name: 'gitlab_get_mr',
		description: 'Reads a GitLab merge request: state, pipeline with failed jobs, approvals, open review threads (with their discussion ids) and the diff.',
		inputSchema: { type: 'object', properties: { mr: mrParam, diff: { type: 'boolean', description: 'Include the diff (default true).' } } },
	},
	{
		tool: 'gitlab', name: 'gitlab_list_mrs',
		description: 'Lists open merge requests: where the user is a reviewer, or the user\'s own.',
		inputSchema: { type: 'object', properties: { which: { type: 'string', enum: ['review', 'mine'] } }, required: ['which'] },
	},
	{
		tool: 'gitlab', name: 'gitlab_job_log',
		description: 'The end of a GitLab CI job\'s log, where failures are. Leave out `job` for every failed job of your current branch\'s merge request pipeline.',
		inputSchema: { type: 'object', properties: { job: { ...text, description: 'A job id or link.' }, mr: mrParam } },
	},
	{
		tool: 'gitlab', name: 'gitlab_get_issue',
		description: 'Reads a GitLab issue.',
		inputSchema: { type: 'object', properties: { issue: { ...text, description: 'An issue link, or its number in this repository\'s project.' } }, required: ['issue'] },
	},
	{
		tool: 'gitlab', name: 'gitlab_create_mr', write: true, confirm: true,
		description: 'Opens a GitLab merge request from your current branch, which must be pushed first. Ask the user for the target branch if they haven\'t named it. The user approves it first.',
		inputSchema: {
			type: 'object',
			properties: {
				target: { ...text, description: 'The branch to merge into, such as develop or release/2026.11.' },
				title: text,
				description: { ...text, description: 'Markdown: what changed and why, how it was tested, and the Jira ticket.' },
				draft: { type: 'boolean' },
			},
			required: ['target', 'title', 'description'],
		},
	},
	{
		tool: 'gitlab', name: 'gitlab_reply', write: true,
		description: 'Comments on a GitLab merge request: replies to a review thread (`discussion`), comments on a line (`path` and `line`), or adds a general comment. The user approves the exact text first.',
		inputSchema: {
			type: 'object',
			properties: { mr: mrParam, text, discussion: { ...text, description: 'The thread\'s discussion id, from gitlab_get_mr.' }, path: text, line: { type: 'number' }, resolve: { type: 'boolean', description: 'Resolve the thread after replying.' } },
			required: ['text'],
		},
	},
	{
		tool: 'gitlab', name: 'gitlab_merge', write: true, confirm: true,
		description: 'Merges a GitLab merge request, only when GitLab says it is ready: pipeline passed, every approval rule met, threads resolved, no conflicts. Reads the checks first and refuses otherwise, saying what is missing. The user approves the merge itself.',
		inputSchema: {
			type: 'object',
			properties: { mr: mrParam, squash: { type: 'boolean', description: 'Squash the commits; the project\'s setting by default.' }, deleteBranch: { type: 'boolean', description: 'Delete the source branch after merging (default true).' } },
		},
	},
	{
		tool: 'sonar', name: 'sonar_quality_gate',
		description: 'The SonarQube quality gate and new-code issues of your branch (or a merge request), from its last analysis in CI.',
		inputSchema: { type: 'object', properties: targetParams },
	},
	{
		tool: 'sonar', name: 'sonar_issues',
		description: 'Open SonarQube issues and security hotspots on new code of your branch (or a merge request), worst first, with file and line.',
		inputSchema: { type: 'object', properties: targetParams },
	},
	{
		tool: 'snyk', name: 'snyk_test',
		description: 'Runs the user\'s Snyk CLI on the dependencies in your folder. Returns vulnerable packages with severity and the upgrade that fixes each.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		tool: 'snyk', name: 'snyk_code_test',
		description: 'Runs Snyk Code on the source in your folder. Returns security issues with file, line and severity.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		tool: 'figma', name: 'figma_design',
		description: 'The design of a Figma frame from its link: code hints, layout, text and the design variables (colours, spacing, type). Use it before building UI from a design.',
		inputSchema: { type: 'object', properties: { link: { ...text, description: 'A Figma link with a node-id.' }, framework: { ...text, description: 'The UI framework to hint for, such as React or Vue.' } }, required: ['link'] },
	},
	{
		tool: 'figma', name: 'figma_screenshot',
		description: 'A screenshot of a Figma frame from its link, to compare with what you built.',
		inputSchema: { type: 'object', properties: { link: text }, required: ['link'] },
	},
];

/** The tools that only read, which run without asking. */
export const teamReadTools: readonly McpTool[] = teamTools.filter(tool => !tool.write);
export const teamWriteTools: readonly McpTool[] = teamTools.filter(tool => tool.write);
/** The confirm class: a card every time, with Allow once and Reject only. */
export const teamConfirmTools: readonly McpTool[] = teamTools.filter(tool => tool.confirm);

/**
 * The same actions in the MCP servers a team may run beside GeminiCode's
 * (mcp-atlassian and gitlab-mcp, as in a repository's `.gemini/settings.json`),
 * so they ask the same way.
 */
export const confirmToolNames: readonly string[] = [
	...teamConfirmTools.map(tool => tool.name),
	'jira_transition_issue', 'jira_add_worklog', 'create_merge_request', 'merge_merge_request',
];

/** Whether a permission request is for a confirm-class tool, by the title the CLI gives MCP calls (`name(args)`). */
export function isConfirmToolCall(request: { readonly toolCall: { readonly title?: string | null } }): boolean {
	const title = request.toolCall.title ?? '';
	return confirmToolNames.some(name => title === name || title.startsWith(`${name}(`));
}

/**
 * Text that came from outside (a ticket, a merge request, a job log, a
 * design), marked so the model treats it as something to read, not as
 * instructions. The frame is plain text; the server's instructions say what
 * it means.
 */
export function external(source: TeamToolId, ref: string, text: string): string {
	return `<external source="${source}" ref="${ref.replace(/"/g, '')}">\n${text}\n</external>`;
}

/** The tools for the connected tools. */
export function teamToolsFor(connected: ReadonlySet<TeamToolId>): McpTool[] {
	return teamTools.filter(tool => connected.has(tool.tool)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** A tool's answer, with the id the remote gave back for a write, which the audit log keeps and the model never sees. */
type TeamToolResult = McpToolResult & { readonly remote?: string };

function ok(content: string | McpContent[], remote?: string): TeamToolResult {
	return { content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, ...remote ? { remote } : {} };
}

function fail(message: string): McpToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

function arg(args: Record<string, unknown>, name: string): string | undefined {
	const value = args[name];
	return typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : undefined;
}

/** The repository's GitLab project (`group/repo`) and current branch, from its git remotes. */
export async function gitlabProjectOf(folder: string, gitlabUrl: string, defaults?: TeamDefaults): Promise<{ project?: string; branch?: string; remote?: string }> {
	const [remotes, branch] = await Promise.all([
		git(folder, ['remote', '-v']).catch(() => ''),
		git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']).then(b => b.trim(), () => undefined),
	]);
	let project: string | undefined;
	let remote: string | undefined;
	for (const line of remotes.split('\n')) {
		const [name, url] = line.split(/\s+/);
		const found = url ? projectPathFromRemote(url, gitlabUrl) : undefined;
		if (found && (!project || name === 'origin')) {
			project = found;
			remote = name;
		}
	}
	return { project: project ?? defaults?.gitlab?.project, branch: branch && branch !== 'HEAD' ? branch : undefined, remote };
}

/** Runs tool `name` for `agent`. Never throws: failures come back as an error result the model can read. */
export async function callTeamTool(context: TeamToolContext, agent: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
	const tool = teamTools.find(t => t.name === name);
	if (!tool) {
		return fail(`No tool named ${name}.`);
	}
	const run = () => runTeamTool(context, agent, tool, args);
	if (!tool.write || !context.audit || isListing(name, args)) {
		const { remote: _remote, ...result } = await run();
		return result;
	}
	// A write: the audit log gets the intent first, then the result or the failure.
	const intent = { caller: 'agent' as const, agent, tool: name, ...refOf(args) ? { ref: refOf(args) } : {}, effect: effectOf(name, args), args };
	const { remote: _remote, ...result } = await context.audit.record(intent, async () => {
		const answer = await run();
		if (answer.isError) {
			throw new Error(answer.content.map(c => c.type === 'text' ? c.text : '').join(' ').trim() || 'failed');
		}
		return answer;
	}, answer => answer.remote).catch(err => fail(err instanceof Error ? err.message : String(err)) as TeamToolResult);
	return result;
}

/** A write tool called only to list choices (moves, people), which changes nothing. */
function isListing(name: string, args: Record<string, unknown>): boolean {
	return (name === 'jira_transition' || name === 'jira_assign') && !arg(args, 'to');
}

function refOf(args: Record<string, unknown>): string | undefined {
	return arg(args, 'key')?.replace(/^.*\/browse\//, '').replace(/[?#].*$/, '').toUpperCase() ?? arg(args, 'mr');
}

/** One line a person reads in the audit log, from the tool and its arguments. */
export function effectOf(name: string, args: Record<string, unknown>): string {
	const key = refOf(args);
	switch (name) {
		case 'jira_comment': return `Comment on ${key}`;
		case 'jira_transition': return `${key} → ${arg(args, 'to')}${arg(args, 'comment') ? ', with a comment' : ''}`;
		case 'jira_log_time': return `${arg(args, 'spent')} on ${key}`;
		case 'jira_assign': return `${key} → ${arg(args, 'to')}`;
		case 'gitlab_create_mr': return `Merge request into ${arg(args, 'target') ?? 'the default branch'}: ${arg(args, 'title') ?? ''}`.trim();
		case 'gitlab_reply': return `${arg(args, 'discussion') ? `Reply on thread ${arg(args, 'discussion')}` : arg(args, 'path') ? `Comment on ${arg(args, 'path')}:${arg(args, 'line') ?? ''}` : 'Comment'}${key ? ` on ${key}` : ''}${args.resolve === true ? ', resolving it' : ''}`;
		case 'gitlab_merge': return `Merge ${key ?? 'the current branch\'s merge request'}`;
		default: return name;
	}
}

async function runTeamTool(context: TeamToolContext, agent: string, tool: TeamTool, args: Record<string, unknown>): Promise<TeamToolResult> {
	const name = tool.name;
	const connectors = context.connectors();
	const folder = context.folder(agent);
	try {
		switch (tool.tool) {
			case 'jira':
				return connectors.jira ? await jiraCall(connectors.jira, name, args, folder ? await context.defaults(folder) : {}) : notConnected('Jira');
			case 'gitlab':
				return connectors.gitlab ? await gitlabCall(connectors.gitlab, name, args, folder, folder ? await context.defaults(folder) : {}) : notConnected('GitLab');
			case 'sonar':
				return connectors.sonar ? await sonarCall(connectors.sonar, name, args, folder, folder ? await context.defaults(folder) : {}) : notConnected('SonarQube');
			case 'snyk':
				if (!connectors.snyk) {
					return notConnected('Snyk');
				}
				if (!folder) {
					return fail('No folder to test.');
				}
				return ok(describeSnyk(name === 'snyk_code_test' ? await connectors.snyk.testCode(folder) : await connectors.snyk.testDependencies(folder)));
			case 'figma':
				return connectors.figma ? await figmaCall(connectors.figma, name, args) : notConnected('Figma');
		}
	} catch (err) {
		return fail(err instanceof TeamToolError || err instanceof Error ? err.message : String(err));
	}
}

function notConnected(tool: string): McpToolResult {
	return fail(`${tool} isn't connected. The user can connect it in GeminiCode's Connections page.`);
}

async function jiraCall(jira: JiraClient, name: string, args: Record<string, unknown>, defaults: TeamDefaults): Promise<McpToolResult> {
	const key = arg(args, 'key')?.replace(/^.*\/browse\//, '').replace(/[?#].*$/, '').toUpperCase();
	switch (name) {
		case 'jira_get_issue': {
			const issue = await jira.issue(key ?? '');
			return ok(external('jira', issue.key, [
				`${issue.key} ${issue.summary} (${issue.url})`,
				`${issue.type ?? 'Ticket'} · ${issue.status}${issue.priority ? ` · ${issue.priority}` : ''}${issue.fixVersions.length ? ` · fix version ${issue.fixVersions.join(', ')}` : ''}${issue.assignee ? ` · assigned to ${issue.assignee}` : ''}${issue.parent ? ` · parent ${issue.parent}` : ''}`,
				...issue.labels.length ? [`Labels: ${issue.labels.join(', ')}`] : [],
				'',
				clip(issue.description.trim() || '(no description)', 12_000),
				...issue.comments.length ? ['', 'Latest comments:', ...issue.comments.map(c => `- ${c.author} (${c.created.slice(0, 10)}): ${clip(c.body.trim(), 1500)}`)] : [],
				...issue.links.length ? ['', 'Links:', ...issue.links.map(l => `- ${l}`)] : [],
			].join('\n')));
		}
		case 'jira_search': {
			const issues = await jira.search(arg(args, 'jql') ?? '', Number(args.max) || 20);
			return ok(issues.length ? external('jira', 'search', issues.map(i => `${i.key} [${i.status}] ${i.summary}`).join('\n')) : 'No tickets match.');
		}
		case 'jira_comment': {
			const made = await jira.comment(key ?? '', arg(args, 'text') ?? '', defaults.jira?.commentVisibility);
			return ok(`Commented on ${key}.`, made.id ? `comment ${made.id}` : undefined);
		}
		case 'jira_log_time': {
			const made = await jira.logWork(key ?? '', arg(args, 'spent') ?? '', arg(args, 'comment'));
			return ok(`Logged ${arg(args, 'spent')} on ${key}.`, made.id ? `worklog ${made.id}` : undefined);
		}
		case 'jira_assign': {
			const to = arg(args, 'to');
			if (!to) {
				const people = await jira.assignableUsers(key ?? '');
				return ok(people.length ? `${key} can be assigned to:\n${people.map(u => `- ${u.displayName}${u.emailAddress ? ` (${u.emailAddress})` : ''}`).join('\n')}` : `Nobody can be assigned ${key}.`);
			}
			if (/^unassigned$/i.test(to)) {
				await jira.assign(key ?? '', null);
				return ok(`${key} is now unassigned.`);
			}
			const person = /^me$/i.test(to) ? await jira.myself() : (await jira.assignableUsers(key ?? '', to))[0];
			if (!person) {
				return fail(`Nobody matching "${to}" can be assigned ${key}. Call jira_assign without \`to\` to list who can.`);
			}
			await jira.assign(key ?? '', person.accountId);
			return ok(`Assigned ${key} to ${person.displayName}.`, `assignee ${person.accountId}`);
		}
		case 'jira_transition': {
			const to = arg(args, 'to');
			if (!to) {
				const moves = await jira.transitions(key ?? '');
				return ok(moves.length ? `${key} can move to:\n${moves.map(t => `- ${t.to}${t.fields.filter(f => f.required).length ? ` (needs ${t.fields.filter(f => f.required).map(f => f.name).join(', ')})` : ''}`).join('\n')}` : `${key} can't move from its current status.`);
			}
			const fields = typeof args.fields === 'object' && args.fields ? Object.fromEntries(Object.entries(args.fields as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {};
			const moved = await jira.transition(key ?? '', to, arg(args, 'comment'), fields);
			return ok(`Moved ${key} to ${moved.to}${arg(args, 'comment') ? ' with the comment' : ''}.`, `transition ${moved.id} → ${moved.to}`);
		}
	}
	return fail(`No tool named ${name}.`);
}

async function resolveMr(gitlab: GitLabClient, ref: string | undefined, folder: string | undefined, defaults: TeamDefaults): Promise<{ project: string; iid: number }> {
	const local = folder ? await gitlabProjectOf(folder, gitlab.url, defaults) : {};
	if (ref) {
		const parsed = parseMrRef(ref);
		const project = parsed?.project ?? local.project;
		if (!parsed || !project) {
			throw new Error(`"${ref}" isn't a merge request link or number in this repository's GitLab project.`);
		}
		return { project, iid: parsed.iid };
	}
	if (!local.project || !local.branch) {
		throw new Error('This folder isn\'t a clone of a project on the connected GitLab, or isn\'t on a branch. Give the merge request\'s link.');
	}
	const mr = await gitlab.mrForBranch(local.project, local.branch);
	if (!mr) {
		throw new Error(`No open merge request from ${local.branch}.`);
	}
	return { project: local.project, iid: mr.iid };
}

async function gitlabCall(gitlab: GitLabClient, name: string, args: Record<string, unknown>, folder: string | undefined, defaults: TeamDefaults): Promise<McpToolResult> {
	switch (name) {
		case 'gitlab_get_mr': {
			const { project, iid } = await resolveMr(gitlab, arg(args, 'mr'), folder, defaults);
			const [mr, discussions, diffs] = await Promise.all([gitlab.mr(project, iid), gitlab.discussions(project, iid), args.diff === false ? [] : gitlab.diffs(project, iid)]);
			const failed = mr.pipeline?.status === 'failed' ? await gitlab.jobs(project, mr.pipeline.id, true).catch(() => []) : [];
			return ok(external('gitlab', `!${iid}`, describeMr(mr, discussions, diffs, failed)));
		}
		case 'gitlab_list_mrs': {
			const list = arg(args, 'which') === 'mine' ? await gitlab.myMergeRequests() : await gitlab.reviewRequests();
			return ok(list.length ? list.map(mr => `!${mr.iid} ${mr.title} · ${mr.project} · ${mr.sourceBranch} → ${mr.targetBranch} · by ${mr.author}${mr.draft ? ' · draft' : ''} (${mr.url})`).join('\n') : 'None.');
		}
		case 'gitlab_job_log': {
			const job = arg(args, 'job');
			if (job) {
				const link = /\/(.+?)\/-\/jobs\/(\d+)/.exec(job);
				const local = folder ? await gitlabProjectOf(folder, gitlab.url, defaults) : {};
				const project = link ? link[1].replace(/^https?:\/\/[^/]+\//, '') : local.project;
				if (!project) {
					return fail('Give the job\'s link.');
				}
				const jobId = Number(link?.[2] ?? job.replace(/\D/g, ''));
				return ok(external('gitlab', `job ${jobId}`, await gitlab.jobLogTail(project, jobId)));
			}
			const { project, iid } = await resolveMr(gitlab, arg(args, 'mr'), folder, defaults);
			const mr = await gitlab.mr(project, iid, false);
			if (!mr.pipeline) {
				return ok(`!${iid} has no pipeline.`);
			}
			const failed = await gitlab.jobs(project, mr.pipeline.id, true);
			if (!failed.length) {
				return ok(`The pipeline of !${iid} is ${mr.pipeline.status}; no job failed.`);
			}
			const logs = await Promise.all(failed.slice(0, 3).map(async j => `=== ${j.stage} / ${j.name} (job ${j.id}, ${j.url})\n${await gitlab.jobLogTail(project, j.id, 8000).catch(e => String(e))}`));
			return ok(external('gitlab', `!${iid} jobs`, logs.join('\n\n')));
		}
		case 'gitlab_get_issue': {
			const ref = arg(args, 'issue') ?? '';
			const link = /\/(.+?)\/-\/(?:issues|work_items)\/(\d+)/.exec(ref);
			const local = folder ? await gitlabProjectOf(folder, gitlab.url, defaults) : {};
			const project = link ? link[1].replace(/^https?:\/\/[^/]+\//, '') : local.project;
			if (!project) {
				return fail('Give the issue\'s link.');
			}
			const issue = await gitlab.issue(project, Number(link?.[2] ?? ref.replace(/\D/g, '')));
			return ok(external('gitlab', issue.url, `${issue.title} (${issue.url}) · ${issue.state}${issue.labels.length ? ` · ${issue.labels.join(', ')}` : ''}\n\n${clip(issue.description, 12_000)}`));
		}
		case 'gitlab_create_mr': {
			const local = folder ? await gitlabProjectOf(folder, gitlab.url, defaults) : {};
			if (!local.project || !local.branch) {
				return fail('This folder isn\'t on a branch of a project on the connected GitLab.');
			}
			const mr = await gitlab.createMergeRequest(local.project, {
				sourceBranch: local.branch,
				targetBranch: arg(args, 'target') ?? defaults.gitlab?.defaultTarget ?? 'main',
				title: arg(args, 'title') ?? local.branch,
				description: typeof args.description === 'string' ? args.description : '',
				draft: args.draft === true,
			});
			return ok(`Opened !${mr.iid}: ${mr.url}`, `!${mr.iid}`);
		}
		case 'gitlab_reply': {
			const { project, iid } = await resolveMr(gitlab, arg(args, 'mr'), folder, defaults);
			const body = typeof args.text === 'string' ? args.text : '';
			const discussion = arg(args, 'discussion');
			if (discussion) {
				const note = await gitlab.replyToDiscussion(project, iid, discussion, body);
				if (args.resolve === true) {
					await gitlab.resolveDiscussion(project, iid, discussion);
				}
				return ok(`Replied on !${iid}${args.resolve === true ? ' and resolved the thread' : ''}.`, note.id ? `note ${note.id} on !${iid}` : `!${iid}`);
			}
			const path = arg(args, 'path');
			const line = Number(args.line);
			if (path && line > 0) {
				const where = await gitlab.commentOnLine(project, iid, path, line, body);
				return ok(where === 'line' ? `Commented on ${path}:${line} in !${iid}.` : `Commented on !${iid} (the line isn't in the diff, so as a general comment).`);
			}
			const note = await gitlab.comment(project, iid, body);
			return ok(`Commented on !${iid}.`, note.id ? `note ${note.id} on !${iid}` : `!${iid}`);
		}
		case 'gitlab_merge': {
			const { project, iid } = await resolveMr(gitlab, arg(args, 'mr'), folder, defaults);
			const readiness = await gitlab.mergeReadiness(project, iid);
			if (!readiness.ready) {
				return fail(`!${iid} isn't ready to merge:\n${readiness.checks.filter(c => !c.ok).map(c => `- ${c.name}: ${c.detail}`).join('\n')}`);
			}
			const merged = await gitlab.merge(project, iid, { sha: readiness.sha, ...args.squash === undefined ? {} : { squash: args.squash === true }, removeSourceBranch: args.deleteBranch !== false });
			return ok(`Merged !${iid} at ${readiness.sha.slice(0, 8)}${merged.sha ? ` as ${merged.sha.slice(0, 8)}` : ''}.`, `!${iid} merged at ${readiness.sha}${merged.sha ? ` as ${merged.sha}` : ''}`);
		}
	}
	return fail(`No tool named ${name}.`);
}

async function sonarCall(sonar: SonarClient, name: string, args: Record<string, unknown>, folder: string | undefined, defaults: TeamDefaults): Promise<McpToolResult> {
	const project = defaults.sonar?.projectKey ?? (folder ? await sonarProjectKeyIn(folder) : undefined);
	if (!project) {
		return fail('No SonarQube project key for this repository. Add `sonar.projectKey` to sonar-project.properties, or "sonar": { "projectKey": … } to .gemini/geminicode-tools.json.');
	}
	const mr = arg(args, 'mr')?.replace(/^!/, '');
	let branch = arg(args, 'branch');
	if (!branch && !mr && folder) {
		branch = (await git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || undefined;
	}
	const target: SonarTarget = { project, ...mr ? { mergeRequest: mr } : branch ? { branch } : {} };
	if (name === 'sonar_quality_gate') {
		const [gate, issues] = await Promise.all([sonar.gate(target), sonar.issues(target, 20).catch(() => [])]);
		return ok(describeSonar(target, gate, issues));
	}
	const [issues, hotspots] = await Promise.all([sonar.issues(target), sonar.hotspots(target).catch(() => [])]);
	return ok(describeSonar(target, undefined, [...issues, ...hotspots]));
}

async function figmaCall(figma: FigmaDesktop, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
	const link = arg(args, 'link') ?? '';
	if (!parseFigmaLink(link)) {
		return fail('That isn\'t a Figma link. Copy the frame\'s link in Figma (it has node-id=…).');
	}
	const content = name === 'figma_screenshot' ? await figma.screenshot(link) : await figma.designContext(link, arg(args, 'framework'));
	return ok(content.map(c => c.type === 'text' ? { type: 'text' as const, text: external('figma', link, clip(c.text, 40_000)) } : c));
}
