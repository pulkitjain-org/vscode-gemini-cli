/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { cardOrder, DashboardCardId, DashboardLayout, firstName, isReadyToMerge, needsYou, partOfDay, sprintProgress, ticketOrder } from '../acp/dashboard';
import type { AuditEntry } from '../acp/auditLog';
import type { ModelQuota } from '../acp/directRequest';
import type { FlowRecord } from '../acp/flowRecords';
import type { GitLabMr, PipelineState } from '../acp/gitlab';
import { type JiraIssueSummary, sprintJql } from '../acp/jira';
import { TeamToolId, teamToolIds, teamToolNames } from '../acp/teamHttp';
import type { AgentSummary } from './agentsView';
import { relativeTime } from './displayText';
import type { HomeAction, HomeCard, HomeCardId, HomeDashboard, HomeNeed, HomeRow, HomeTool, HomeTone } from './panelProtocol';
import type { ConnectionState } from './teamConnections';
import type { Fetched, TeamSnapshot } from './teamData';

export interface DashboardInput {
	readonly now: Date;
	readonly connected: ReadonlySet<TeamToolId>;
	readonly state: (tool: TeamToolId) => ConnectionState;
	readonly data: TeamSnapshot;
	readonly agents: readonly AgentSummary[];
	/** The repository Home starts agents in, by name. */
	readonly repository?: string;
	readonly layout?: DashboardLayout;
	readonly usage?: readonly ModelQuota[];
	readonly versions: { readonly app: string; readonly cli?: string };
	/** The Google Cloud project usage is billed to. */
	readonly projectId?: string;
	readonly projectsOn: boolean;
	readonly refreshing: boolean;
	/** A week after the first tool was connected: cards of tools still not connected stay out of the way. */
	readonly hideUnconnected: boolean;
	/** The GitLab server, for "Open in GitLab". */
	readonly gitlabUrl?: string;
	readonly jiraUrl?: string;
	/** Flows that were open, and writes that had no result, when the app last quit. */
	readonly unfinished?: { readonly flows: readonly FlowRecord[]; readonly intents: readonly AuditEntry[] };
	/** When the data on the cards was last read, in ms since the epoch; 0 or unset before the first read. */
	readonly dataFrom?: number;
	/** What came back since the window opened, for the card shown after a start. */
	readonly startup?: StartupState;
}

export interface StartupState {
	/** When the extension activated, in ms since the epoch. */
	readonly activatedAt: number;
	readonly agent: 'stopped' | 'starting' | 'ready' | 'error';
	/** When the agent was first ready in this window. */
	readonly readyAt?: number;
}

/** How long after the window opened the startup card stays. */
const startupCardMs = 3 * 60_000;

const connect: HomeAction = { kind: 'command', command: 'gemini.connections' };
const command = (id: string, ...args: unknown[]): HomeAction => ({ kind: 'command', command: id, args });

function cardTitles(): Record<HomeCardId, string> {
	return {
		unfinished: vscode.l10n.t("Unfinished when GeminiCode last quit"),
		startup: vscode.l10n.t("What came back, and when"),
		agents: vscode.l10n.t("Agents"),
		tickets: vscode.l10n.t("My tickets"),
		mergeRequests: vscode.l10n.t("Pending on me"),
		quality: vscode.l10n.t("Quality"),
		gemini: vscode.l10n.t("Gemini"),
	};
}

export function buildDashboard(input: DashboardInput): HomeDashboard {
	const { now, data } = input;
	const tools = teamToolIds.map(id => toolView(id, input));
	const unreachable = tools.filter(t => t.tone === 'warn' && t.id !== 'figma').map(t => t.name);
	const sprint = data.sprint?.data;
	const progress = sprint ? sprintProgress(sprint.issues, sprint.sprint, now.getTime()) : undefined;
	const name = firstName(input.connected.has('jira') ? input.state('jira').account : input.state('gitlab').account);
	const greeting = {
		morning: name ? vscode.l10n.t("Good morning, {0}", name) : vscode.l10n.t("Good morning"),
		afternoon: name ? vscode.l10n.t("Good afternoon, {0}", name) : vscode.l10n.t("Good afternoon"),
		evening: name ? vscode.l10n.t("Good evening, {0}", name) : vscode.l10n.t("Good evening"),
	}[partOfDay(now.getHours())];
	const sprintLine = sprint?.sprint ? progress?.daysLeft !== undefined
		? progress.daysLeft === 1 ? vscode.l10n.t("{0}, 1 day left", sprint.sprint.name) : vscode.l10n.t("{0}, {1} days left", sprint.sprint.name, progress.daysLeft)
		: sprint.sprint.name : undefined;
	const context = [now.toLocaleDateString(vscode.env.language, { weekday: 'long', day: 'numeric', month: 'long' }), input.repository, sprintLine].filter(Boolean).join(' · ');
	const titles = cardTitles();
	const builders: Record<DashboardCardId, () => HomeCard | undefined> = {
		unfinished: () => unfinishedCard(input, titles.unfinished),
		startup: () => startupCard(input, titles.startup),
		agents: () => agentsCard(input, titles.agents),
		tickets: () => ticketsCard(input, titles.tickets, progress),
		mergeRequests: () => mergeRequestsCard(input, titles.mergeRequests),
		quality: () => qualityCard(input, titles.quality),
		gemini: () => geminiCard(input, titles.gemini),
	};
	const cards = cardOrder(input.layout).flatMap(id => builders[id]() ?? []);
	const order = cardOrder({ ...input.layout, hidden: [] });
	const nothingConnected = !input.connected.size;
	return {
		greeting,
		context,
		tools,
		quickActions: [
			{ label: vscode.l10n.t("New Agent"), icon: 'sparkle', action: command('gemini.agents.newAgent') },
			...input.projectsOn ? [{ label: vscode.l10n.t("New Project"), icon: 'project', action: command('gemini.projects.new') }] : [],
			{ label: vscode.l10n.t("Review My Changes"), icon: 'diff', action: command('gemini.reviewChanges') },
			...input.connected.has('snyk') || input.connected.has('sonar') ? [{ label: vscode.l10n.t("Run Checks..."), tool: input.connected.has('snyk') ? 'snyk' as const : 'sonar' as const, action: command('gemini.team.runChecksOnBranch') }] : [],
		],
		needs: needs(input),
		needsQuery: 'agent waiting · pipeline failed · mergeable & approved · reviewer_id=me · reopened',
		cards,
		...nothingConnected ? { setup: setupSteps(input) } : {},
		...unreachable.length ? { banner: vscode.l10n.t("Can't reach {0}. Turn on your VPN to refresh; the cards show the last results.", listOf(unreachable)) } : {},
		...input.refreshing && input.dataFrom ? { stale: vscode.l10n.t("Showing results from {0} · refreshing", new Date(input.dataFrom).toLocaleTimeString(vscode.env.language, { hour: '2-digit', minute: '2-digit' })) } : {},
		layout: order.map(id => ({ id, title: titles[id], visible: !input.layout?.hidden?.includes(id) })),
		releaseBranches: data.releases?.data?.branches ?? [],
		...input.layout?.qualityBranch ? { qualityBranch: input.layout.qualityBranch } : {},
		refreshing: input.refreshing,
	};
}

function listOf(names: readonly string[]): string {
	return names.length < 2 ? names.join('') : vscode.l10n.t("{0} and {1}", names.slice(0, -1).join(', '), names[names.length - 1]);
}

function toolView(id: TeamToolId, input: DashboardInput): HomeTool {
	const name = teamToolNames[id];
	if (!input.connected.has(id)) {
		return { id, name, tone: 'off', label: vscode.l10n.t("{0}: not connected", name) };
	}
	const state = input.state(id);
	switch (state.kind) {
		case 'connected':
			return { id, name, tone: 'ok', label: state.account ? vscode.l10n.t("{0}: connected as {1}", name, state.account) : vscode.l10n.t("{0}: connected", name) };
		case 'unreachable':
			return { id, name, tone: 'warn', label: id === 'figma' ? vscode.l10n.t("Figma isn't open") : vscode.l10n.t("{0}: VPN off or can't be reached", name) };
		case 'checking':
		case 'off':
			return { id, name, tone: 'checking', label: vscode.l10n.t("{0}: checking...", name) };
		default:
			return { id, name, tone: 'error', label: state.detail ?? vscode.l10n.t("{0}: needs attention", name) };
	}
}

function needs(input: DashboardInput): HomeNeed[] {
	return needsYou({
		agents: input.agents,
		reviews: input.data.reviews?.data,
		mine: input.data.mine?.data,
		tickets: input.data.sprint?.data?.issues,
	}).map((item): HomeNeed => {
		switch (item.kind) {
			case 'agentWaiting':
				return { tool: 'gemini', title: vscode.l10n.t("{0} is waiting", item.title), detail: item.status, button: { label: vscode.l10n.t("Open"), action: { kind: 'agent', id: item.agentId, do: 'open' } } };
			case 'review':
				return { tool: 'gitlab', title: vscode.l10n.t("Review !{0}", item.mr.iid), detail: [item.mr.author, item.mr.title].join(' · '), button: { label: vscode.l10n.t("Review"), action: command('gemini.team.reviewMergeRequest', item.mr.project, item.mr.iid) } };
			case 'pipelineFailed':
				return {
					tool: 'gitlab', title: vscode.l10n.t("Pipeline failed on !{0}", item.mr.iid), detail: item.mr.title,
					...item.mr.pipeline ? { pill: { text: `#${item.mr.pipeline.id}`, tone: 'error' } } : {},
					button: { label: vscode.l10n.t("Fix"), action: command('gemini.team.fixMergeRequest', item.mr.project, item.mr.iid) },
				};
			case 'readyToMerge':
				return {
					tool: 'gitlab', title: vscode.l10n.t("!{0} is ready to merge", item.mr.iid), detail: item.mr.title,
					pill: { text: [vscode.l10n.t("mergeable"), item.mr.approvals ? vscode.l10n.t("{0} of {1} approvals", item.mr.approvals.given, item.mr.approvals.required) : '', item.mr.pipeline?.status === 'success' ? vscode.l10n.t("pipeline passed") : ''].filter(Boolean).join(' · '), tone: 'ok' },
					button: { label: vscode.l10n.t("Merge..."), action: command('gemini.team.mergeMergeRequest', item.mr.project, item.mr.iid), primary: true },
				};
			case 'reopened':
				return { tool: 'jira', title: vscode.l10n.t("{0} reopened", item.issue.key), detail: item.issue.summary, pill: { text: item.issue.status, tone: 'error' }, button: { label: vscode.l10n.t("Start Agent"), action: command('gemini.team.startOnTicket', item.issue.key) } };
		}
	});
}

function setupSteps(input: DashboardInput): HomeDashboard['setup'] {
	const agentStarted = input.agents.length > 0;
	return [
		{ title: vscode.l10n.t("Sign in to Gemini"), detail: vscode.l10n.t("Gemini Code Assist, with your Google account."), done: true },
		{ title: vscode.l10n.t("Connect your team's tools"), detail: vscode.l10n.t("Jira, GitLab, SonarQube, Snyk and Figma, each with your own account."), done: input.connected.size > 0, button: { label: vscode.l10n.t("Connect"), action: connect, primary: true } },
		{ title: vscode.l10n.t("Open a repository and start an agent"), detail: vscode.l10n.t("Describe a task above, or start from a Jira ticket."), done: agentStarted, button: { label: vscode.l10n.t("Open Folder"), action: command('workbench.action.files.openFolder') } },
	];
}

/** The card's state from its tool and source: not connected, stale (VPN off) or current. */
function sourceState(input: DashboardInput, tool: TeamToolId, fetched: Fetched<unknown> | undefined): { stale: boolean; note?: string } {
	const state = input.state(tool);
	const unreachable = state.kind === 'unreachable' || fetched?.error?.kind === 'unreachable';
	if (unreachable) {
		const when = fetched?.at ? relativeTime(fetched.at, input.now.getTime()) : undefined;
		return {
			stale: !!fetched?.data,
			note: tool === 'figma' || tool === 'jira'
				? vscode.l10n.t("Can't reach {0}. Check your connection.", teamToolNames[tool])
				: when ? vscode.l10n.t("VPN off: showing results from {0} ago. Turn on your VPN to refresh.", when) : vscode.l10n.t("VPN off. Turn on your VPN to see this."),
		};
	}
	if (fetched?.error) {
		return { stale: !!fetched.data, note: fetched.error.message };
	}
	if (state.kind === 'auth') {
		return { stale: !!fetched?.data, note: state.detail };
	}
	return { stale: false };
}

function notConnected(id: HomeCardId, title: string, tool: TeamToolId, text: string): HomeCard {
	return { id, title, tool, rows: [], connect: { text, button: { label: vscode.l10n.t("Connect {0}", teamToolNames[tool]), action: connect } } };
}

/** What a quit cut off: flows to reopen, and writes whose result never came, to check in the tool before doing them again. */
function unfinishedCard(input: DashboardInput, title: string): HomeCard | undefined {
	const flows = input.unfinished?.flows ?? [];
	const intents = input.unfinished?.intents ?? [];
	if (!flows.length && !intents.length) {
		return undefined;
	}
	const now = input.now.getTime();
	const rows: HomeRow[] = [
		...flows.map((flow): HomeRow => ({
			icon: 'window', title: flow.title, detail: [flow.about, relativeTime(Date.parse(flow.startedAt), now)].filter(Boolean).join(' · '),
			button: { label: vscode.l10n.t("Reopen"), action: command('gemini.team.reopenFlow', flow.id) },
			menu: [{ label: vscode.l10n.t("Discard"), action: command('gemini.team.discardFlow', flow.id) }],
		})),
		...intents.map((entry): HomeRow => ({
			tool: entry.tool.startsWith('jira') ? 'jira' : 'gitlab', title: entry.effect, detail: vscode.l10n.t("{0} · started {1}, no result recorded", entry.tool, relativeTime(Date.parse(entry.time), now)),
			pill: { text: vscode.l10n.t("intent only"), tone: 'warn' },
			button: { label: vscode.l10n.t("Open Audit Log"), action: command('gemini.openAuditLog') },
			menu: [{ label: vscode.l10n.t("Mark as Checked"), action: command('gemini.team.settleIntent', entry.id) }],
		})),
	];
	return { id: 'unfinished', title, icon: 'debug-restart', query: 'flows/*.json · audit intents without a result', rows, note: vscode.l10n.t("GeminiCode quit while these were running. Nothing was redone on its own: a write may have gone through, so look in the tool first.") };
}

/**
 * After a start: what is back and what is still coming (gemini/docs/AGENTIC-PLAN.md,
 * the restart model), for a few minutes after the window opened.
 */
function startupCard(input: DashboardInput, title: string): HomeCard | undefined {
	const startup = input.startup;
	const now = input.now.getTime();
	if (!startup || now - startup.activatedAt > startupCardMs) {
		return undefined;
	}
	const seconds = (ms: number) => vscode.l10n.t("{0} s", (ms / 1000).toFixed(1));
	const done = { text: vscode.l10n.t("done"), tone: 'ok' as const };
	const rows: HomeRow[] = [
		{ icon: 'check', title: vscode.l10n.t("Agent list, transcripts, Home's last data, tokens (keychain)"), detail: vscode.l10n.t("at start"), pill: done },
		{
			icon: 'sparkle', title: vscode.l10n.t("Gemini CLI started ahead of the first chat"),
			detail: startup.readyAt ? seconds(startup.readyAt - startup.activatedAt) : startup.agent === 'starting' ? vscode.l10n.t("starting") : '',
			pill: startup.agent === 'ready' ? done : startup.agent === 'starting' ? { text: vscode.l10n.t("starting"), tone: 'info' } : startup.agent === 'error' ? { text: vscode.l10n.t("needs attention"), tone: 'error' } : { text: vscode.l10n.t("not started"), tone: 'muted' },
		},
		{ icon: 'sync', title: vscode.l10n.t("Jira, GitLab, SonarQube and Snyk refreshed behind the cards"), detail: vscode.l10n.t("background"), pill: input.refreshing || !input.dataFrom ? { text: vscode.l10n.t("refreshing"), tone: 'info' } : done },
		{ icon: 'debug-restart', title: vscode.l10n.t("Spare session, pending permission cards, session approvals"), detail: vscode.l10n.t("gone, by design"), pill: { text: vscode.l10n.t("reset"), tone: 'muted' } },
	];
	return { id: 'startup', title, icon: 'history', query: 'cold start · restart model', rows };
}

function agentsCard(input: DashboardInput, title: string): HomeCard {
	const rows: HomeRow[] = [];
	const live = input.agents.filter(a => !a.project && a.state !== 'stopped' && a.state !== 'idle' || (!a.project && !!a.changes?.files));
	for (const agent of live.slice(0, 5)) {
		const tone: HomeTone = agent.state === 'working' ? 'info' : agent.state === 'waiting' ? 'warn' : agent.state === 'error' ? 'error' : 'ok';
		const label = agent.state === 'working' ? vscode.l10n.t("working") : agent.state === 'waiting' ? vscode.l10n.t("waiting") : agent.state === 'error' ? vscode.l10n.t("stopped with an error") : agent.changes?.files ? vscode.l10n.t("ready to review") : vscode.l10n.t("done");
		rows.push({
			icon: 'circle-filled',
			title: agent.title,
			pill: { text: label, tone },
			open: { kind: 'agent', id: agent.id, do: 'open' },
			...agent.changes?.files && agent.state !== 'working' ? { button: { label: vscode.l10n.t("Review"), action: { kind: 'agent', id: agent.id, do: 'review' } } } : {},
		});
	}
	for (const project of input.agents.filter(a => a.project?.role === 'coordinator').slice(0, 2)) {
		const threads = project.project?.role === 'coordinator' ? project.project.threads : 0;
		rows.push({ icon: 'project', title: project.title, detail: threads === 1 ? vscode.l10n.t("1 thread") : vscode.l10n.t("{0} threads", threads), open: { kind: 'agent', id: project.id, do: 'open' } });
	}
	return {
		id: 'agents', title, tool: 'gemini', rows,
		link: { label: vscode.l10n.t("All agents"), action: command('gemini.agents.focus') },
		...rows.length ? {} : { note: vscode.l10n.t("No agents at work. Describe a task above to start one.") },
	};
}

function statusTone(issue: JiraIssueSummary): HomeTone {
	if (/reopen/i.test(issue.status)) {
		return 'error';
	}
	if (issue.statusCategory === 'done') {
		return 'ok';
	}
	if (/review/i.test(issue.status)) {
		return 'ok';
	}
	return issue.statusCategory === 'indeterminate' ? 'warn' : 'info';
}

function ticketsCard(input: DashboardInput, title: string, progress: { done: number; total: number } | undefined): HomeCard | undefined {
	if (!input.connected.has('jira')) {
		return input.hideUnconnected ? undefined : notConnected('tickets', title, 'jira', vscode.l10n.t("Your tickets in the current sprint, with Start Agent on each."));
	}
	const fetched = input.data.sprint;
	const { stale, note } = sourceState(input, 'jira', fetched);
	const sprint = fetched?.data;
	const rows: HomeRow[] = ticketOrder(sprint?.issues ?? []).slice(0, 6).map(issue => ({
		key: issue.key,
		title: issue.summary,
		pill: { text: issue.status, tone: statusTone(issue) },
		open: { kind: 'link', url: issue.url },
		...issue.statusCategory === 'new' || /reopen/i.test(issue.status) ? { button: { label: vscode.l10n.t("Start"), action: command('gemini.team.startOnTicket', issue.key), title: vscode.l10n.t("Start an agent on {0}", issue.key) } } : {},
		menu: [
			{ label: vscode.l10n.t("Start Agent"), action: command('gemini.team.startOnTicket', issue.key) },
			{ label: vscode.l10n.t("Log Time..."), action: command('gemini.team.logTime', issue.key) },
			{ label: vscode.l10n.t("Move..."), action: command('gemini.team.moveTicket', issue.key) },
			{ label: vscode.l10n.t("Reassign..."), action: command('gemini.team.reassignTicket', issue.key) },
			{ label: vscode.l10n.t("Open in Jira"), action: { kind: 'link', url: issue.url } },
		],
	}));
	if (progress?.total) {
		rows.push({ title: vscode.l10n.t("{0} of {1} done", progress.done, progress.total), bar: progress.done / progress.total });
	}
	return {
		id: 'tickets', title, tool: 'jira', rows, stale, query: sprintJql,
		...sprint?.sprint ? { link: { label: sprint.sprint.name, action: { kind: 'link', url: `${input.jiraUrl ?? ''}/issues/?jql=${encodeURIComponent(sprintJql)}` } } } : {},
		...note ? { note } : !rows.length ? { note: fetched?.loading || !fetched ? vscode.l10n.t("Loading your tickets...") : vscode.l10n.t("No tickets assigned to you in an open sprint.") } : {},
	};
}

function pipelinePill(mr: GitLabMr): HomeRow['pill'] {
	const status: PipelineState | undefined = mr.pipeline?.status;
	if (status === 'failed') {
		return { text: vscode.l10n.t("pipeline failed"), tone: 'error' };
	}
	if (status === 'running' || status === 'pending' || status === 'created') {
		return { text: vscode.l10n.t("pipeline running"), tone: 'info' };
	}
	if (mr.approvals) {
		return { text: vscode.l10n.t("{0} of {1} approvals", mr.approvals.given, Math.max(mr.approvals.required, mr.approvals.given)), tone: mr.approvals.given >= mr.approvals.required && mr.approvals.required > 0 ? 'ok' : 'muted' };
	}
	return status === 'success' ? { text: vscode.l10n.t("pipeline passed"), tone: 'ok' } : undefined;
}

function mergeRequestsCard(input: DashboardInput, title: string): HomeCard | undefined {
	if (!input.connected.has('gitlab')) {
		return input.hideUnconnected ? undefined : notConnected('mergeRequests', title, 'gitlab', vscode.l10n.t("Merge requests waiting for your review or assigned to you, and yours with their pipeline, approvals and whether they can merge."));
	}
	const reviews = input.data.reviews;
	const mine = input.data.mine;
	const { stale, note } = sourceState(input, 'gitlab', reviews?.error ? reviews : mine);
	const mineGroup = vscode.l10n.t("Mine");
	const rows: HomeRow[] = [
		...(reviews?.data ?? []).slice(0, 4).map((mr): HomeRow => ({
			key: `!${mr.iid}`, title: mr.title, detail: mr.author, open: { kind: 'link', url: mr.url },
			...mr.draft ? { pill: { text: vscode.l10n.t("draft"), tone: 'muted' as const } } : {},
			button: { label: vscode.l10n.t("Review"), action: command('gemini.team.reviewMergeRequest', mr.project, mr.iid) },
		})),
		...(mine?.data ?? []).slice(0, 4).map((mr, i): HomeRow => ({
			...i === 0 ? { group: mineGroup, groupQuery: 'author_id=me, state=opened' } : {},
			key: `!${mr.iid}`, title: mr.title, open: { kind: 'link', url: mr.url },
			...isReadyToMerge(mr) ? { pill: { text: vscode.l10n.t("ready to merge"), tone: 'ok' as const }, button: { label: vscode.l10n.t("Merge..."), action: command('gemini.team.mergeMergeRequest', mr.project, mr.iid), primary: true } }
				: { ...pipelinePill(mr) ? { pill: pipelinePill(mr) } : {}, ...mr.pipeline?.status === 'failed' ? { button: { label: vscode.l10n.t("Fix"), action: command('gemini.team.fixMergeRequest', mr.project, mr.iid) } } : {} },
		})),
	];
	return {
		id: 'mergeRequests', title, tool: 'gitlab', rows, stale, query: 'reviewer_id=me OR assignee_id=me, state=opened',
		...input.gitlabUrl ? { link: { label: vscode.l10n.t("Open in GitLab"), action: { kind: 'link', url: `${input.gitlabUrl}/dashboard/merge_requests?reviewer_username=${encodeURIComponent(input.state('gitlab').account ?? '')}` } } } : {},
		...note ? { note } : !rows.length ? { note: !reviews || reviews.loading ? vscode.l10n.t("Loading merge requests...") : vscode.l10n.t("No open merge requests for you or waiting on you.") } : {},
	};
}

function qualityCard(input: DashboardInput, title: string): HomeCard | undefined {
	const sonar = input.connected.has('sonar');
	const snyk = input.connected.has('snyk');
	if (!sonar && !snyk) {
		return input.hideUnconnected ? undefined : notConnected('quality', title, 'sonar', vscode.l10n.t("The SonarQube quality gate and Snyk issues on your current release branch, each with Fix."));
	}
	const quality = input.data.quality;
	const snykData = input.data.snyk;
	const rows: HomeRow[] = [];
	const branch = quality?.data?.branch;
	if (sonar && quality?.data) {
		const gate = quality.data.gate;
		const passed = gate?.status === 'OK';
		rows.push({
			tool: 'sonar', title: vscode.l10n.t("Quality gate"),
			pill: {
				text: [gate?.status === 'OK' ? vscode.l10n.t("passed") : gate?.status === 'ERROR' ? vscode.l10n.t("failed") : gate?.status === 'WARN' ? vscode.l10n.t("warning") : vscode.l10n.t("not analysed"), gate?.coverage ? vscode.l10n.t("coverage {0}%", Math.round(Number(gate.coverage))) : ''].filter(Boolean).join(' · '),
				tone: passed ? 'ok' : gate?.status === 'ERROR' ? 'error' : 'muted',
			},
			...quality.data.url ? { open: { kind: 'link', url: quality.data.url } } : {},
		});
		if (quality.data.newIssues) {
			rows.push({
				tool: 'sonar', title: vscode.l10n.t("New issues"),
				detail: quality.data.major ? vscode.l10n.t("{0} · {1} major", quality.data.newIssues, quality.data.major) : String(quality.data.newIssues),
				button: { label: vscode.l10n.t("Fix"), action: command('gemini.team.runChecks') },
			});
		}
	}
	if (snyk && snykData?.data) {
		const s = snykData.data;
		const bad = s.high + s.critical;
		rows.push(s.problem
			? { tool: 'snyk', title: vscode.l10n.t("Snyk"), detail: s.problem }
			: bad
				? { tool: 'snyk', title: s.critical ? vscode.l10n.t("Snyk: {0} critical, {1} high in dependencies", s.critical, s.high) : vscode.l10n.t("Snyk: {0} high in dependencies", s.high), detail: s.packages.join(', '), button: { label: vscode.l10n.t("Fix"), action: command('gemini.team.runChecks') } }
				: { tool: 'snyk', title: vscode.l10n.t("Snyk: no high issues in dependencies"), pill: { text: vscode.l10n.t("clean"), tone: 'ok' } });
	}
	const sonarState = sonar ? sourceState(input, 'sonar', quality) : { stale: false };
	const snykState = snyk ? sourceState(input, 'snyk', snykData) : { stale: false };
	const note = sonarState.note ?? snykState.note;
	return {
		id: 'quality',
		title: branch ? vscode.l10n.t("Quality on {0}", branch) : title,
		tool: sonar ? 'sonar' : 'snyk',
		query: [sonar ? 'sonar gate' : '', snyk ? 'snyk test' : ''].filter(Boolean).join(' · '),
		rows,
		stale: sonarState.stale || snykState.stale,
		...note ? { note } : !rows.length ? { note: vscode.l10n.t("Loading checks...") } : {},
	};
}

function geminiCard(input: DashboardInput, title: string): HomeCard {
	const rows: HomeRow[] = [];
	const used = input.usage?.length ? Math.max(...input.usage.map(q => q.used)) : undefined;
	if (used !== undefined) {
		rows.push({ title: vscode.l10n.t("Today: {0}% of daily requests", Math.round(used * 100)), bar: used, link: { label: vscode.l10n.t("Usage details"), action: command('gemini.showUsage') } });
	}
	const about = [
		vscode.l10n.t("GeminiCode {0}", input.versions.app),
		input.versions.cli ? vscode.l10n.t("CLI {0}", input.versions.cli) : '',
		input.projectId ? vscode.l10n.t("project {0}", input.projectId) : '',
	].filter(Boolean).join(' · ');
	rows.push({ icon: 'versions', title: about, link: { label: vscode.l10n.t("Audit log"), action: command('gemini.openAuditLog') } });
	return { id: 'gemini', title, tool: 'gemini', rows, query: 'retrieveUserQuota · audit/*.jsonl' };
}

