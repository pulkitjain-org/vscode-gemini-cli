/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
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

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AuditCaller, AuditLog } from './auditLog';
import type { McpContent, McpTool, McpToolResult } from './browserMcp';
import { annotateTokens, type TokenIndex } from './designSystem';
import { errorMessage } from './errors';
import { type FigmaClient, type FigmaContent, isNodeNotFound, parseFigmaLink } from './figma';
import { describeMr, GitLabClient, parseMrRef, projectPathFromRemote } from './gitlab';
import type { JiraClient, JiraCommentVisibility } from './jira';
import type { JiraApi, JiraSites } from './jiraSites';
import { appendAttachments, isAdfDocument } from './jiraAdf';
import { describeSnyk, SnykCli } from './snyk';
import { describeSonar, SonarClient, sonarProjectKeyIn, SonarTarget } from './sonar';
import type { TeamDefaults } from './teamDefaults';
import { ChildServer, McpServerUnavailableError } from './mcpStdio';
import { gitlabVia, jiraVia, snykVia, sonarVia, TeamChildren } from './teamContainers';
import { external } from './externalText';
import { clip, hostOf, TeamToolError, TeamToolId } from './teamHttp';

export { external };
import { git } from './worktrees';

/** The clients for the tools the user has connected; a tool not connected is absent. */
export interface TeamConnectors {
	readonly jira?: JiraSites;
	/** The Confluence sites turned on; their client is in Confluence's own bundle (`TeamToolContext.confluence`). */
	readonly confluence?: readonly ConfluenceAccount[];
	readonly gitlab?: GitLabClient;
	readonly sonar?: SonarClient;
	readonly snyk?: SnykCli;
	readonly figma?: FigmaClient;
}

/** A Confluence site turned on: the account of the Jira site it shares, as Atlassian Cloud has one per site. */
export interface ConfluenceAccount {
	/** The Jira site's id. */
	readonly id: string;
	readonly name: string;
	readonly site: string;
	readonly email: string;
	readonly token: string;
}

/** Confluence's tool calls, in a bundle of their own loaded on first use (src/confluence.ts). */
export interface ConfluenceTools {
	call(name: string, args: Record<string, unknown>, agent?: string): Promise<TeamToolResult>;
	/** Opens a draft's Review Page, or with no id asks which draft. */
	openDraft(id?: string): Promise<void>;
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
	/** The team's own Jira and GitLab servers, when the user took them over and they run as children. */
	children?(): TeamChildren;
	/** Told when a child server could not start and the call went through the in-process connector instead. */
	childUnavailable?(server: string, reason: string): void;
	/** Whether shell commands are allowed (`gemini.tools.allowShell`); tools that run the project's build code are refused when not. */
	allowShell?(): boolean;
	/** Whether `agent` may only read, such as a merge request's reviewer: it is offered no write tool, and any it asks for is refused. */
	readOnly?(agent: string): boolean;
	/**
	 * Whether `agent` needs the team tools: a task on a ticket or merge
	 * request, a flow, or the user's choice. Until then its session lists
	 * none, since their definitions were half of every model call on a team
	 * repository (FINDINGS.md); unset offers them to every agent.
	 */
	enabledFor?(agent: string | undefined): boolean;
	/** Confluence's calls, its bundle loaded now if it was not yet; undefined when Confluence isn't connected. */
	confluence?(): ConfluenceTools | undefined;
	/** Whether Figma looks up Code Connect mappings in design reads when the repository's defaults file does not say (`designSystem`); off, Figma answers faster and never asks about them. */
	figmaCodeConnect?(): boolean;
	/** The design system of the repository around `folder`, for Figma reads: Code Connect over the setting, and the tokens that name colours. */
	designSystem?(folder: string): Promise<{ readonly codeConnect?: boolean; readonly tokens: TokenIndex } | undefined>;
}

/** The server's name in a session's MCP servers and in `mcp.allowed`. */
export const teamToolsServerName = 'geminicode-tools';

const text = { type: 'string' } as const;
const mrParam = { ...text, description: 'A merge request link, or its number such as 318 or !318. Leave out for the merge request of your current branch.' };
const viewportParam = { ...text, description: 'The screen size this frame is for, such as XS or Mobile, when the design has a frame for each size.' };
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
	/** Runs the project's own code (Snyk resolves dependencies with the project's build tools), so the user answers a card, and it is off when shell commands are. */
	readonly runsCode?: boolean;
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
			properties: { mr: { ...text, description: 'The merge request to merge: its link, or its number such as 318 or !318.' }, squash: { type: 'boolean', description: 'Squash the commits; the project\'s setting by default.' }, deleteBranch: { type: 'boolean', description: 'Delete the source branch after merging (default true).' } },
			required: ['mr'],
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
		tool: 'snyk', name: 'snyk_test', runsCode: true,
		description: 'Runs the user\'s Snyk CLI on the dependencies in your folder. Returns vulnerable packages with severity and the upgrade that fixes each. It runs the project\'s build tools, so the user approves it.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		tool: 'snyk', name: 'snyk_code_test', runsCode: true,
		description: 'Runs Snyk Code on the source in your folder, which uploads it to Snyk. Returns security issues with file, line and severity. The user approves it.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		tool: 'figma', name: 'figma_design',
		description: 'The design of a Figma frame from its link: code hints, layout, text and the design variables (colours, spacing, type). Use it before building UI from a design. It has no screenshot: call figma_screenshot when you need to see the frame. A large frame comes in sections, with the node ids of any not read yet.',
		inputSchema: { type: 'object', properties: { link: { ...text, description: 'A Figma link with a node-id.' }, framework: { ...text, description: 'The UI framework to hint for, such as React or Vue.' }, viewport: viewportParam }, required: ['link'] },
	},
	{
		tool: 'confluence', name: 'confluence_search',
		description: 'Finds Confluence pages by words in them, or by a CQL query, newest first, with each page\'s link. Use it for the specs, decisions and runbooks a ticket refers to.',
		inputSchema: { type: 'object', properties: { query: { ...text, description: 'Words to find, or a CQL query.' }, space: { ...text, description: 'A space key, such as CHK, to search only that space.' } }, required: ['query'] },
	},
	{
		tool: 'confluence', name: 'confluence_get_page',
		description: 'A Confluence page from its link: its title, space, version and text. Read the pages a ticket links before you start.',
		inputSchema: { type: 'object', properties: { link: { ...text, description: 'The page\'s link, or its id.' } }, required: ['link'] },
	},
	{
		tool: 'confluence', name: 'confluence_draft_page',
		description: 'Drafts a Confluence page for the user to review: a new page in a space (`space`, and `parent` to put it under a page), or a new version of a page (`page`). Write the whole page in Markdown; for a new version, keep everything you don\'t mean to change. Tables, macros, mentions and images you read as text stay on the page as they are: leave them out rather than rewrite them. Nothing is published: the user edits it and publishes it from GeminiCode\'s Review Page.',
		inputSchema: {
			type: 'object', properties: {
				title: text, markdown: { ...text, description: 'The whole page, in Markdown.' },
				page: { ...text, description: 'The link of the page this is a new version of.' },
				space: { ...text, description: 'For a new page: the space key, such as CHK.' },
				parent: { ...text, description: 'For a new page: the link of the page to put it under.' },
			},
			required: ['title', 'markdown'],
		},
	},
	{
		tool: 'figma', name: 'figma_screenshot',
		description: 'A screenshot of a Figma frame from its link, to compare with what you built.',
		inputSchema: { type: 'object', properties: { link: text, viewport: viewportParam }, required: ['link'] },
	},
];

/** The tools that only read, which run without asking; not the ones that run the project's code. */
export const teamReadTools: readonly McpTool[] = teamTools.filter(tool => !tool.write && !tool.runsCode);
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

/**
 * The confirm class by server, for the tool policy: GeminiCode's own tools, and the same actions in
 * the servers a team names `jira` and `gitlab`, as their settings file does.
 */
export function confirmToolGroups(): { server: string; tools: string[] }[] {
	return [
		{ server: teamToolsServerName, tools: teamConfirmTools.map(tool => tool.name) },
		{ server: 'jira', tools: ['jira_transition_issue', 'jira_add_worklog'] },
		{ server: 'gitlab', tools: ['create_merge_request', 'merge_merge_request'] },
	];
}

/** Whether a permission request is for a confirm-class tool, by the title the CLI gives MCP calls (`name(args)`). */
export function isConfirmToolCall(request: { readonly toolCall: { readonly title?: string | null } }): boolean {
	return isCallOf(request, confirmToolNames);
}

/** Every write among GeminiCode's own team tools, with the confirm class's names from a team's own servers. */
const writeToolNames: readonly string[] = [...new Set([...teamTools.filter(tool => tool.write).map(tool => tool.name), ...confirmToolNames])];

/**
 * Whether a permission request is for a team tool that writes: a comment, a
 * reply, an assignment, or the confirm class. These ask in every mode, YOLO
 * included, since a write to a team's tools is never undone by Undo.
 */
export function isTeamWriteToolCall(request: { readonly toolCall: { readonly title?: string | null } }): boolean {
	return isCallOf(request, writeToolNames);
}

function isCallOf(request: { readonly toolCall: { readonly title?: string | null } }, names: readonly string[]): boolean {
	const title = request.toolCall.title ?? '';
	return names.some(name => title === name || title.startsWith(`${name}(`));
}

/** The tools for the connected tools; with `readOnly`, only those that read. */
export function teamToolsFor(connected: ReadonlySet<TeamToolId>, readOnly = false): McpTool[] {
	return teamTools.filter(tool => connected.has(tool.tool) && !(readOnly && tool.write)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** What a read-only agent gets when it asks for a write. */
export const readOnlyRefusal = 'Your team tools only read here: you are reviewing, and the user posts what you found from the Review page. Put it in your reply instead.';

/**
 * A tool's answer, with the id the remote gave back for a write, which the
 * audit log keeps and the model never sees, and what a page needs next (a
 * new merge request's link). `warning` marks a write that went through with a
 * later step failed ("replied, but couldn't resolve the thread"), and `unsure`
 * a failed write that may have gone through all the same (no answer in time).
 */
export type TeamToolResult = McpToolResult & { readonly remote?: string; readonly data?: TeamWriteData; readonly warning?: string; readonly unsure?: boolean };

/** What a page needs after a write: a merge request's number and link, a merge commit. */
export type TeamWriteData = Readonly<Record<string, string | number>>;

function ok(content: string | McpContent[], remote?: string, data?: TeamWriteData): TeamToolResult {
	return { content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, ...remote ? { remote } : {}, ...data ? { data } : {} };
}

/** A write that went through, with a later step of it that failed: success, with the failure as a warning. */
function partly(done: string, warning: string, remote?: string): TeamToolResult {
	return { ...ok(`${done} ${warning}`, remote), warning };
}

/** Who asks for a team tool: an agent, whose folder the context knows, or one of GeminiCode's pages, working in `folder`. */
export interface TeamCaller {
	readonly caller: AuditCaller;
	readonly agent?: string;
	readonly folder?: string;
}

/** A page's answer from a write: the text an agent would read, the id the tool gave back, and what the page shows next. */
export interface TeamWriteResult {
	readonly ok: boolean;
	readonly text: string;
	readonly remote?: string;
	readonly data?: TeamWriteData;
	/** It went through, but a later step failed: what to show beside the success. */
	readonly warning?: string;
	/** It failed without an answer and may have gone through: its audit record stays open until the user checks. */
	readonly unsure?: boolean;
}

/**
 * Writes only GeminiCode's own pages make, on the same path as the agent's
 * tools so they get the same checks and the same audit record; agents are
 * never offered them.
 */
const pageTools: readonly TeamTool[] = [
	{ tool: 'jira', name: 'jira_rich_comment', write: true, description: 'Comments on a ticket from Home\'s comment box: Markdown as Jira rich text, with mentions, attached files and who may see it.', inputSchema: { type: 'object', properties: {} } },
	{ tool: 'confluence', name: 'confluence_publish', write: true, description: 'Publishes a draft from the Review Page: a new page, or a new version of one.', inputSchema: { type: 'object', properties: {} } },
	{ tool: 'gitlab', name: 'gitlab_approve', write: true, description: 'Approves a merge request.', inputSchema: { type: 'object', properties: {} } },
	{ tool: 'gitlab', name: 'gitlab_request_changes', write: true, description: 'Requests changes on a merge request with a summary note.', inputSchema: { type: 'object', properties: {} } },
	{ tool: 'gitlab', name: 'gitlab_resolve', write: true, description: 'Resolves a review thread without replying.', inputSchema: { type: 'object', properties: {} } },
	{ tool: 'gitlab', name: 'gitlab_upload', write: true, description: 'Uploads a file to a project for a merge request\'s description (Open Merge Request\'s attachments).', inputSchema: { type: 'object', properties: {} } },
];

/** Files a page may attach, at most: well past Jira Cloud's own default limit, so Jira's message is the one people see. */
const maxAttachmentBytes = 256 * 1024 * 1024;
/** Files Open Merge Request may upload to GitLab, at most: GitLab's own default limit for an attachment. */
export const maxUploadBytes = 100 * 1024 * 1024;

/**
 * Home's comment box: `document`, the comment as Jira rich text the box made
 * from its `markdown` (kept for the audit log), with the `files` (paths)
 * uploaded to the ticket first and listed under it, and `visibility` a role
 * or group, "everyone", or unset for the team's default.
 */
async function richComment(jira: JiraApi, key: string, args: Record<string, unknown>, defaults: TeamDefaults): Promise<TeamToolResult> {
	const document = isAdfDocument(args.document) ? args.document : undefined;
	const files = stringList(args.files);
	if (!key || (!document?.content.length && !files.length)) {
		return fail('Write a comment or attach a file.');
	}
	const loaded = await Promise.all(files.map(async file => {
		const size = (await fs.stat(file)).size;
		if (size > maxAttachmentBytes) {
			throw new Error(`${path.basename(file)} is too large to attach.`);
		}
		return { name: path.basename(file), data: await fs.readFile(file) };
	}));
	const attached = loaded.length ? await jira.attach(key, loaded) : [];
	const asked = args.visibility as { type?: unknown; value?: unknown } | string | undefined;
	const visibility: JiraCommentVisibility | undefined = asked === 'everyone' ? undefined
		: typeof asked === 'object' && (asked.type === 'role' || asked.type === 'group') && typeof asked.value === 'string' ? { type: asked.type, value: asked.value }
			: defaults.jira?.commentVisibility ? { type: 'role', value: defaults.jira.commentVisibility } : undefined;
	let made: { readonly id?: string };
	try {
		made = await jira.commentDocument(key, appendAttachments(document ?? { type: 'doc', version: 1, content: [] }, attached), visibility);
	} catch (err) {
		if (attached.length) {
			throw new Error(`${err instanceof Error ? err.message : String(err)} The files were attached to ${key} before the comment failed.`);
		}
		throw err;
	}
	const remote = [made.id ? `comment ${made.id}` : '', ...attached.map(a => `attachment ${a.id}`)].filter(Boolean).join(' · ');
	return ok(`Commented on ${key}${attached.length ? `, with ${attached.length === 1 ? '1 attached file' : `${attached.length} attached files`}` : ''}.`, remote || undefined);
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : [];
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
	if (tool.write && context.readOnly?.(agent)) {
		return fail(readOnlyRefusal);
	}
	const { remote: _remote, data: _data, warning: _warning, unsure: _unsure, ...result } = await runAudited(context, { caller: 'agent', agent }, tool, args);
	return result;
}

/**
 * A write from one of GeminiCode's pages (Home, the flows, the merge request
 * panel), through the same code as an agent's tool call: the same checks
 * before the call, the same request, and the same audit record but for the
 * caller. Never throws: `ok` says whether it went through.
 */
export async function teamWrite(context: TeamToolContext, who: TeamCaller, name: string, args: Record<string, unknown>): Promise<TeamWriteResult> {
	const tool = teamTools.find(t => t.name === name) ?? (who.caller === 'ui' ? pageTools.find(t => t.name === name) : undefined);
	if (!tool) {
		return { ok: false, text: `No tool named ${name}.` };
	}
	const result = await runAudited(context, who, tool, args);
	return {
		ok: !result.isError,
		text: result.content.map(c => c.type === 'text' ? c.text : '').join('\n').trim(),
		...result.remote ? { remote: result.remote } : {},
		...result.data ? { data: result.data } : {},
		...result.warning ? { warning: result.warning } : {},
		...result.unsure ? { unsure: true } : {},
	};
}

/** Runs a tool; a write gets the audit log's intent first, then the result or the failure. */
async function runAudited(context: TeamToolContext, who: TeamCaller, tool: TeamTool, args: Record<string, unknown>): Promise<TeamToolResult> {
	const folder = who.folder ?? (who.agent ? context.folder(who.agent) : undefined);
	if (!tool.write || !context.audit || isListing(tool.name, args)) {
		return runTeamTool(context, folder, tool, args, who.agent);
	}
	// With more than one Jira site, the ticket's site is found first, so the record names it.
	const sites = tool.tool === 'jira' ? context.connectors().jira : undefined;
	const key = arg(args, 'key');
	const routed = sites && sites.sites.length > 1 && key ? sites.clientFor(key, true) : undefined;
	// Confluence's publish names its draft's site: with more than one connected, the record says which.
	const site = routed ? await routed.then(client => hostOf(client.site), () => undefined)
		: tool.tool === 'confluence' && (context.connectors().confluence?.length ?? 0) > 1 ? arg(args, 'site') : undefined;
	const result = await auditedWrite(context.audit, who, tool, args, () => runTeamTool(context, folder, tool, args, who.agent, routed), site);
	return result;
}

/**
 * A write's intent, then its result or failure, in the audit log. A write
 * that got no answer in time gets neither: it may have gone through, so its
 * intent stays open, and Home lists it as unfinished until the user checks.
 */
async function auditedWrite(audit: AuditLog, who: TeamCaller, tool: TeamTool, args: Record<string, unknown>, run: () => Promise<TeamToolResult>, site?: string): Promise<TeamToolResult> {
	const ref = refOf(args);
	const intent = { caller: who.caller, ...who.agent ? { agent: who.agent } : {}, tool: tool.name, ...ref ? { ref } : {}, effect: `${effectOf(tool.name, args)}${site ? ` (${site})` : ''}`, args };
	try {
		const id = await audit.intent(intent);
		let answer: TeamToolResult;
		try {
			answer = await run();
		} catch (err) {
			answer = fail(err instanceof Error ? err.message : String(err));
		}
		if (!answer.isError) {
			await audit.result(id, intent, answer.remote);
		} else if (!answer.unsure) {
			await audit.failed(id, intent, answer.content.map(c => c.type === 'text' ? c.text : '').join(' ').trim() || 'failed');
		}
		return answer;
	} catch (err) {
		// The audit log couldn't be written: the write isn't made without its record.
		return fail(err instanceof Error ? err.message : String(err));
	}
}

/** A write tool called only to list choices (moves, people), which changes nothing. */
function isListing(name: string, args: Record<string, unknown>): boolean {
	return (name === 'jira_transition' || name === 'jira_assign') && !arg(args, 'to');
}

function refOf(args: Record<string, unknown>): string | undefined {
	const mr = arg(args, 'mr');
	return arg(args, 'key')?.replace(/^.*\/browse\//, '').replace(/[?#].*$/, '').toUpperCase() ?? (mr && /^\d+$/.test(mr) ? `!${mr}` : mr);
}

/** One line a person reads in the audit log, from the tool and its arguments. */
export function effectOf(name: string, args: Record<string, unknown>): string {
	const key = refOf(args);
	switch (name) {
		case 'jira_comment': return `Comment on ${key}`;
		case 'confluence_publish': return `Publish "${arg(args, 'title') ?? ''}" to Confluence${arg(args, 'page') ? ` as a new version of page ${arg(args, 'page')}` : ''}`;
		case 'jira_rich_comment': {
			const files = stringList(args.files).length;
			return `Comment on ${key}${files ? `, with ${files === 1 ? '1 attached file' : `${files} attached files`}` : ''}`;
		}
		case 'jira_transition': return `${key} → ${arg(args, 'to')}${arg(args, 'comment') ? ', with a comment' : ''}`;
		case 'jira_log_time': return `${arg(args, 'spent')} on ${key}`;
		case 'jira_assign': return `${key} → ${arg(args, 'to')}`;
		case 'gitlab_create_mr': return `Merge request into ${arg(args, 'target') ?? 'the default branch'}: ${arg(args, 'title') ?? ''}`.trim();
		case 'gitlab_reply': return `${arg(args, 'discussion') ? `Reply on thread ${arg(args, 'discussion')}` : arg(args, 'path') ? `Comment on ${arg(args, 'path')}:${arg(args, 'line') ?? ''}` : 'Comment'}${key ? ` on ${key}` : ''}${args.resolve === true ? ', resolving it' : ''}`;
		case 'gitlab_merge': return `Merge ${key ?? 'the current branch\'s merge request'}`;
		case 'gitlab_approve': return `Approve ${key}`;
		case 'gitlab_request_changes': return `Request changes on ${key}`;
		case 'gitlab_resolve': return `Resolve thread ${arg(args, 'discussion') ?? ''} on ${key}`;
		case 'gitlab_upload': return `Upload ${path.basename(arg(args, 'file') ?? '')} to ${arg(args, 'project') ?? 'the project'}`;
		default: return name;
	}
}

async function runTeamTool(context: TeamToolContext, folder: string | undefined, tool: TeamTool, args: Record<string, unknown>, agent?: string, routed?: Promise<JiraClient>): Promise<TeamToolResult> {
	const name = tool.name;
	const connectors = context.connectors();
	try {
		switch (tool.tool) {
			case 'jira': {
				const sites = connectors.jira;
				if (!sites) {
					return notConnected('Jira');
				}
				// A ticket goes to the site that has it; a search, with more than one site, to all of them.
				const ref = arg(args, 'key');
				const jira = ref ? await (routed ?? sites.clientFor(ref, tool.write && !isListing(name, args))) : name === 'jira_search' && sites.sites.length > 1 ? sites : sites.primary;
				// The team's mcp-atlassian server knows only the first site.
				return await jiraCall(jira, through(context, jira === sites.primary ? context.children?.().jira : undefined), name, args, folder ? await context.defaults(folder) : {});
			}
			case 'gitlab':
				return connectors.gitlab ? await gitlabCall(connectors.gitlab, through(context, context.children?.().gitlab), name, args, folder, folder ? await context.defaults(folder) : {}) : notConnected('GitLab');
			case 'sonar':
				return connectors.sonar ? await sonarCall(connectors.sonar, readThrough(context, folder && context.children?.().sonar?.for(folder)), name, args, folder, folder ? await context.defaults(folder) : {}) : notConnected('SonarQube');
			case 'snyk': {
				const snyk = connectors.snyk;
				if (!snyk) {
					return notConnected('Snyk');
				}
				if (!folder) {
					return fail('No folder to test.');
				}
				if (tool.runsCode && context.allowShell?.() === false) {
					return fail('Snyk is turned off because shell commands are turned off in GeminiCode (gemini.tools.allowShell): a Snyk test runs the project\'s build tools.');
				}
				const code = name === 'snyk_code_test';
				return await readThrough(context, context.children?.().snyk?.for(folder))(
					async server => ok(external('snyk', folder, clip(code ? await snykVia.code(server, folder) : await snykVia.dependencies(server, folder), 20_000))),
					async () => ok(describeSnyk(code ? await snyk.testCode(folder) : await snyk.testDependencies(folder))));
			}
			case 'figma': {
				if (!connectors.figma) {
					return notConnected('Figma');
				}
				// The repository's design system decides Code Connect over the setting, and its tokens name the colours Figma gives.
				const design = folder ? await context.designSystem?.(folder).catch(() => undefined) : undefined;
				return await figmaCall(connectors.figma, name, args, design?.codeConnect ?? !!context.figmaCodeConnect?.(), design?.tokens);
			}
			case 'confluence': {
				const confluence = connectors.confluence?.length ? context.confluence?.() : undefined;
				return confluence ? await confluence.call(name, args, agent) : notConnected('Confluence');
			}
		}
	} catch (err) {
		return { ...fail(err instanceof TeamToolError || err instanceof Error ? err.message : String(err)), ...err instanceof TeamToolError && err.detail.unsure ? { unsure: true } : {} };
	}
}

/**
 * Makes a call through the team's own server when it runs as a child, else, or when it could not
 * start, through the in-process connector. A call the server already received never runs twice.
 */
type Through = <T>(viaChild: (server: ChildServer) => Promise<T>, inProcess: () => Promise<T>) => Promise<T>;

function through(context: TeamToolContext, server: ChildServer | undefined): Through {
	return async (viaChild, inProcess) => {
		if (server) {
			try {
				return await viaChild(server);
			} catch (err) {
				if (!(err instanceof McpServerUnavailableError)) {
					throw err;
				}
				context.childUnavailable?.(server.name, err.message);
			}
		}
		return inProcess();
	};
}

/** Like `through`, for calls that only read: any failure of the child, not only a start, falls back, since a read can run twice. */
function readThrough(context: TeamToolContext, server: ChildServer | undefined | '' | false): Through {
	return async (viaChild, inProcess) => {
		if (server) {
			try {
				return await viaChild(server);
			} catch (err) {
				context.childUnavailable?.(server.name, err instanceof Error ? err.message : String(err));
			}
		}
		return inProcess();
	};
}

function idText(id: string | number | undefined): string | undefined {
	return id === undefined ? undefined : String(id);
}

function notConnected(tool: string): McpToolResult {
	return fail(`${tool} isn't connected. The user can connect it in GeminiCode's Connections page.`);
}

async function jiraCall(jira: JiraApi, via: Through, name: string, args: Record<string, unknown>, defaults: TeamDefaults): Promise<TeamToolResult> {
	const key = arg(args, 'key')?.replace(/^.*\/browse\//, '').replace(/[?#].*$/, '').toUpperCase();
	switch (name) {
		case 'jira_get_issue': {
			const fromServer = await via(async server => ok(external('jira', key ?? '', clip(await jiraVia.issue(server, key ?? ''), 16_000))), async () => undefined);
			if (fromServer) {
				return fromServer;
			}
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
			const fromServer = await via(async server => ok(external('jira', 'search', clip(await jiraVia.search(server, arg(args, 'jql') ?? '', Number(args.max) || 20), 16_000))), async () => undefined);
			if (fromServer) {
				return fromServer;
			}
			const jql = arg(args, 'jql') ?? '';
			const max = Number(args.max) || 20;
			// With more than one site, the sites that failed or have more than shown are named, so the list isn't taken as complete.
			const { issues, notes } = jira.searchSites ? await jira.searchSites(jql, max) : { issues: await jira.search(jql, max), notes: [] };
			// With more than one site, each line has its link: a key can be on two sites, and the link says which.
			return ok([issues.length ? external('jira', 'search', issues.map(i => `${i.key} [${i.status}] ${i.summary}${jira.searchSites ? ` (${i.url})` : ''}`).join('\n')) : 'No tickets match.', ...notes].join('\n'));
		}
		case 'jira_comment': {
			const id = await via(server => jiraVia.comment(server, key ?? '', arg(args, 'text') ?? '', defaults.jira?.commentVisibility), async () => (await jira.comment(key ?? '', arg(args, 'text') ?? '', defaults.jira?.commentVisibility)).id);
			return ok(`Commented on ${key}.`, id ? `comment ${id}` : undefined);
		}
		case 'jira_rich_comment':
			// Always the REST connector: mcp-atlassian has no mentions, no uploads and its own Markdown.
			return richComment(jira, key ?? '', args, defaults);
		case 'jira_log_time': {
			// A page gives the day the work was done; an agent logs it as now.
			const started = arg(args, 'started');
			const when = started ? new Date(started) : undefined;
			const id = await via(server => jiraVia.logWork(server, key ?? '', arg(args, 'spent') ?? '', arg(args, 'comment'), when), async () => (await jira.logWork(key ?? '', arg(args, 'spent') ?? '', arg(args, 'comment'), when)).id);
			return ok(`Logged ${arg(args, 'spent')} on ${key}.`, id ? `worklog ${id}` : undefined);
		}
		case 'jira_assign': {
			// A page names the person exactly, by account id, or null for nobody.
			if (args.accountId === null || typeof args.accountId === 'string') {
				const accountId = args.accountId;
				await via(server => jiraVia.assign(server, key ?? '', accountId), () => jira.assign(key ?? '', accountId));
				return ok(args.accountId === null ? `${key} is now unassigned.` : `Assigned ${key}.`, args.accountId === null ? 'unassigned' : `assignee ${args.accountId}`);
			}
			const to = arg(args, 'to');
			if (!to) {
				const people = await jira.assignableUsers(key ?? '');
				return ok(people.length ? `${key} can be assigned to:\n${people.map(u => `- ${u.displayName}${u.emailAddress ? ` (${u.emailAddress})` : ''}`).join('\n')}` : `Nobody can be assigned ${key}.`);
			}
			if (/^unassigned$/i.test(to)) {
				await via(server => jiraVia.assign(server, key ?? '', null), () => jira.assign(key ?? '', null));
				return ok(`${key} is now unassigned.`);
			}
			const person = /^me$/i.test(to) ? await jira.myself(key) : (await jira.assignableUsers(key ?? '', to))[0];
			if (!person) {
				return fail(`Nobody matching "${to}" can be assigned ${key}. Call jira_assign without \`to\` to list who can.`);
			}
			await via(server => jiraVia.assign(server, key ?? '', person.accountId), () => jira.assign(key ?? '', person.accountId));
			return ok(`Assigned ${key} to ${person.displayName}.`, `assignee ${person.accountId}`);
		}
		case 'jira_transition': {
			const to = arg(args, 'to');
			if (!to) {
				const moves = await jira.transitions(key ?? '');
				return ok(moves.length ? `${key} can move to:\n${moves.map(t => `- ${t.to}${t.fields.filter(f => f.required).length ? ` (needs ${t.fields.filter(f => f.required).map(f => f.name).join(', ')})` : ''}`).join('\n')}` : `${key} can't move from its current status.`);
			}
			const fields = typeof args.fields === 'object' && args.fields ? Object.fromEntries(Object.entries(args.fields as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {};
			const comment = arg(args, 'comment');
			// The team's comment visibility applies to a move's comment too: then the move goes alone and the comment after it, with its visibility.
			const visibility = comment ? defaults.jira?.commentVisibility : undefined;
			// A page names the transition by id; an agent by the status it moves to.
			const wanted = arg(args, 'transition') ?? to;
			const moved = await via(async server => {
				const moves = await jiraVia.transitions(server, key ?? '');
				const move = moves.find(t => t.id === wanted) ?? moves.find(t => t.to.toLowerCase() === wanted.toLowerCase() || t.name.toLowerCase() === wanted.toLowerCase());
				if (!move) {
					throw new Error(`${key} can't move to "${wanted}" from its current status. It can move to: ${moves.map(t => t.to).join(', ') || 'nothing'}.`);
				}
				await jiraVia.transition(server, key ?? '', move.id, visibility ? undefined : comment, fields);
				return { id: move.id, to: move.to };
			}, () => jira.transition(key ?? '', wanted, visibility ? undefined : comment, fields));
			const remote = `transition ${moved.id} → ${moved.to}`;
			let commentId: string | undefined;
			if (comment && visibility) {
				try {
					commentId = await via(server => jiraVia.comment(server, key ?? '', comment, visibility), async () => (await jira.comment(key ?? '', comment, visibility)).id);
				} catch (err) {
					// The move went through: a retry would move it again, or fail. Only the comment is left to add.
					return partly(`Moved ${key} to ${moved.to}.`, `The comment wasn't added: ${err instanceof Error ? err.message : String(err)}`, remote);
				}
			}
			return ok(`Moved ${key} to ${moved.to}${comment ? ' with the comment' : ''}.`, [remote, commentId ? `comment ${commentId}` : ''].filter(Boolean).join(' · '));
		}
	}
	return fail(`No tool named ${name}.`);
}

async function resolveMr(gitlab: GitLabClient, ref: string | undefined, folder: string | undefined, defaults: TeamDefaults, project?: string): Promise<{ project: string; iid: number }> {
	// A page knows the project; a number is then that project's merge request.
	if (project && ref && /^!?\d+$/.test(ref)) {
		return { project, iid: Number(ref.replace(/^!/, '')) };
	}
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

async function gitlabCall(gitlab: GitLabClient, via: Through, name: string, args: Record<string, unknown>, folder: string | undefined, defaults: TeamDefaults): Promise<TeamToolResult> {
	switch (name) {
		case 'gitlab_get_mr': {
			const { project, iid } = await resolveMr(gitlab, arg(args, 'mr'), folder, defaults);
			const [mr, discussions, diffs] = await Promise.all([gitlab.mr(project, iid), gitlab.discussions(project, iid), args.diff === false ? [] : gitlab.diffs(project, iid)]);
			const failed = mr.pipeline?.status === 'failed' ? await gitlab.jobs(project, mr.pipeline.id, true).catch(() => []) : [];
			return ok(external('gitlab', `!${iid}`, describeMr(mr, discussions, diffs, failed)));
		}
		case 'gitlab_list_mrs': {
			const list = arg(args, 'which') === 'mine' ? await gitlab.myMergeRequests() : await gitlab.reviewRequests();
			const more = list.total !== undefined && list.total > list.length ? `\n(${list.length} of ${list.total}, the most recently updated.)` : '';
			return ok(list.length ? `${list.map(mr => `!${mr.iid} ${mr.title} · ${mr.project} · ${mr.sourceBranch} → ${mr.targetBranch} · by ${mr.author}${mr.draft ? ' · draft' : ''} (${mr.url})`).join('\n')}${more}` : 'None.');
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
			const issueIid = Number(link?.[2] ?? ref.replace(/\D/g, ''));
			const fromServer = await via(async server => ok(external('gitlab', ref, clip(await gitlabVia.issue(server, project, issueIid), 16_000))), async () => undefined);
			if (fromServer) {
				return fromServer;
			}
			const issue = await gitlab.issue(project, issueIid);
			return ok(external('gitlab', issue.url, `${issue.title} (${issue.url}) · ${issue.state}${issue.labels.length ? ` · ${issue.labels.join(', ')}` : ''}\n\n${clip(issue.description, 12_000)}`));
		}
		case 'gitlab_create_mr': {
			const local = folder ? await gitlabProjectOf(folder, gitlab.url, defaults) : {};
			if (!local.project || !local.branch) {
				return fail('This folder isn\'t on a branch of a project on the connected GitLab.');
			}
			const reviewers = Array.isArray(args.reviewers) ? args.reviewers.filter((r): r is number => typeof r === 'number') : [];
			const request = {
				sourceBranch: local.branch,
				targetBranch: arg(args, 'target') ?? defaults.gitlab?.defaultTarget ?? 'main',
				title: arg(args, 'title') ?? local.branch,
				description: typeof args.description === 'string' ? args.description : '',
				draft: args.draft === true,
				...args.deleteBranch === false ? { removeSourceBranch: false } : {},
				...reviewers.length ? { reviewerIds: reviewers } : {},
			};
			const project = local.project;
			const mr = await via(server => gitlabVia.createMergeRequest(server, project, request), () => gitlab.createMergeRequest(project, request));
			return ok(`Opened !${mr.iid}: ${mr.url}`, `!${mr.iid}`, { iid: mr.iid, url: mr.url });
		}
		case 'gitlab_approve': {
			const { project, iid } = await resolveMr(gitlab, arg(args, 'mr'), folder, defaults, arg(args, 'project'));
			await via(server => gitlabVia.approve(server, project, iid), () => gitlab.approve(project, iid));
			gitlab.forgetReviewState(project, iid);
			return ok(`Approved !${iid}.`, `approval on !${iid}`);
		}
		case 'gitlab_request_changes': {
			const { project, iid } = await resolveMr(gitlab, arg(args, 'mr'), folder, defaults, arg(args, 'project'));
			await gitlab.requestChanges(project, iid, typeof args.text === 'string' ? args.text : '');
			gitlab.forgetReviewState(project, iid);
			return ok(`Requested changes on !${iid}.`, `requested_changes on !${iid}`);
		}
		case 'gitlab_reply': {
			const { project, iid } = await resolveMr(gitlab, arg(args, 'mr'), folder, defaults, arg(args, 'project'));
			const body = typeof args.text === 'string' ? args.text : '';
			const discussion = arg(args, 'discussion');
			if (discussion) {
				const noteId = await via(server => gitlabVia.reply(server, project, iid, discussion, body), async () => idText((await gitlab.replyToDiscussion(project, iid, discussion, body)).id));
				const remote = noteId ? `note ${noteId} on !${iid}` : `!${iid}`;
				if (args.resolve === true) {
					try {
						await via(server => gitlabVia.resolve(server, project, iid, discussion), () => gitlab.resolveDiscussion(project, iid, discussion));
					} catch (err) {
						// The reply is posted: a retry would post it again. Only resolving is left.
						return partly(`Replied on !${iid}.`, `The thread wasn't resolved: ${err instanceof Error ? err.message : String(err)}`, remote);
					}
				}
				return ok(`Replied on !${iid}${args.resolve === true ? ' and resolved the thread' : ''}.`, remote);
			}
			const path = arg(args, 'path');
			const line = Number(args.line);
			if (path && line > 0) {
				// A review page names the version the user saw and, on an unchanged line, its old line too.
				const oldLine = Number(args.oldLine);
				const [baseSha, startSha, headSha] = [arg(args, 'baseSha'), arg(args, 'startSha'), arg(args, 'headSha')];
				const where = await gitlab.commentOnLine(project, iid, path, line, body, {
					...oldLine > 0 ? { oldLine } : {},
					...arg(args, 'oldPath') ? { oldPath: arg(args, 'oldPath') } : {},
					...baseSha && startSha && headSha ? { refs: { baseSha, startSha, headSha } } : {},
				});
				return ok(where === 'line' ? `Commented on ${path}:${line} in !${iid}.` : `Commented on !${iid} (the line isn't in the diff, so as a general comment).`);
			}
			const noteId = await via(server => gitlabVia.comment(server, project, iid, body), async () => idText((await gitlab.comment(project, iid, body)).id));
			return ok(`Commented on !${iid}.`, noteId ? `note ${noteId} on !${iid}` : `!${iid}`);
		}
		case 'gitlab_resolve': {
			const { project, iid } = await resolveMr(gitlab, arg(args, 'mr'), folder, defaults, arg(args, 'project'));
			const discussion = arg(args, 'discussion');
			if (!discussion) {
				return fail('Name the thread to resolve.');
			}
			await via(server => gitlabVia.resolve(server, project, iid, discussion), () => gitlab.resolveDiscussion(project, iid, discussion));
			return ok(`Resolved the thread on !${iid}.`, `discussion ${discussion} on !${iid}`);
		}
		case 'gitlab_upload': {
			const file = arg(args, 'file');
			const project = arg(args, 'project') ?? (folder ? (await gitlabProjectOf(folder, gitlab.url, defaults)).project : undefined);
			if (!file || !project) {
				return fail('Name the file and the project to upload it to.');
			}
			const size = (await fs.stat(file)).size;
			if (size > maxUploadBytes) {
				return fail(`${path.basename(file)} is larger than ${maxUploadBytes / 1024 / 1024} MB, more than GitLab takes as an attachment.`);
			}
			const markdown = await gitlab.upload(project, path.basename(file), await fs.readFile(file));
			return ok(`Uploaded ${path.basename(file)}.`, `upload ${path.basename(file)} to ${project}`, { markdown });
		}
		case 'gitlab_merge': {
			// The merge request is always named: merging "the current branch's" could pick another of several open from it.
			if (!arg(args, 'mr')) {
				return fail('Name the merge request to merge with mr: its link, or its number such as 318.');
			}
			const { project, iid } = await resolveMr(gitlab, arg(args, 'mr'), folder, defaults, arg(args, 'project'));
			const readiness = await gitlab.mergeReadiness(project, iid);
			if (!readiness.ready) {
				return fail(`!${iid} isn't ready to merge:\n${readiness.checks.filter(c => !c.ok).map(c => `- ${c.name}: ${c.detail}`).join('\n')}`);
			}
			// A page names the head the user saw; a push since then means they confirmed something else.
			const seen = arg(args, 'sha');
			if (seen && !readiness.sha.startsWith(seen)) {
				return fail(`!${iid} moved since it was read: its head is now ${readiness.sha.slice(0, 8)}, not ${seen.slice(0, 8)}. Look at it again before merging.`);
			}
			const options = { sha: readiness.sha, ...args.squash === undefined ? {} : { squash: args.squash === true }, removeSourceBranch: args.deleteBranch !== false };
			const merged = await via(server => gitlabVia.merge(server, project, iid, options), () => gitlab.merge(project, iid, options));
			return ok(`Merged !${iid} at ${readiness.sha.slice(0, 8)}${merged.sha ? ` as ${merged.sha.slice(0, 8)}` : ''}.`, `!${iid} merged at ${readiness.sha}${merged.sha ? ` as ${merged.sha}` : ''}`, merged.sha ? { sha: merged.sha } : undefined);
		}
	}
	return fail(`No tool named ${name}.`);
}

async function sonarCall(sonar: SonarClient, via: Through, name: string, args: Record<string, unknown>, folder: string | undefined, defaults: TeamDefaults): Promise<McpToolResult> {
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
	const ref = target.mergeRequest ? `!${target.mergeRequest}` : target.branch ?? project;
	if (name === 'sonar_quality_gate') {
		return via(async server => {
			const [gate, issues] = await Promise.all([sonarVia.gate(server, target), sonarVia.issues(server, target, 20).catch(() => '')]);
			return ok(external('sonar', ref, clip([`Quality gate:\n${gate}`, issues && `Open issues:\n${issues}`].filter(Boolean).join('\n\n'), 20_000)));
		}, async () => {
			const [gate, issues] = await Promise.all([sonar.gate(target), sonar.issues(target, 20).catch(() => [])]);
			return ok(describeSonar(target, gate, issues, (issues as { readonly total?: number }).total));
		});
	}
	return via(async server => {
		const [issues, hotspots] = await Promise.all([sonarVia.issues(server, target), sonarVia.hotspots(server, target).catch(() => '')]);
		return ok(external('sonar', ref, clip([`Open issues:\n${issues}`, hotspots && `Security hotspots to review:\n${hotspots}`].filter(Boolean).join('\n\n'), 20_000)));
	}, async () => {
		const [issues, hotspots] = await Promise.all([sonar.issues(target), sonar.hotspots(target).catch(() => [])]);
		const total = (issues.total ?? issues.length) + ((hotspots as { readonly total?: number }).total ?? hotspots.length);
		return ok(describeSonar(target, undefined, [...issues, ...hotspots], total));
	});
}

async function figmaCall(figma: FigmaClient, name: string, args: Record<string, unknown>, codeConnect: boolean, tokens?: TokenIndex): Promise<McpToolResult> {
	const link = arg(args, 'link') ?? '';
	if (!parseFigmaLink(link)) {
		return fail('That isn\'t a Figma link. Copy the frame\'s link in Figma (it has node-id=…).');
	}
	let content: FigmaContent[];
	try {
		content = name === 'figma_screenshot' ? await figma.screenshot(link) : await figma.designContext(link, { ...arg(args, 'framework') ? { frameworks: arg(args, 'framework') } : {}, codeConnect });
	} catch (err) {
		if (isNodeNotFound(errorMessage(err))) {
			return fail('Figma can\'t find this frame. Ask the user to open its file in the Figma desktop app and go to the frame\'s page once (Figma only knows pages it has opened), then try again.');
		}
		throw err;
	}
	const viewport = arg(args, 'viewport');
	return ok([
		...viewport ? [{ type: 'text' as const, text: `The ${viewport} frame. Figma reads the file open in the desktop app: if this isn't the right frame, ask the user to open the file this link is in.` }] : [],
		// figma.ts keeps each part under the CLI's cap; the clip is only a guard.
		...content.map(c => c.type === 'text' ? { type: 'text' as const, text: external('figma', link, clip(tokens ? annotateTokens(c.text, tokens) : c.text, 40_000)) } : c),
	]);
}
