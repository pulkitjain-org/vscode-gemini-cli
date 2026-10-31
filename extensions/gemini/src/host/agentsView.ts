/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DebugEntry } from './debug/debugEntry';
import type { ChangeTotals } from '../acp/agentChanges';
import { agentFolder, AgentRecord, AgentsModel, AgentsSnapshot, isArchived, type StoredAgents } from '../acp/agents';
import { AgentsStore } from '../acp/agentsStore';
import type { Attachment } from '../acp/attachments';
import { startModeList } from '../acp/sessionSettings';
import type { CleanupItem, WorktreeCandidate } from '../acp/storageUsage';
import type { AgentWorktree } from '../acp/worktrees';
import { AgentNotifier } from './agentNotifier';
import { AgentTerminals } from './agentTerminals';
import { AgentService } from './agentService';
import { ChangesSource, ChangesView } from './changesView';
import { TryChoice, TryChoices } from './agents/tryChoices';
import type { AgentStateKind, HomeMode } from './panelProtocol';
import { ReviewController } from './reviewController';
import { CommitSettler } from './commitSettler';
import type { BrowserTools } from './browserTools';
import type { TeamConnections } from './teamConnections';
import type { WorkspaceIndex } from './workspaceIndex';
import { ChatController, ChatEnhancer } from './chatController';
import { configSection, getApprovalPolicy } from './configuration';
import { readCliPreferences } from '../acp/cliPreferences';
import { geminiDir } from '../acp/directRequest';
import { readSettingsFile } from '../acp/projectSettings';
import { isModeAllowed } from '../acp/toolPolicy';
import type { ChatContextCost } from './chat/chatOptions';
import { Projects, projectsEnabled } from './projects';
export { relativeTime } from './displayText';
import { DiffPreview } from './diffPreview';
import { agentColumn } from './editorPlacement';
import type { UsageMeter } from './usageMeter';
import { WorkspaceFileIndex } from './workspaceFiles';
import { AgentIndicators } from './agents/agentIndicators';
import { setProjectStrings } from './chat/chatHtml';
import type { TryAction } from './chatProtocol';
import { registerAgentCommands } from './agents/agentCommands';
import { AgentFeatures } from './agents/agentFeatures';
import { AgentPersistence, storageKey } from './agents/agentPersistence';
import { AgentProjects } from './agents/agentProjects';
import { AgentForks } from './agents/agentForks';
import { AgentRemoval } from './agents/agentRemoval';
import { AgentSideLinks } from './agents/agentSideLinks';
import { AgentStarter, type LiveAgent } from './agents/agentStart';
import { AgentStarts } from './agents/agentStarts';
import { AgentTabs } from './agents/agentTabs';
import { agentState, AgentTree, WorkspaceSummary } from './agents/agentTree';
import { AgentWorktrees } from './agents/agentWorktrees';
import { spareDelayMs, SpareSession } from './agents/spareSession';
import type { FolderTrust } from './folderTrust';
import { background } from './background';
export type { WorkspaceSummary } from './agents/agentTree';

/** The agent list as the window starts with it, and the store it is saved to. */
export interface SavedAgents {
	readonly snapshot: AgentsSnapshot | StoredAgents | undefined;
	/** Undefined when the store could not be read: the list then lives in global state, as before. */
	readonly store: AgentsStore | undefined;
}

/**
 * Reads the agent list from its record store (`agentsStore.ts`), moving the
 * global state snapshot in the first time; falls back to that snapshot when
 * the store can't be read.
 */
export async function loadSavedAgents(context: vscode.ExtensionContext): Promise<SavedAgents> {
	const legacy = context.globalState.get<AgentsSnapshot>(storageKey);
	const store = new AgentsStore(vscode.Uri.joinPath(context.globalStorageUri, 'records').fsPath);
	try {
		return { snapshot: await store.load(legacy), store };
	} catch {
		store.dispose();
		return { snapshot: legacy, store: undefined };
	}
}

/** One agent, as Agent Home and the title bar show it. */
export interface AgentSummary {
	readonly id: string;
	readonly title: string;
	/** The workspace it belongs to. */
	readonly folder: string;
	readonly state: AgentStateKind;
	/** A plain status line, such as "Needs you: Shell npm test". */
	readonly status: string;
	readonly changes?: ChangeTotals;
	readonly worktree?: AgentWorktree;
	readonly updatedAt: number;
	/** Its part in a project, while Projects are on; a coordinator also has its thread count. */
	readonly project?: { readonly role: 'coordinator'; readonly threads: number } | { readonly role: 'thread' };
	/** Archived by the user (Remove's Archive): Home leaves it out, and the pane lists it under Archived. */
	readonly archived?: boolean;
	/** Its work is being tried in the user's checkout. */
	readonly trying?: boolean;
	/** What its Try button does, when not Try in Workspace (`tryChoices.ts`). */
	readonly tryChoice?: 'merge' | 'mr';
}

/**
 * The Agents pane: workspaces, the agents under each, and an editor tab per
 * agent that reuses the chat. Every agent is a session on the one shared agent
 * process, so a new agent is ready in tens of milliseconds once the agent runs.
 * This class owns the agents running in this window (their sessions, chats and
 * tabs) and the Try button; their tabs, starting, stopping and removing them,
 * saving them, their side columns, what loads on demand, the pane's commands,
 * the list, the window's indicators, the spare session, worktrees, Merge
 * Back, Projects and the ways of starting an agent are modules in `./agents/`.
 */
export class AgentsView implements vscode.Disposable {

	private _cliDefaultMode: string | undefined;

	private readonly model: AgentsModel;
	/** The agent list, each agent's conversation and checkpoints, and Clean Up's storage. */
	private readonly persistence: AgentPersistence;
	private readonly live = new Map<string, LiveAgent>();
	private readonly changesView: ChangesView;
	private readonly tryChoices: TryChoices;
	/** Keep and Undo on each agent change, in the files themselves. */
	readonly review: ReviewController;
	/** Takes committed files out of each agent's changes to review. */
	private readonly settler: CommitSettler;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly tree: AgentTree;
	private readonly notifier = new AgentNotifier();
	private readonly indicators: AgentIndicators;
	private readonly spare: SpareSession;
	private readonly worktrees: AgentWorktrees;
	/** Merge Back, Try in Workspace, Plan Review and the Files pages, loaded once first needed. */
	private readonly features: AgentFeatures;
	/** An agent started or ended a turn, for Plan Review. */
	private readonly onDidChangeTurnEmitter = new vscode.EventEmitter<string>();
	/** An agent started or ended a turn: its id. */
	readonly onDidChangeTurn = this.onDidChangeTurnEmitter.event;
	private readonly projectAgents: AgentProjects;
	private readonly starts: AgentStarts;
	private readonly forks: AgentForks;
	/** An agent's session and chat in this window. */
	private readonly starter: AgentStarter;
	/** The shared agent tab, the agents' own tabs, and which agent is in front. */
	private readonly tabs: AgentTabs;
	/** Stop, Remove, Archive and removing a workspace. */
	private readonly removal: AgentRemoval;
	/** The links beside an agent's chat, and its terminals. */
	private readonly sideLinks: AgentSideLinks;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	/** Set while the extension shuts down, when closing agent tabs must not close their files. */
	private disposing = false;

	/** Agents, their states or their workspaces changed. */
	private readonly onDidChangeAgentsEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeAgents = this.onDidChangeAgentsEmitter.event;
	/** The agent whose changes show changed; Agents mode's Changes panel follows it. */
	private readonly onDidFocusEmitter = new vscode.EventEmitter<ChangesSource | undefined>();
	readonly onDidFocus = this.onDidFocusEmitter.event;
	private refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	/** What the pending refresh redraws: the whole tree, or just these agents' rows. */
	private refreshAll = false;
	private readonly refreshRows = new Set<string>();
	/** Each agent's page in the GeminiCode browser; set once the extension has made it. */
	browser: BrowserTools | undefined;
	/** The team's tools (Jira, GitLab, SonarQube, Snyk, Figma), for every agent's session; set by activate. */
	teamTools: TeamConnections | undefined;
	/** The merge request review a reviewer agent works on, for its chat's chip, and opening it; set by activate. */
	reviewChip: ((agentId: string) => { readonly label: string; readonly tip: string } | undefined) | undefined;
	openReview: ((agentId: string) => void) | undefined;
	/** The index of each agent's folder and its attached docs, for every agent's session; set by activate. */
	index: WorkspaceIndex | undefined;
	/** Debug mode's route, in every session while it is turned on; set by activate. */
	debug: DebugEntry | undefined;
	/** Today's quota, for the chats' usage popover. */
	usage: UsageMeter | undefined;
	/** What each folder's model calls carry, for the chats' usage popover (/context); set by activate. */
	contextCost: ChatContextCost | undefined;
	/** One direct request to the quick model, for drafting a project's memory; set once the extension has made it. */
	direct: ((request: { readonly system: string; readonly prompt: string }) => Promise<string | undefined>) | undefined;
	/** Projects: coordinators and their threads. */
	private readonly projects: Projects;

	/** Folder trust for agents. */
	get folderTrust(): FolderTrust {
		return this.service.trust;
	}

	/** Adds `folder` to the folders agents can work in, without adding it to the window. */
	addFolder(folder: string): void {
		this.model.addWorkspace(folder);
	}
	/** Each agent's terminals, and the last command of every terminal. */
	readonly terminals = new AgentTerminals(id => agentColumn(id, this.live.get(id)?.panel));

	constructor(
		context: vscode.ExtensionContext,
		private readonly service: AgentService,
		private readonly diffPreview: DiffPreview,
		private readonly workspaceFiles: WorkspaceFileIndex,
		private readonly enhancer: ChatEnhancer,
		saved: SavedAgents,
	) {
		this.model = new AgentsModel(saved.snapshot);
		setProjectStrings(() => this.features.onDemand().projectStrings());
		this.persistence = new AgentPersistence(context, this.model, saved.store, this.live, {
			log: message => this.service.writeLog(message),
			running: id => this.live.has(id) || !!this.features.loadedMerge?.isMerging(id),
			reviewing: id => !!this.reviewChip?.(id),
			removeAgent: (id, deleteBranch) => this.removal.removeAgentAndWorktree(id, deleteBranch),
		});
		this.tree = new AgentTree(this.model, this.live);
		this.changesView = new ChangesView(id => this.live.get(id)?.changes);
		this.worktrees = new AgentWorktrees(this.model, context.globalState);
		this.tryChoices = new TryChoices(context.globalState);
		this.projects = new Projects({
			record: id => this.model.agent(id),
			workspaceFolder: id => {
				const record = this.model.agent(id);
				return record && this.model.workspace(record.workspaceId)?.folder;
			},
			threadsOf: id => this.model.threadsOf(id),
			controller: id => this.tabs.ensureLive(id)?.controller,
			activity: id => this.live.get(id)?.activity,
			startThread: (id, request, setup) => this.projectAgents.startThread(id, request, setup),
			addRepo: (thread, repo, memory) => this.projectAgents.addThreadRepo(thread, repo, memory),
			open: id => this.open(id),
			stopTurn: id => this.stopTurn(id),
			mergeBack: (id, repo) => this.mergeBack(id, repo),
			tryAction: (id, action) => this.tryAction(id, action),
			mergeCommits: id => this.tryChoiceOf(id) === 'merge',
			tryChoice: id => this.tryChoiceOf(id),
			chooseTry: (id, choice) => this.chooseTry(id, choice).then(() => undefined),
			mergeRequests: () => this.mergeRequests(),
			guideSeen: () => !!context.globalState.get<boolean>('gemini.tries.guideSeen'),
			setGuideSeen: async seen => { await context.globalState.update('gemini.tries.guideSeen', seen || undefined); },
			triedEdits: id => this.features.triedEdits.get(id),
			openTerminal: id => this.sideLinks.openTerminal(id),
			changedFiles: id => this.live.get(id)?.changes.files,
			rename: (id, title) => this.tabs.renameAgent(id, title),
			outline: folder => this.index?.outlineOf(folder) ?? Promise.resolve(undefined),
			trustThreads: async id => {
				const record = this.model.agent(id);
				const folder = record && this.model.workspace(record.workspaceId)?.folder;
				return !!folder && this.projectAgents.ensureProjectTrust(folder, true);
			},
			reloadProjectTools: id => this.projectAgents.reloadProjectTools(id),
			log: message => this.service.writeLog(message),
			sessionServers: id => this.live.get(id)?.session.client.openedMcpServers,
			reopenSession: async id => this.live.get(id)?.session.client.reopen(),
			mcpProblem: name => this.service.mcpProblems.find(problem => problem.server === name && problem.severity === 'error')?.message,
			direct: request => this.direct?.(request) ?? Promise.resolve(undefined),
			openChanges: id => this.openChanges(id),
			undoThread: id => this.projectAgents.undoThread(id),
			resume: id => this.projectAgents.resumeThread(id),
			prepare: id => this.projectAgents.prepareThread(id),
			restoreFolder: id => this.worktrees.restoreFolder(id),
			savedConversation: async id => this.live.get(id)?.controller.conversation ?? (await this.persistence.transcripts.load(id)).items,
			cleanUpMerged: id => this.projectAgents.cleanUpMerged(id),
			settingUp: id => this.projectAgents.isSettingUp(id),
			setResolved: (id, resolved) => this.model.setThreadResolved(id, resolved),
			setPendingNotes: (id, notes) => {
				const role = this.model.agent(id)?.project;
				this.model.setThreadPending(id, { ...role?.role === 'thread' ? role.pending : {}, notes });
			},
			// The usage meter is set by activate, after this; read when a project asks.
			quota: () => {
				const reading = this.usage?.reading;
				return reading?.kind === 'ok' ? reading.quota : undefined;
			},
			onDidChangeQuota: listener => this.usage?.onDidChange(listener) ?? { dispose: () => undefined },
			refreshQuota: () => void this.usage?.refresh(),
		}, String(context.extension.packageJSON.version ?? '0'));
		// What the modules that start, stop and remove agents may ask of this view.
		const host = {
			start: (record: AgentRecord, folder: string) => this.starter.start(record, folder),
			stop: (id: string, save: boolean) => this.removal.stop(id, save),
			open: (id: string) => this.open(id),
			ensureLive: (id: string) => void this.tabs.ensureLive(id),
			refresh: (id?: string) => this.refresh(id),
			pickModel: (id: string, model: string) => this.starter.pickModel(id, model),
			removeAgent: (id: string, deleteBranch: boolean) => this.removal.removeAgentAndWorktree(id, deleteBranch),
			trust: this.service.trust,
		};
		this.projectAgents = new AgentProjects(this.model, this.service, this.projects, this.worktrees, { isMerging: id => this.features.loadedMerge?.isMerging(id) ?? false }, this.live, this.tree, { ...host, keptClean: record => this.features.tries.keptClean(record) });
		this.starts = new AgentStarts(this.model, this.worktrees, this.tree, this.live, { ...host, startModes: () => this.startModes() });
		this.forks = new AgentForks(this.model, this.service, this.worktrees, this.live, {
			start: (record, folder) => this.starter.start(record, folder),
			open: id => this.open(id),
			ensureLive: id => this.tabs.ensureLive(id),
			pickModel: (id, model) => this.starter.pickModel(id, model),
			archive: id => this.removal.archiveAgent(id),
			// A forked thread's card merges it as a thread, so it is resolved once merged.
			tryChoice: id => this.model.agent(id)?.project?.role === 'thread' ? 'merge' : this.tryChoiceOf(id),
			mergeBack: async id => {
				if (this.model.agent(id)?.project?.role !== 'thread') {
					return this.mergeBack(id);
				}
				await this.projects.mergeThread(id);
				return true;
			},
			linkThreadRules: (repository, folder) => this.projectAgents.linkRules(repository, folder, 'thread'),
			threadForked: (fork, parent, context) => this.projects.threadForked(fork, parent, context),
		});
		this.spare = new SpareSession(this.service, {
			servers: folder => [...this.browser?.spareServers() ?? [], ...this.teamTools?.spareServers() ?? [], ...this.index?.spareServers(folder) ?? [], ...this.debug?.servers() ?? []],
			serving: () => [!!this.browser?.serving, !!this.teamTools?.serving, !!this.index?.serving],
		});
		this.review = new ReviewController(() => [...this.live.entries()].map(([id, live]) => ({ id, title: vscode.l10n.t("the agent \"{0}\"", this.model.agent(id)?.title ?? ''), changes: live.changes })));
		this.settler = new CommitSettler(() => [...this.live.values()].map(live => live.changes), message => this.service.writeLog(message));
		this.indicators = new AgentIndicators(context.extensionUri, this.model, this.live, this.tree.view, this.notifier);
		this.features = new AgentFeatures({
			context, model: this.model, live: this.live, projects: this.projects, diffPreview: this.diffPreview, view: this,
			disposables: this.disposables, onDidChangeTurnEmitter: this.onDidChangeTurnEmitter,
			tabs: { ensureLive: id => this.tabs.ensureLive(id) },
			removeAgent: (id, deleteBranch) => this.removal.removeAgentAndWorktree(id, deleteBranch),
			refresh: id => this.refresh(id),
			log: message => this.service.writeLog(message),
			// The Changes panel's buttons follow the agent's try.
			tryChanged: id => {
				if (this.tabs.focusedId === id) {
					this.onDidFocusEmitter.fire(this.focusedSource);
				}
			},
		});
		this.sideLinks = new AgentSideLinks({ model: this.model, live: this.live, terminals: this.terminals, view: this, features: this.features });
		this.starter = new AgentStarter({
			extensionUri: context.extensionUri, planReviewFolder: vscode.Uri.joinPath(context.globalStorageUri, 'planReviews').fsPath,
			model: this.model, service: this.service, live: this.live, projects: this.projects, spare: this.spare, forks: this.forks,
			settler: this.settler, notifier: this.notifier, workspaceFiles: this.workspaceFiles, diffPreview: this.diffPreview, enhancer: this.enhancer,
			view: this, features: this.features, sideLinks: this.sideLinks, persistence: this.persistence,
			tabs: { reveal: (id, preserveFocus) => this.tabs.reveal(id, preserveFocus) },
			refresh: id => this.refresh(id),
			turnChanged: id => this.onDidChangeTurnEmitter.fire(id),
		});
		this.tabs = new AgentTabs({
			extensionUri: context.extensionUri, model: this.model, live: this.live, tree: this.tree, worktrees: this.worktrees,
			projects: this.projects, projectAgents: this.projectAgents, starter: this.starter, transcripts: this.persistence.transcripts,
			checkpointFiles: this.persistence.checkpointFiles, notifier: this.notifier, indicators: this.indicators, changesView: this.changesView, view: this,
			focusChanged: source => this.onDidFocusEmitter.fire(source),
			refresh: id => this.refresh(id),
			disposing: () => this.disposing,
			// Its conversation is saved and its record keeps its session id: opening it again restores it.
			release: id => this.removal.stop(id, true),
		});
		this.removal = new AgentRemoval({
			model: this.model, live: this.live, tree: this.tree, projects: this.projects, notifier: this.notifier,
			transcripts: this.persistence.transcripts, checkpointFiles: this.persistence.checkpointFiles, terminals: this.terminals,
			review: this.review, settler: this.settler, view: this, features: this.features, tabs: this.tabs,
		});
		// A try left open last time: its status bar item and file badges come back, after the window's own start.
		if (this.model.agents.some(record => record.tried?.state === 'trying')) {
			const timer = setTimeout(() => void this.features.tries, 2000);
			this.disposables.push(new vscode.Disposable(() => clearTimeout(timer)));
		}
		const store = this.persistence.store;
		this.disposables.push(
			this.tree,
			this.tabs,
			this.notifier,
			this.terminals,
			this.changesView,
			this.review,
			this.settler,
			this.worktrees,
			this.onDidChangeAgentsEmitter,
			this.onDidFocusEmitter,
			this.model.onDidChange(() => {
				this.persistence.persistSoon();
				this.refresh();
			}),
			// Agents another window added, changed or removed.
			...(store ? [store, store.watch(this.model, removed => removed.forEach(agent => this.removal.stop(agent.id, false)))] : []),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
			vscode.workspace.onDidChangeConfiguration(e => (e.affectsConfiguration(`${configSection}.notifications`) || e.affectsConfiguration(`${configSection}.projects.enabled`)) && this.refresh()),
			// Relative times go stale; refresh them only while the pane is visible.
			this.tree.view.onDidChangeVisibility(e => this.setRefreshing(e.visible)),
			// A thread picked with the keyboard is likely opened next: its session starts now, so the chat is ready by then.
			this.tree.view.onDidChangeSelection(e => {
				const node = e.selection[0];
				if (node?.kind === 'agent' && node.record.project?.role === 'thread') {
					this.projectAgents.prepareThread(node.record.id);
				}
			}),
			...registerAgentCommands({
				view: this, starts: this.starts, tree: this.tree, changesView: this.changesView, projectAgents: this.projectAgents, projects: this.projects,
				features: this.features, tabs: this.tabs, sideLinks: this.sideLinks, removal: this.removal,
			}),
			// The CLI's default mode can change in Agent Setup or a terminal; read again whenever the agent starts, which a settings change restarts.
			service.onDidStart(() => void this.refreshCliDefaultMode()),
			this.projects,
		);
		this.setRefreshing(this.tree.view.visible);
		// A spare session for the first agent, opened once the agent process is up (the warm-up starts it).
		const folder = this.likelyFolder();
		if (folder) {
			this.prepareStart(folder, spareDelayMs);
		}
		// Merged threads keep their chats, not their checkpoints; dropped once the window has settled.
		const settle = setTimeout(() => background('Dropping merged threads\' checkpoints', this.persistence.dropMergedCheckpoints()), 30_000);
		this.disposables.push({ dispose: () => clearTimeout(settle) });
	}

	/** Opens agent `id`'s conversation as Markdown; one not running in this window is read from its saved file. */
	openAsMarkdown(id: string): Promise<void> {
		return this.tabs.openAsMarkdown(id);
	}

	/** An agent's name, for questions about it. */
	agentTitle(id: string): string | undefined {
		return this.model.agent(id)?.title;
	}

	/** The last checks run for agent `id`, in a line; saved with the agent, so they outlast a restart. */
	checkResult(id: string): string | undefined {
		return this.model.agent(id)?.checks?.summary;
	}

	setCheckResult(id: string, summary: string): void {
		this.model.setChecks(id, summary);
	}

	/** The agent whose tab is in front, if any. */
	activeAgentId(): string | undefined {
		return this.tabs.activeAgentId();
	}

	/** Move to its own branch, from an agent's row or the tab in front (`agents/agentForks.ts`). */
	moveToBranch(id: string | undefined): Promise<void> {
		return this.forks.moveToBranch(id);
	}

	/** The agent whose tab is in front, else the one last in front while it is still in the list. */
	agentLastInFront(): string | undefined {
		return this.tabs.agentLastInFront();
	}

	/** Shows each running chat's branch and chips again, as after a review changed. */
	refreshChats(): void {
		for (const agent of this.live.values()) {
			agent.controller.refreshGit();
		}
	}

	/** Agent `id`'s chat, when the agent runs in this window. */
	controllerOf(id: string): ChatController | undefined {
		return this.live.get(id)?.controller;
	}

	/**
	 * The chat that Add to Chat and the chat commands act on: the agent tab in
	 * front, else the running agent used last (shown), else, with `orNew`, a
	 * new agent the user starts. Undefined when there is none.
	 */
	async chatFor(orNew: boolean): Promise<ChatController | undefined> {
		const front = this.activeController();
		if (front) {
			return front;
		}
		const running = this.summaries().find(agent => agent.state !== 'stopped' && agent.project?.role !== 'coordinator');
		if (running) {
			await this.open(running.id);
			return this.controllerOf(running.id);
		}
		if (!orNew) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Open an agent first."));
			return undefined;
		}
		const started = await this.starts.newAgent(undefined);
		return started ? this.controllerOf(started) : undefined;
	}

	/** The chat in the agent tab that is in front, if any. */
	activeController(): ChatController | undefined {
		return this.tabs.activeController();
	}

	/** Every agent, newest first. */
	summaries(): AgentSummary[] {
		const summaries: AgentSummary[] = [];
		const projects = projectsEnabled();
		for (const workspace of this.model.workspaces) {
			for (const record of this.model.agentsIn(workspace.id)) {
				const live = this.live.get(record.id);
				const state = agentState(record, live);
				const changes = live?.changes.totals ?? record.changes;
				summaries.push({
					id: record.id, title: record.title, folder: workspace.folder, state: state.kind, status: state.status,
					...(changes?.files ? { changes } : {}), ...(record.worktree ? { worktree: record.worktree } : {}), updatedAt: record.updatedAt,
					...(record.archivedAt !== undefined && !live && isArchived(record, Date.now()) ? { archived: true } : {}),
					...(record.tried?.state === 'trying' ? { trying: true } : {}),
					...(record.worktree && this.tryChoiceOf(record.id) !== 'try' ? { tryChoice: this.tryChoiceOf(record.id) as 'merge' | 'mr' } : {}),
					...(projects && record.project?.role === 'coordinator' ? { project: { role: 'coordinator', threads: this.model.threadsOf(record.id).length } } : {}),
					...(projects && record.project?.role === 'thread' && this.model.coordinatorOf(record) ? { project: { role: 'thread' } } : {}),
				});
			}
		}
		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** The workspaces a new agent can start in: the open folders first. */
	workspaces(): Promise<WorkspaceSummary[]> {
		return this.tree.workspaces();
	}

	/** Keeps a spare session open in `folder` for the next agent started there, such as while the user types a task on Agent Home. */
	prepareStart(folder: string, delayMs = 0): void {
		this.spare.prepare(folder, delayMs);
	}

	/** Opens the spare session again when the servers a new session would get change. */
	refreshSpare(): void {
		this.spare.refresh();
	}

	/** Starts an agent in `folder` (on its own branch, named after the prompt, with `ownBranch`) and sends it `text`. */
	/** Returns whether the agent started; when not, the user has been told why. */
	startWithPrompt(folder: string, text: string, ownBranch: boolean, mode: string, attachments: readonly Attachment[]): Promise<boolean> {
		return this.starts.startWithPrompt(folder, text, ownBranch, mode, attachments);
	}

	/** Starts an agent for the team flows, named `title`; resolves with its id, or undefined when its branch could not be made. */
	startTeamAgent(options: { readonly folder: string; readonly title: string; readonly text: string; readonly branch?: string; readonly worktree?: AgentWorktree; readonly mode?: string }): Promise<string | undefined> {
		return this.starts.startTeamAgent(options);
	}

	/** Every agent's id, and the threads merged back, for Settings' Clean Up. */
	storageAgents(): { readonly all: ReadonlySet<string>; readonly merged: ReadonlySet<string> } {
		return this.persistence.storageAgents();
	}

	/** The worktrees Settings' Clean Up may offer: merged threads', ended reviews' and removed agents', none in use here. */
	storageWorktrees(): Promise<WorktreeCandidate[]> {
		return this.persistence.storageWorktrees();
	}

	/**
	 * Removes a worktree Clean Up listed, keeping its branch: an ended
	 * review's goes with its reviewer agent (Remove Reviewer and Checkout);
	 * a merged thread's comes back from its branch when the thread is opened.
	 */
	removeStorageWorktree(repository: string, worktree: AgentWorktree, item: CleanupItem): Promise<void> {
		return this.persistence.removeStorageWorktree(repository, worktree, item);
	}

	/** Removes an agent a team flow started, with its worktree folder and, with `deleteBranch`, its branch: Remove Reviewer and Checkout. */
	removeTeamAgent(id: string, deleteBranch: boolean): Promise<void> {
		return this.removal.removeAgentAndWorktree(id, deleteBranch);
	}

	/** Where an agent works (its worktree's folder, or its workspace), and its own branch when it has one. */
	agentPlace(id: string): { readonly folder: string; readonly cwd: string; readonly branch?: string; readonly title: string } | undefined {
		const record = this.model.agent(id);
		const workspace = record && this.model.workspace(record.workspaceId);
		return record && workspace ? { folder: workspace.folder, cwd: agentFolder(record, workspace.folder), title: record.title, ...(record.worktree ? { branch: record.worktree.branch } : {}) } : undefined;
	}

	/** The browser's New Agent: asks where and how the agent works, then starts it with its tab open. */
	newAgentFor(page: string): Promise<{ readonly id: string; readonly title: string; readonly task?: string } | undefined> {
		return this.starts.newAgentFor(page);
	}

	/** "Review my changes": starts an agent in Plan mode with the repository's uncommitted diff attached. */
	reviewChanges(source?: { readonly rootUri?: vscode.Uri }): Promise<void> {
		return this.starts.reviewChanges(source);
	}

	/**
	 * The Try button, wherever it is: what was last chosen for the repository
	 * (Try in Workspace, Merge Back or Open Merge Request; `tryChoices.ts`),
	 * or Keep Changes and the rest once tried. Returns whether all of the
	 * agent's work is now merged, for a merge.
	 */
	mergeBack(id: string, repo?: string): Promise<boolean> {
		const choice = this.tryChoiceOf(id);
		if (choice === 'merge') {
			return this.features.merge.mergeBack(id, repo);
		}
		if (choice === 'mr') {
			return Promise.resolve(vscode.commands.executeCommand('gemini.team.openMergeRequest', id)).then(() => false);
		}
		// One button, wherever it is: once tried, it offers Keep Changes, Take Back and the rest.
		if (this.model.agent(id)?.tried?.state === 'trying') {
			return this.features.tries.showMenu(id).then(() => true);
		}
		return this.tryAction(id, 'try');
	}

	/**
	 * Review, from Home and the palette: what to review. My Changes starts a
	 * reviewer on the uncommitted diff; an agent's changes open its diff; a
	 * merge request starts a reviewer in a checkout of its own (GitLab); Run
	 * Checks on a Branch runs the team's checks (Snyk or SonarQube).
	 */
	async pickReview(): Promise<void> {
		const withChanges = this.summaries().filter(agent => agent.changes?.files && !agent.archived);
		const connected = this.teamTools?.connected;
		const items: (vscode.QuickPickItem & { run(): Thenable<unknown> | void })[] = [
			{ label: `$(diff) ${vscode.l10n.t("My Changes")}`, detail: vscode.l10n.t("An agent in Plan mode reads your uncommitted changes and reports what it finds, without editing"), run: () => this.starts.reviewChanges() },
			...withChanges.length ? [{
				label: `$(git-branch) ${vscode.l10n.t("An Agent's Changes...")}`, detail: withChanges.length === 1 ? vscode.l10n.t("The changes of {0}, as a diff", withChanges[0].title) : vscode.l10n.t("The changes of one of {0} agents, as a diff", withChanges.length),
				run: async () => {
					const agent = withChanges.length === 1 ? withChanges[0] : (await vscode.window.showQuickPick(withChanges.map(each => ({ label: each.title, description: each.status, each })), { title: vscode.l10n.t("Whose changes") }))?.each;
					if (agent) {
						await this.openChanges(agent.id);
					}
				},
			}] : [],
			...connected?.has('gitlab') ? [{ label: `$(git-pull-request) ${vscode.l10n.t("A Merge Request...")}`, detail: vscode.l10n.t("A reviewer agent in a checkout of its own reads it against its ticket and drafts comments for you to post"), run: () => vscode.commands.executeCommand('gemini.team.reviewMergeRequest') }] : [],
			...connected?.has('snyk') || connected?.has('sonar') ? [{ label: `$(checklist) ${vscode.l10n.t("Run Checks on a Branch...")}`, detail: vscode.l10n.t("The team's checks on any branch, with Gemini fixing what fails"), run: () => vscode.commands.executeCommand('gemini.team.runChecksOnBranch') }] : [],
		];
		const picked = await vscode.window.showQuickPick(items, { title: vscode.l10n.t("Review"), placeHolder: vscode.l10n.t("What to review") });
		await picked?.run();
	}

	/** The choice the Try button runs for the agent's repository. Open Merge Request needs GitLab. */
	tryChoiceOf(id: string): TryChoice {
		const choice = this.tryChoices.get(this.tryKey(id));
		return choice === 'mr' && !this.mergeRequests() ? 'try' : choice;
	}

	/** Whether GitLab is connected, so the Try chevron's menu (webview-src/tryChoiceMenu.ts) offers Open Merge Request. */
	mergeRequests(): boolean {
		return !!this.teamTools?.connectors.gitlab;
	}

	/** A pick from the Try chevron's menu: remembered for the repository, then run. Open Merge Request needs GitLab. */
	async chooseTry(id: string, choice: TryChoice): Promise<boolean> {
		if (choice === 'mr' && !this.mergeRequests()) {
			return false;
		}
		await this.tryChoices.set(this.tryKey(id), choice);
		this.refreshTryLabels(id);
		return this.mergeBack(id);
	}

	/** The repository a choice is remembered for: the agent's workspace folder. */
	private tryKey(id: string): string {
		const record = this.model.agent(id);
		return (record && this.model.workspace(record.workspaceId)?.folder) ?? '';
	}

	/** The label of every Try button in the repository follows the new choice. */
	private refreshTryLabels(id: string): void {
		const key = this.tryKey(id);
		for (const record of this.model.agents) {
			if (this.tryKey(record.id) === key) {
				this.projects.refreshThread(record.id);
			}
		}
		const active = this.activeAgentId();
		if (active) {
			this.changesView.show(this.tabs.changesSource(active));
		}
		this.onDidChangeAgentsEmitter.fire();
	}

	/** Whether an agent's work is being tried in the user's checkout now. */
	isTrying(id: string): boolean {
		return this.model.agent(id)?.tried?.state === 'trying';
	}

	/** Try in Workspace and the rest (agentTries.ts); returns whether it did. */
	tryAction(id: string, action: TryAction): Promise<boolean> {
		const tries = this.features.tries;
		switch (action) {
			case 'try': return tries.tryIn(id);
			case 'keep': return tries.keep(id);
			case 'takeBack': return tries.takeBack(id);
			case 'send': return tries.sendEdits(id);
			case 'resolve': return tries.openConflict(id).then(() => true);
			case 'discard': return tries.discard(id);
			case 'restore': return tries.restore(id);
		}
	}

	/** Stops the agent's current turn, as its Stop button does, even while its session still opens. */
	stopTurn(id: string): void {
		this.live.get(id)?.controller.stop();
	}

	/**
	 * Every tool call, edit and status change asks for a refresh; doing them
	 * together once per frame keeps a busy turn from redrawing the tree,
	 * Home, the title bar and the tabs dozens of times.
	 */
	private refresh(agentId?: string): void {
		if (agentId === undefined) {
			this.refreshAll = true;
		} else {
			this.refreshRows.add(agentId);
		}
		this.refreshTimeout ??= setTimeout(() => {
			this.refreshTimeout = undefined;
			this.refreshNow();
		}, 16);
	}

	private refreshNow(): void {
		const rows = this.refreshAll ? undefined : [...this.refreshRows];
		this.refreshAll = false;
		this.refreshRows.clear();
		this.tree.redraw(rows);
		this.tree.updateClock();
		this.indicators.updateBadge();
		this.indicators.updateTitleBar(this.summaries());
		this.indicators.updateTabs();
		this.onDidChangeAgentsEmitter.fire();
	}

	private setRefreshing(visible: boolean): void {
		if (visible && !this.refreshTimer) {
			this.refreshTimer = setInterval(() => this.refresh(), 60_000);
		} else if (!visible && this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.tree.updateClock();
	}

	/** Where the next agent most likely starts: where the last one did, else the first open folder. */
	private likelyFolder(): string | undefined {
		const last = [...this.model.snapshot().agents].filter(a => !a.worktree).sort((a, b) => b.createdAt - a.createdAt)[0];
		const folder = last && this.model.workspace(last.workspaceId)?.folder;
		return folder ?? vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
	}

	/** Shows the agent in its own tab, else the shared one, starting its session if it has none in this window. */
	open(id: string): Promise<void> {
		return this.tabs.open(id);
	}

	/** Opens the agent's changes in the multi-diff editor, starting it to read them if needed. */
	openChanges(id: string): Promise<void> {
		return this.tabs.openChanges(id);
	}

	/** The agent whose changes show: the one whose tab was last in front. */
	get focusedSource(): ChangesSource | undefined {
		return this.tabs.focusedSource;
	}

	/**
	 * The modes a new agent may start in, in the CLI's words: what a running
	 * session offers, else the window's own agent's, else the CLI's list; less
	 * what policy turns off.
	 */
	startModes(): HomeMode[] {
		const offered = [...this.live.values()].map(live => live.session.client.settings.mode?.available).find(modes => modes?.length) ?? this.service.client.settings.mode?.available;
		return startModeList(offered, modeId => isModeAllowed(getApprovalPolicy(), modeId)).map(mode => ({ id: mode.id, name: mode.name, description: mode.description ?? '' }));
	}

	/** The CLI's own Default Approval Mode (`general.defaultApprovalMode`), read from its settings when the agent starts; what a new agent starts in unless `gemini.agents.defaultMode` is set. */
	get cliDefaultMode(): string | undefined {
		if (this._cliDefaultMode === undefined) {
			// Not read yet: the first asker gets the CLI's own default, the next ones what the file says.
			void this.refreshCliDefaultMode();
		}
		return this._cliDefaultMode;
	}

	private async refreshCliDefaultMode(): Promise<void> {
		const settings = await readSettingsFile(path.join(geminiDir(), 'settings.json')).catch(() => ({}));
		this._cliDefaultMode = readCliPreferences(settings).defaultApprovalMode;
	}

	/**
	 * Saves every open agent's conversation and the agent list, and resolves
	 * once they are written; for deactivate, so a reply that ended just before
	 * a reload or quit is kept.
	 */
	saveAll(): Promise<void> {
		return this.persistence.saveAll();
	}

	dispose(): void {
		this.disposing = true;
		for (const id of [...this.live.keys()]) {
			this.removal.stop(id, true);
		}
		this.setRefreshing(false);
		this.spare.dispose();
		clearTimeout(this.refreshTimeout);
		this.persistence.dispose();
		this.model.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
