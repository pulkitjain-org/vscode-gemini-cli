/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { cardOrder, DashboardCardId, DashboardLayout, firstName, isReadyToMerge, needsYou, partOfDay, sprintProgress, ticketGroups } from '../acp/dashboard';
import type { AuditEntry } from '../acp/auditLog';
import type { ModelQuota } from '../acp/directRequest';
import type { FlowRecord } from '../acp/flowRecords';
import type { GitLabMr, PipelineState } from '../acp/gitlab';
import { type JiraIssueSummary, type JiraMyTicket, type JiraSiteTickets, type JiraSprint, myTicketsJql } from '../acp/jira';
import { teamBanners } from '../acp/homeBanners';
import { ServerHealth, TeamToolId, teamToolIds, teamToolNames } from '../acp/teamHttp';
import type { AgentSummary } from './agentsView';
import { relativeTime } from './displayText';
import type { HomeAction, HomeBanner, HomeButton, HomeCard, HomeCardId, HomeDashboard, HomeList, HomeNeed, HomeRow, HomeTool, HomeTone, HomeTypeColor } from './panelProtocol';
import type { ConnectionState } from './teamConnections';
import type { Fetched, TeamSnapshot } from './teamData';

export interface DashboardInput {
	readonly now: Date;
	readonly connected: ReadonlySet<TeamToolId>;
	readonly state: (tool: TeamToolId) => ConnectionState;
	/** The worst reachability among the tool's servers in this window (`TeamConnections.serverHealth`), for the banners. */
	readonly health?: (tool: TeamToolId) => ServerHealth;
	/** When the tool's data on the cards came (`TeamData.resultsAt`), for the banners. */
	readonly resultsAt?: (tool: TeamToolId) => number | undefined;
	readonly data: TeamSnapshot;
	readonly agents: readonly AgentSummary[];
	readonly layout?: DashboardLayout;
	readonly usage?: readonly ModelQuota[];
	readonly versions: { readonly app: string; readonly cli?: string };
	/** The Google Cloud project usage is billed to. */
	readonly projectId?: string;
	/** Whether the CLI has a saved sign-in it can start with, as the warm-up decides. */
	readonly signedIn: boolean;
	readonly projectsOn: boolean;
	readonly refreshing: boolean;
	/** A week after the first tool was connected: cards of tools still not connected stay out of the way. */
	readonly hideUnconnected: boolean;
	/** The GitLab server, for "Open in GitLab". */
	readonly gitlabUrl?: string;
	readonly jiraUrl?: string;
	/** The project role the team's Jira comments are limited to (`.gemini/geminicode-tools.json`). */
	readonly jiraCommentVisibility?: string;
	/** Flows that were open, and writes that had no result, when the app last quit. */
	readonly unfinished?: { readonly flows: readonly FlowRecord[]; readonly intents: readonly AuditEntry[] };
	/** Merge request reviews in progress: Continue Review instead of Review. */
	readonly reviewsInProgress?: readonly { readonly project: string; readonly iid: number; readonly comments: number; readonly agentId?: string }[];
	/** When the data on the cards was last read, in ms since the epoch; 0 or unset before the first read. */
	readonly dataFrom?: number;
	/** What came back since the window opened, for the card shown after a start. */
	readonly startup?: StartupState;
	/** The card whose whole list is open in the page's popup. */
	readonly list?: HomeCardId;
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

/** A card, and the whole list its first rows come from, for the popup Show All opens. */
interface ListedCard {
	readonly card: HomeCard;
	readonly all?: readonly HomeRow[];
}

/** The card showing `shown` of `all`, with the count Show All offers when that leaves rows out. */
function listed(card: Omit<HomeCard, 'rows' | 'total'>, all: readonly HomeRow[], shown: readonly HomeRow[]): ListedCard {
	return { card: { ...card, rows: shown, ...all.length > shown.length ? { total: all.length } : {} }, all };
}

/** A card with no list beyond what it shows. */
function fixed(card: HomeCard | undefined): ListedCard | undefined {
	return card ? { card } : undefined;
}

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
	const tickets = data.tickets?.data;
	const groups = ticketGroups(tickets?.issues ?? []);
	// Closed tickets leave the list but still count towards the sprint's progress.
	const progress = tickets ? sprintProgress(tickets.issues.filter(i => i.inSprint), tickets.sprint, now.getTime()) : undefined;
	const name = firstName(input.connected.has('jira') ? input.state('jira').account : input.state('gitlab').account);
	const greeting = {
		morning: name ? vscode.l10n.t("Good morning, {0}", name) : vscode.l10n.t("Good morning"),
		afternoon: name ? vscode.l10n.t("Good afternoon, {0}", name) : vscode.l10n.t("Good afternoon"),
		evening: name ? vscode.l10n.t("Good evening, {0}", name) : vscode.l10n.t("Good evening"),
	}[partOfDay(now.getHours())];
	const sprintLine = tickets?.sprint ? progress?.daysLeft !== undefined
		? progress.daysLeft === 1 ? vscode.l10n.t("{0}, 1 day left", tickets.sprint.name) : vscode.l10n.t("{0}, {1} days left", tickets.sprint.name, progress.daysLeft)
		: tickets.sprint.name : undefined;
	const context = [now.toLocaleDateString(vscode.env.language, { weekday: 'long', day: 'numeric', month: 'long' }), sprintLine].filter(Boolean).join(' · ');
	const titles = cardTitles();
	const builders: Record<DashboardCardId, () => ListedCard | undefined> = {
		unfinished: () => unfinishedCard(input, titles.unfinished),
		startup: () => fixed(startupCard(input, titles.startup)),
		agents: () => agentsCard(input, titles.agents),
		tickets: () => ticketsCard(input, titles.tickets, groups, tickets?.sprint, progress, now),
		mergeRequests: () => mergeRequestsCard(input, titles.mergeRequests),
		quality: () => fixed(qualityCard(input, titles.quality)),
		gemini: () => fixed(geminiCard(input, titles.gemini)),
	};
	const built = new Map(cardOrder(input.layout).map(id => [id, builders[id]()] as const));
	const cards = [...built.values()].flatMap(listedCard => listedCard ? [listedCard.card] : []);
	const open = input.list ? built.get(input.list) ?? builders[input.list]() : undefined;
	const list: HomeList | undefined = open?.all ? {
		card: open.card.id, title: open.card.title, rows: open.all,
		...open.card.tool ? { tool: open.card.tool } : {}, ...open.card.icon ? { icon: open.card.icon } : {}, ...open.card.query ? { query: open.card.query } : {},
	} : undefined;
	const order = cardOrder({ ...input.layout, hidden: [] });
	const nothingConnected = !input.connected.size;
	return {
		greeting,
		context,
		tools,
		quickActions: [
			{ label: vscode.l10n.t("New Agent"), icon: 'sparkle', action: command('gemini.agents.newAgent') },
			{ label: vscode.l10n.t("Review"), icon: 'diff', action: command('gemini.review') },
			...input.connected.has('snyk') || input.connected.has('sonar') ? [{ label: vscode.l10n.t("Run Checks..."), tool: input.connected.has('snyk') ? 'snyk' as const : 'sonar' as const, action: command('gemini.team.runChecksOnBranch') }] : [],
		],
		needs: needs(input),
		needsQuery: 'agent waiting · unresolved threads on your MRs · pipeline failed · mergeable & approved · ready to try · reviewer_id=me (2 shown) · reopened',
		cards,
		...nothingConnected ? { setup: setupSteps(input) } : {},
		...banners(input),
		...input.refreshing && input.dataFrom ? { stale: vscode.l10n.t("Showing results from {0} · refreshing", clockTime(input.dataFrom)) } : {},
		layout: order.map(id => ({ id, title: titles[id], visible: !input.layout?.hidden?.includes(id) })),
		releaseBranches: data.releases?.data?.branches ?? [],
		...input.layout?.qualityBranch ? { qualityBranch: input.layout.qualityBranch } : {},
		refreshing: input.refreshing,
		...list ? { list } : {},
	};
}

/** A time of day, as "10:42". */
function clockTime(at: number): string {
	return new Date(at).toLocaleTimeString(vscode.env.language, { hour: '2-digit', minute: '2-digit' });
}

/** A banner per team server that can't be reached, with Retry, or that refused the token, with Replace Token (Connections). */
function banners(input: DashboardInput): { banners?: HomeBanner[] } {
	const list = teamBanners({
		tools: teamToolIds,
		connected: input.connected,
		state: input.state,
		health: input.health ?? (() => ({ kind: 'ok' })),
		resultsAt: input.resultsAt ?? (() => undefined),
	}).map((banner): HomeBanner => {
		const name = teamToolNames[banner.tool];
		return banner.kind === 'auth'
			? { tool: banner.tool, tone: 'error', text: vscode.l10n.t("{0} rejected your token.", name), button: { label: vscode.l10n.t("Replace Token..."), action: connect, primary: true } }
			: {
				tool: banner.tool, tone: 'warn',
				text: banner.resultsAt ? vscode.l10n.t("{0} is unreachable, probably the VPN. Showing results from {1}.", name, clockTime(banner.resultsAt)) : vscode.l10n.t("{0} is unreachable, probably the VPN.", name),
				button: { label: vscode.l10n.t("Retry"), action: { kind: 'retry', tool: banner.tool } },
			};
	});
	return list.length ? { banners: list } : {};
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
	const account = input.state('gitlab').account;
	return needsYou({
		// A project's threads are on their project's cards; an agent of its own is ready to try once done with changes.
		agents: input.agents.map(a => ({ id: a.id, title: a.title, state: a.state, status: a.status, ...a.state === 'done' && a.worktree && a.changes?.files && !a.trying && !a.project ? { tryReady: true } : {} })),
		reviews: input.data.reviews?.data,
		mine: input.data.mine?.data,
		tickets: input.data.tickets?.data?.issues,
		reviewing: new Set((input.reviewsInProgress ?? []).map(r => `${r.project}!${r.iid}`)),
		...account ? { me: account } : {},
	}).map((item): HomeNeed => {
		switch (item.kind) {
			case 'agentWaiting':
				return { tool: 'gemini', title: vscode.l10n.t("{0} is waiting", item.title), detail: item.status, button: { label: vscode.l10n.t("Open"), action: { kind: 'agent', id: item.agentId, do: 'open' } } };
			case 'reply':
				return { tool: 'gitlab', title: vscode.l10n.t("Reply on !{0}", item.mr.iid), detail: item.mr.title, pill: { text: vscode.l10n.t("unresolved threads"), tone: 'warn' }, button: { label: vscode.l10n.t("Open"), action: { kind: 'link', url: item.mr.url } } };
			case 'tryReady':
				return { tool: 'gemini', title: vscode.l10n.t("{0} is ready to try", item.title), detail: vscode.l10n.t("Its changes are on its own branch. Try them in your workspace before keeping them."), button: { label: vscode.l10n.t("Try in Workspace"), action: { kind: 'agent', id: item.agentId, do: 'mergeBack' } } };
			case 'moreReviews':
				return {
					tool: 'gitlab', title: item.count === 1 ? vscode.l10n.t("1 more review waiting") : vscode.l10n.t("{0} more reviews waiting", item.count),
					detail: item.oldest ? vscode.l10n.t("The oldest waiting since {0}", new Date(item.oldest).toLocaleDateString()) : '',
					button: input.gitlabUrl
						? { label: vscode.l10n.t("Show All"), action: { kind: 'link', url: `${input.gitlabUrl}/dashboard/merge_requests?reviewer_username=${encodeURIComponent(account ?? '')}` } }
						: { label: vscode.l10n.t("Show All"), action: command('gemini.home') },
				};
			case 'review':
				return { tool: 'gitlab', title: vscode.l10n.t("Review !{0}", item.mr.iid), detail: [item.mr.author, item.mr.title].join(' · '), button: reviewButton(input, item.mr) };
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
				return { tool: 'jira', title: vscode.l10n.t("{0} reopened", item.issue.key), detail: item.issue.summary, pill: { text: item.issue.status, tone: 'error' }, button: { label: vscode.l10n.t("Start Agent"), action: command('gemini.team.startOnTicket', item.issue.url) } };
		}
	});
}

function setupSteps(input: DashboardInput): HomeDashboard['setup'] {
	const agentStarted = input.agents.length > 0;
	return [
		{ title: vscode.l10n.t("Sign in to Gemini"), detail: vscode.l10n.t("Gemini Code Assist, with your Google account."), done: input.signedIn, button: { label: vscode.l10n.t("Sign In"), action: command('gemini.signIn'), primary: true } },
		{ title: vscode.l10n.t("Set your Google Cloud Project ID"), detail: vscode.l10n.t("The Google Cloud project your usage is billed to. Your organisation may set it for you."), done: !!input.projectId, button: { label: vscode.l10n.t("Set Project ID"), action: command('gemini.setProjectId') } },
		{ title: vscode.l10n.t("Connect your team's tools"), detail: vscode.l10n.t("Jira, GitLab, SonarQube, Snyk and Figma, each with your own account."), done: input.connected.size > 0, button: { label: vscode.l10n.t("Connect"), action: connect, primary: input.signedIn } },
		{ title: vscode.l10n.t("Open a repository and start an agent"), detail: vscode.l10n.t("Describe a task above, or start from a Jira ticket."), done: agentStarted, button: { label: vscode.l10n.t("Open Folder"), action: command('workbench.action.files.openFolder') } },
	];
}

/**
 * The card's state from its tool and source: not connected, stale (VPN off,
 * token refused) or current. A stale card keeps its last results with their
 * time (`asOf`); the banner above the cards says why, so the card doesn't.
 */
function sourceState(input: DashboardInput, tool: TeamToolId, fetched: Fetched<unknown> | undefined): { stale: boolean; note?: string; asOf?: string } {
	const state = input.state(tool);
	const kept = fetched?.data !== undefined && fetched.at ? { stale: true, asOf: clockTime(fetched.at) } : undefined;
	const unreachable = state.kind === 'unreachable' || fetched?.error?.kind === 'unreachable';
	if (unreachable) {
		return kept ?? {
			stale: false,
			note: tool === 'figma' || tool === 'jira' ? vscode.l10n.t("Can't reach {0}. Check your connection.", teamToolNames[tool]) : vscode.l10n.t("VPN off. Turn on your VPN to see this."),
		};
	}
	if (state.kind === 'auth' || fetched?.error?.kind === 'auth') {
		return kept ?? { stale: false, note: state.detail ?? fetched?.error?.message };
	}
	if (fetched?.error) {
		return { stale: !!fetched.data, note: fetched.error.message };
	}
	return { stale: false };
}

function notConnected(id: HomeCardId, title: string, tool: TeamToolId, text: string): HomeCard {
	return { id, title, tool, rows: [], connect: { text, button: { label: vscode.l10n.t("Connect {0}", teamToolNames[tool]), action: connect } } };
}

/** What a quit cut off: flows to reopen, and writes whose result never came, to check in the tool before doing them again. */
function unfinishedCard(input: DashboardInput, title: string): ListedCard | undefined {
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
	return listed({ id: 'unfinished', title, icon: 'debug-restart', query: 'flows/*.json · audit intents without a result', note: vscode.l10n.t("GeminiCode quit while these were running. Nothing was redone on its own: a write may have gone through, so look in the tool first.") }, rows, rows.slice(0, 5));
}

/**
 * After a start: what is back and what is still coming (gemini/docs/ARCHITECTURE.md,
 * "Restarts"), for a few minutes after the window opened.
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

function agentsCard(input: DashboardInput, title: string): ListedCard {
	const own = input.agents.filter(a => !a.project);
	const isLive = (a: AgentSummary) => a.state !== 'stopped' && a.state !== 'idle' || !!a.changes?.files;
	const live = own.filter(isLive).map((agent): HomeRow => {
		const tone: HomeTone = agent.state === 'working' ? 'info' : agent.state === 'waiting' ? 'warn' : agent.state === 'error' ? 'error' : 'ok';
		const label = agent.state === 'working' ? vscode.l10n.t("working") : agent.state === 'waiting' ? vscode.l10n.t("waiting") : agent.state === 'error' ? vscode.l10n.t("stopped with an error") : agent.changes?.files ? vscode.l10n.t("ready to review") : vscode.l10n.t("done");
		return {
			icon: 'circle-filled',
			title: agent.title,
			pill: { text: label, tone },
			open: { kind: 'agent', id: agent.id, do: 'open' },
			...agent.changes?.files && agent.state !== 'working' ? { button: { label: vscode.l10n.t("Review"), action: { kind: 'agent', id: agent.id, do: 'review' } } } : {},
		};
	});
	const now = input.now.getTime();
	const earlier = own.filter(a => !isLive(a)).sort((a, b) => b.updatedAt - a.updatedAt).map((agent, i): HomeRow => ({
		...i === 0 ? { group: vscode.l10n.t("Earlier") } : {},
		icon: 'circle-outline', title: agent.title, detail: relativeTime(agent.updatedAt, now), open: { kind: 'agent', id: agent.id, do: 'open' },
	}));
	const projects = input.agents.filter(a => a.project?.role === 'coordinator').map((project, i): HomeRow => {
		const threads = project.project?.role === 'coordinator' ? project.project.threads : 0;
		return {
			...i === 0 ? { group: vscode.l10n.t("Projects") } : {},
			icon: 'project', title: project.title, detail: threads === 1 ? vscode.l10n.t("1 thread") : vscode.l10n.t("{0} threads", threads), open: { kind: 'agent', id: project.id, do: 'open' },
		};
	});
	const shown = [...live.slice(0, 5), ...projects.slice(0, 2)];
	return listed({
		id: 'agents', title, tool: 'gemini',
		link: { label: vscode.l10n.t("All agents"), action: command('gemini.agents.focus') },
		...shown.length ? {} : { note: vscode.l10n.t("No agents at work. Describe a task above to start one.") },
	}, [...live, ...earlier, ...projects], shown);
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

/** Jira issue types by name, in Jira's own colours; sub-tasks come before tasks. */
const issueTypes: readonly (readonly [RegExp, string, HomeTypeColor])[] = [
	[/bug|defect/i, 'bug', 'red'],
	[/epic/i, 'zap', 'purple'],
	[/sub-?task/i, 'type-hierarchy-sub', 'blue'],
	[/task/i, 'pass-filled', 'blue'],
	[/story|feature|improvement/i, 'bookmark', 'green'],
	[/spike|research/i, 'beaker', 'orange'],
];

/** The mark for a Jira issue type; a type it doesn't know shows as a plain issue. */
function issueType(name: string | undefined): HomeRow['type'] {
	if (!name) {
		return undefined;
	}
	const [, icon, color] = issueTypes.find(([pattern]) => pattern.test(name)) ?? [undefined, 'issues', 'muted'];
	return { name, icon, color };
}

function ticketRow(issue: JiraMyTicket, commentVisibility: string | undefined): HomeRow {
	const type = issueType(issue.type);
	return {
		...type ? { type } : {},
		key: issue.key,
		title: issue.summary,
		pill: { text: issue.status, tone: statusTone(issue) },
		open: { kind: 'link', url: issue.url },
		...issue.statusCategory === 'new' || /reopen/i.test(issue.status) ? { button: { label: vscode.l10n.t("Start"), action: command('gemini.team.startOnTicket', issue.url), title: vscode.l10n.t("Start an agent on {0}", issue.key) } } : {},
		menu: [
			{ label: vscode.l10n.t("Start Agent"), action: command('gemini.team.startOnTicket', issue.url) },
			{ label: vscode.l10n.t("Add Comment..."), action: { kind: 'comment', key: issue.key, url: issue.url, title: issue.summary, ...commentVisibility ? { visibility: commentVisibility } : {} } },
			{ label: vscode.l10n.t("Log Time..."), action: command('gemini.team.logTime', issue.url) },
			{ label: vscode.l10n.t("Move..."), action: command('gemini.team.moveTicket', issue.url) },
			{ label: vscode.l10n.t("Reassign..."), action: command('gemini.team.reassignTicket', issue.url) },
			{ label: vscode.l10n.t("Open in Jira"), action: { kind: 'link', url: issue.url } },
		],
	};
}

/**
 * Every open ticket assigned to the user: the running sprint's first, under
 * the sprint's name with its progress, then the rest under "Not in this sprint".
 */
function ticketsCard(input: DashboardInput, title: string, groups: ReturnType<typeof ticketGroups>, sprint: JiraSprint | undefined, progress: { done: number; total: number } | undefined, now: Date): ListedCard | undefined {
	if (!input.connected.has('jira')) {
		return input.hideUnconnected ? undefined : fixed(notConnected('tickets', title, 'jira', vscode.l10n.t("Your open tickets, this sprint's first, with Start Agent on each.")));
	}
	const fetched = input.data.tickets;
	const { stale, note, asOf } = sourceState(input, 'jira', fetched);
	const sites = fetched?.data?.sites;
	if (sites && sites.length > 1) {
		// One group per site, each with its own sprint; the card shows the first few of each.
		const bySite = sites.map(site => siteTicketRows(input, site, now));
		const all = bySite.flat();
		const each = Math.max(2, Math.ceil(6 / sites.length));
		return listed({
			id: 'tickets', title, tool: 'jira', stale, ...asOf ? { asOf } : {}, query: myTicketsJql,
			...note ? { note } : {},
		}, all, bySite.flatMap(rows => rows.slice(0, each)));
	}
	const inSprint = groups.sprint.map((issue, i): HomeRow => ({
		...ticketRow(issue, input.jiraCommentVisibility),
		...i === 0 ? { group: sprint?.name ?? vscode.l10n.t("This sprint"), ...progress?.total ? { groupQuery: vscode.l10n.t("{0} of {1} done", progress.done, progress.total) } : {} } : {},
	}));
	const other = groups.other.map((issue, i): HomeRow => ({
		...ticketRow(issue, input.jiraCommentVisibility),
		...i === 0 && inSprint.length ? { group: vscode.l10n.t("Not in this sprint") } : {},
	}));
	const all = [...inSprint, ...other];
	return listed({
		id: 'tickets', title, tool: 'jira', stale, ...asOf ? { asOf } : {}, query: myTicketsJql,
		...input.jiraUrl ? { link: { label: vscode.l10n.t("Open in Jira"), action: { kind: 'link', url: `${input.jiraUrl}/issues/?jql=${encodeURIComponent(myTicketsJql)}` } } } : {},
		...note ? { note } : !all.length ? { note: fetched?.loading || !fetched ? vscode.l10n.t("Loading your tickets...") : vscode.l10n.t("No open tickets assigned to you.") } : {},
	}, all, all.slice(0, 6));
}

/** One Jira site's tickets under its name, the running sprint's first; a site that can't be reached says so, and its last tickets show dimmed. */
function siteTicketRows(input: DashboardInput, site: JiraSiteTickets, now: Date): HomeRow[] {
	const groups = ticketGroups(site.issues);
	const progress = sprintProgress(site.issues.filter(i => i.inSprint), site.sprint, now.getTime());
	const time = site.asOf ? new Date(site.asOf).toLocaleTimeString(vscode.env.language, { hour: '2-digit', minute: '2-digit' }) : undefined;
	const query = site.error
		? time ? vscode.l10n.t("Can't reach {0}: tickets from {1}", site.host, time) : vscode.l10n.t("Can't reach {0}", site.host)
		: site.sprint ? progress.total ? vscode.l10n.t("{0} · {1} of {2} done", site.sprint.name, progress.done, progress.total) : site.sprint.name : site.host;
	const heading: Partial<HomeRow> = { group: site.name, groupQuery: query, ...site.error ? { groupTone: 'warn' as const } : {} };
	const rows = [...groups.sprint, ...groups.other].map((issue, i): HomeRow => ({
		...ticketRow(issue, input.jiraCommentVisibility),
		...i === 0 ? heading : {},
		...site.error ? { dim: true } : {},
	}));
	if (rows.length) {
		return rows;
	}
	return [{ ...heading, icon: site.error ? 'warning' : 'check', title: site.error ? site.error : vscode.l10n.t("No open tickets assigned to you.") }];
}

function reviewInProgress(input: DashboardInput, mr: { readonly project: string; readonly iid: number }) {
	return input.reviewsInProgress?.find(r => r.project === mr.project && r.iid === mr.iid);
}

/** Review, or Continue Review when the user's review of it is in progress. */
function reviewButton(input: DashboardInput, mr: { readonly project: string; readonly iid: number }): HomeButton {
	return reviewInProgress(input, mr)
		? { label: vscode.l10n.t("Continue Review"), action: command('gemini.team.reviewMergeRequest', mr.project, mr.iid), primary: true }
		: { label: vscode.l10n.t("Review"), action: command('gemini.team.reviewMergeRequest', mr.project, mr.iid) };
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

function mergeRequestsCard(input: DashboardInput, title: string): ListedCard | undefined {
	if (!input.connected.has('gitlab')) {
		return input.hideUnconnected ? undefined : fixed(notConnected('mergeRequests', title, 'gitlab', vscode.l10n.t("Merge requests waiting for your review or assigned to you, and yours with their pipeline, approvals and whether they can merge.")));
	}
	const reviews = input.data.reviews;
	const mine = input.data.mine;
	const { stale, note, asOf } = sourceState(input, 'gitlab', reviews?.error ? reviews : mine);
	const mineGroup = vscode.l10n.t("Mine");
	const forMe = (reviews?.data ?? []).map((mr): HomeRow => {
		const going = reviewInProgress(input, mr);
		return {
			key: `!${mr.iid}`, repo: mr.project, title: mr.title, detail: mr.author, open: { kind: 'link', url: mr.url },
			...going ? { pill: { text: vscode.l10n.t("Your draft: {0}", going.comments), tone: 'info' as const } } : mr.draft ? { pill: { text: vscode.l10n.t("draft"), tone: 'muted' as const } } : {},
			button: reviewButton(input, mr),
			...going ? {
				menu: [
					...going.agentId ? [{ label: vscode.l10n.t("Open the Agent"), action: { kind: 'agent', id: going.agentId, do: 'open' } } as const] : [],
					{ label: vscode.l10n.t("Start a New Review..."), action: command('gemini.team.startNewReview', mr.project, mr.iid) },
					{ label: vscode.l10n.t("Discard Draft..."), action: command('gemini.team.discardReview', mr.project, mr.iid) },
				],
			} : {},
		};
	});
	const mineRows = (mine?.data ?? []).map((mr, i): HomeRow => ({
			...i === 0 ? { group: mineGroup, groupQuery: 'author_id=me, state=opened' } : {},
			key: `!${mr.iid}`, repo: mr.project, title: mr.title, open: { kind: 'link', url: mr.url },
			...isReadyToMerge(mr) ? { pill: { text: vscode.l10n.t("ready to merge"), tone: 'ok' as const }, button: { label: vscode.l10n.t("Merge..."), action: command('gemini.team.mergeMergeRequest', mr.project, mr.iid), primary: true } }
				: { ...pipelinePill(mr) ? { pill: pipelinePill(mr) } : {}, ...mr.pipeline?.status === 'failed' ? { button: { label: vscode.l10n.t("Fix"), action: command('gemini.team.fixMergeRequest', mr.project, mr.iid) } } : {} },
	}));
	const all = [...forMe, ...mineRows];
	return listed({
		id: 'mergeRequests', title, tool: 'gitlab', stale, ...asOf ? { asOf } : {}, query: 'reviewer_id=me OR assignee_id=me, state=opened',
		...input.gitlabUrl ? { link: { label: vscode.l10n.t("Open in GitLab"), action: { kind: 'link', url: `${input.gitlabUrl}/dashboard/merge_requests?reviewer_username=${encodeURIComponent(input.state('gitlab').account ?? '')}` } } } : {},
		...note ? { note } : !all.length ? { note: !reviews || reviews.loading ? vscode.l10n.t("Loading merge requests...") : vscode.l10n.t("No open merge requests for you or waiting on you.") } : {},
	}, all, [...forMe.slice(0, 4), ...mineRows.slice(0, 4)]);
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
	const asOf = sonarState.asOf ?? snykState.asOf;
	return {
		id: 'quality',
		title: branch ? vscode.l10n.t("Quality on {0}", branch) : title,
		tool: sonar ? 'sonar' : 'snyk',
		query: [sonar ? 'sonar gate' : '', snyk ? 'snyk test' : ''].filter(Boolean).join(' · '),
		rows,
		stale: sonarState.stale || snykState.stale,
		...asOf ? { asOf } : {},
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

