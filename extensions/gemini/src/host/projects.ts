/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Projects (`gemini.projects.enabled`, on by default): a coordinator agent whose
// chat is the project chat, and threads that do the work, each an agent on a
// new branch in its own worktree. The extension host plays the platform: the
// coordinator's chat sends what the user writes to a ProjectHub, which wakes
// the coordinator (on a named Flash model) with the threads' state, and the
// `geminicode-project` MCP server gives it start_thread, message_thread and
// post, and each thread a report tool. Threads show as cards in the project
// chat that update in place. Approvals stay in the thread that asked.
// Nothing here runs until a project's coordinator starts.

import type * as acp from '@agentclientprotocol/sdk';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { branchDefaults, defaultBranchPrefix } from './branchDefaults';
import type { EditedFile } from '../acp/agentChanges';
import { isArchived, warmThreads, type AgentProjectRole, type AgentRecord } from '../acp/agents';
import type { ForkContext, ThreadCard, TranscriptItem, TriedCard } from '../acp/chatTranscript';
import { attachmentLabel, type Attachment } from '../acp/attachments';
import { ConductorReader } from '../acp/conductor';
import type { InstantAnswer } from '../acp/permissions';
import { ProjectHub, panelState, quotaHold, requestCount, runningThreads, threadCounts, threadMemoryContext, threadMessages, type ThreadRequest } from '../acp/projectHub';
import { coordinatorTools, isProjectToolCall, isProjectToolTitle, ProjectMcpServer, projectServerName, threadTools, toolCallOwner, type ProjectCaller } from '../acp/projectMcp';
import { projectToolsBlock, type ProjectToolsBlock } from '../acp/projectToolsCheck';
import { reactionReport, type ReactionRef } from '../acp/reactions';
import type { McpToolResult } from '../acp/browserMcp';
import { errorMessage } from '../acp/errors';
import { cleanDraft, draftRequest, repoFacts } from '../acp/projectDraft';
import { ruleEntries, ruleFolders } from '../acp/projectRules';
import { addMemoryFiles, configFile, maxInstructionsChars, memoryFolder, newMemoryFile, projectMemory, readProjectConfig, removeMemoryFile, repoKey, writeProjectConfig, type ProjectConfig, type ProjectDefaults, type ProjectRepo } from '../acp/projectStore';
import { coordinatorHome, repositoryRoot } from '../acp/worktrees';
import type { ChatActivity, ChatController, ChatProject } from './chatController';
import type { NewThread, ProjectDefaultsView, ProjectSettingsAction, ProjectSettingsSave, ProjectSettingsView, ThreadAction, TryAction } from './chatProtocol';
import { isTryChoice, type TryChoice } from './agents/tryChoices';
import { configSection } from './configuration';
import { tildify } from './displayText';
import { showError } from './errorNotice';

/** How much of each repository's outline a coordinator's wake carries. */
const outlineChars = 2_500;

/** What a new thread gets from its project besides its request. */
export interface ThreadSetup {
	/** The repositories it works in, when the project has several. */
	readonly repos?: readonly ProjectRepo[];
	/** The project's memory for threads, if any. */
	readonly memory?: string;
	/** Put before a branch name made from the title; unset for "gemini/". */
	readonly branchPrefix?: string;
}

/** What Projects needs from the Agents pane. */
export interface ProjectAgents {
	record(id: string): AgentRecord | undefined;
	/** The folder of the agent's workspace: the project's repository. */
	workspaceFolder(id: string): string | undefined;
	threadsOf(coordinatorId: string): readonly AgentRecord[];
	/** The agent's chat, starting its session (without a tab) if it has none. */
	controller(id: string): ChatController | undefined;
	activity(id: string): ChatActivity | undefined;
	startThread(coordinatorId: string, request: ThreadRequest, setup: ThreadSetup): Promise<string>;
	/** Adds a repository to a thread in several; resolves with what to tell the thread. */
	addRepo(thread: string, repo: ProjectRepo, memory: string | undefined): Promise<string>;
	open(id: string): Promise<void>;
	stopTurn(id: string): void;
	/** Merges a thread back (for one in several repositories, `repo`'s worktree); returns whether all of its work is now merged. */
	mergeBack(id: string, repo?: string): Promise<boolean>;
	/** The files a running agent changed. */
	changedFiles(id: string): readonly EditedFile[] | undefined;
	rename(id: string, title: string): void;
	/** The workspace index's outline of `folder`, when it is built. */
	outline?(folder: string): Promise<string | undefined>;
	/** Asks the Gemini CLI to trust the folder multi-repository threads work in; false when the user declines. */
	trustThreads(coordinatorId: string): Promise<boolean>;
	/**
	 * Gets a coordinator whose session opened without the project's tools a
	 * session with them: asks to trust the project's folders when they aren't,
	 * else restarts the agent once no agent is working, since the CLI reads
	 * trust only as it starts. False when the user declines.
	 */
	reloadProjectTools(coordinatorId: string): Promise<boolean>;
	/** Writes to the Gemini log. */
	log(message: string): void;
	/** What the Gemini CLI's log says went wrong with the MCP server `name` in the running agent, if anything. */
	mcpProblem(name: string): string | undefined;
	/** The names of the MCP servers a live agent's session opened with; undefined when it has none open. */
	sessionServers(id: string): readonly string[] | undefined;
	/** Opens a live agent's session again with the servers as they are now. */
	reopenSession(id: string): Promise<void>;
	/** One direct request to the quick model; undefined when there is no way to make one. */
	direct(request: { readonly system: string; readonly prompt: string }): Promise<string | undefined>;
	openChanges(id: string): Promise<void>;
	/** Asks, then removes the thread with its folder and branch; returns whether it did. */
	undoThread(id: string): Promise<boolean>;
	/** Tries a thread's work in the user's checkout, keeps it, takes it back... (agentTries.ts, loaded on first use); returns whether it did. */
	tryAction(id: string, action: TryAction): Promise<boolean>;
	/** Whether the thread's Try button merges with a commit (the choice remembered for its repository, `tryChoices.ts`). */
	mergeCommits(id: string): boolean;
	/** The thread's Try button's choice. */
	tryChoice(id: string): 'try' | 'merge' | 'mr';
	/** A pick from the menu of the chevron beside the Try button: remember the choice, then run it. */
	chooseTry(id: string, choice: TryChoice): Promise<void>;
	/** Whether GitLab is connected, so the chevron's menu offers Open Merge Request. */
	mergeRequests(): boolean;
	/** Whether the person has read the first-try guide; setting it shows or hides it on cards. */
	guideSeen(): boolean;
	setGuideSeen(seen: boolean): Promise<void>;
	/** The tried files the user edited and hasn't sent, as last told. */
	triedEdits(id: string): readonly string[] | undefined;
	openTerminal(id: string): void;
	/** Starts a thread's agent without a tab, when it isn't running and its folder still exists. */
	resume(id: string): Promise<void>;
	/** The user is about to open the thread: start it now if it isn't running. */
	prepare(id: string): void;
	/** Puts back a merged thread's folder that Clean Up removed; resolves whether it has a folder. */
	restoreFolder(id: string): Promise<boolean>;
	/** The thread's chat: live, else as saved, without starting its agent. */
	savedConversation(id: string): Promise<readonly TranscriptItem[]>;
	/** Project Settings' Clean Up: asks, then removes merged threads' folders that hold nothing unmerged. */
	cleanUpMerged(coordinatorId: string): Promise<void>;
	/** Whether a new thread's worktree setup still runs: it gets its brief, and then any notes, when setup ends. */
	settingUp(id: string): boolean;
	/** Keeps a thread's resolved state across reloads. */
	setResolved(id: string, resolved: boolean): void;
	/** Keeps the notes held for a thread on its record, so a closed window doesn't drop them. */
	setPendingNotes(id: string, notes: readonly string[]): void;
	/** Today's quota as the usage meter last read it, most used model first; undefined with none to read. */
	quota(): readonly { readonly model: string; readonly used: number; readonly resetTime?: string }[] | undefined;
	/** Fires when the usage meter reads a different quota. */
	onDidChangeQuota(listener: () => void): vscode.Disposable;
	/** Reads the quota again now, as at its reset. */
	refreshQuota(): void;
}

export function projectsEnabled(): boolean {
	return vscode.workspace.getConfiguration(configSection).get<boolean>('projects.enabled', true);
}

/** `gemini.projects.maxRunningThreads`: how many of a project's threads may run at once, at least 1. */
function maxRunningThreads(): number {
	const value = vscode.workspace.getConfiguration(configSection).get<number>('projects.maxRunningThreads', 4);
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 4;
}

/** One open project: its hub, and what the threads are doing. */
interface LiveProject {
	readonly id: string;
	readonly hub: ProjectHub;
	readonly conductor: ConductorReader;
	/** The side panel's next refresh, while one is pending. */
	panelTimer?: ReturnType<typeof setTimeout>;
	readonly coordinator: ChatController;
	/** Threads that called report in the turn now running. */
	readonly reported: Set<string>;
	/** Notes for threads still setting up or starting a turn, sent when that ends; a thread's running turn holds its own (its queue). */
	readonly queued: Map<string, string[]>;
	/** Threads whose current turn is their plan (Plan first). */
	readonly planning: Set<string>;
	readonly merged: Set<string>;
	readonly removed: Set<string>;
	readonly disposables: vscode.Disposable[];
	/** The project's own folder: its settings and memory (projectStore.ts). */
	readonly home: string;
	/** Its settings, once read; `loading` resolves with the latest. */
	config?: ProjectConfig;
	loading: Promise<ProjectConfig>;
	/** Gemini is drafting the Memory text, and why the last draft failed. */
	drafting?: boolean;
	draftError?: string;
	/** How many requests (turns) each thread's chat recorded, counted once from its saved chat, then at each turn's end. */
	readonly requests: Map<string, number>;
	/** Reads the quota again when it resets, while new threads are held for it. */
	quotaTimer?: ReturnType<typeof setTimeout>;
}

export class Projects implements vscode.Disposable {

	private server: ProjectMcpServer | undefined;
	private readonly projects = new Map<string, LiveProject>();

	constructor(private readonly agents: ProjectAgents, private readonly version: string) { }

	/** Starts the MCP server; a project agent's session must not open before it listens. */
	async ready(): Promise<void> {
		this.server ??= new ProjectMcpServer({
			call: (caller, name, args) => this.call(caller, name, args),
			multiRepo: caller => caller.role === 'thread' && !!this.agents.record(caller.thread)?.repos?.length,
		}, this.version);
		await this.server.start();
	}

	/** The project server entry for a project agent's session; nothing for other agents. */
	mcpServersFor(record: AgentRecord): acp.McpServer[] {
		const caller = callerOf(record);
		const config = caller && this.server?.configFor(caller);
		return config ? [config as acp.McpServer] : [];
	}

	/**
	 * Requests answered without asking: the coordinator may call only the
	 * project's tools, so those are allowed at once and anything else is
	 * refused; a thread's report is allowed at once.
	 */
	instantAnswer(record: AgentRecord, request: acp.RequestPermissionRequest): InstantAnswer | undefined {
		const allow = request.options.find(option => option.kind === 'allow_once') ?? request.options.find(option => option.kind.startsWith('allow'));
		if (record.project?.role === 'coordinator') {
			const owner = toolCallOwner(request, coordinatorTools, projectServerName);
			if (owner === 'ours') {
				return allow && { optionId: allow.optionId, quiet: true };
			}
			if (owner === 'unknown') {
				// Titled as a project tool, but its id doesn't say whose: the user decides.
				return undefined;
			}
			const reject = request.options.find(option => option.kind === 'reject_once') ?? request.options.find(option => option.kind.startsWith('reject'));
			return reject && { optionId: reject.optionId, label: vscode.l10n.t("Refused automatically: the coordinator hands work to threads") };
		}
		if (record.project?.role === 'thread' && isProjectToolCall(request, threadTools, projectServerName)) {
			return allow && { optionId: allow.optionId, quiet: true };
		}
		return undefined;
	}

	/** What makes the coordinator's chat the project chat. */
	chatProject(coordinatorId: string): ChatProject {
		return {
			post: (text, attachments) => this.projects.get(coordinatorId)?.hub.post(withAttachments(text, attachments)),
			hidesToolCall: title => isProjectToolTitle(title, coordinatorTools),
			threadAction: (thread, action, repo, choice) => void this.threadAction(coordinatorId, thread, action, repo, choice),
			prepareThread: thread => {
				if (this.agents.record(thread)?.project?.role === 'thread') {
					this.agents.prepare(thread);
				}
			},
			startThread: thread => void this.startThread(coordinatorId, thread),
			openSettings: () => void this.openSettings(coordinatorId),
			saveSettings: settings => void this.saveSettings(coordinatorId, settings),
			setPlanFirst: on => void this.setPlanFirst(coordinatorId, on),
			settingsAction: (action, name) => void this.settingsAction(coordinatorId, action, name),
			retryWake: () => this.projects.get(coordinatorId)?.hub.retry(),
			sessionReplaced: () => {
				const hub = this.projects.get(coordinatorId)?.hub;
				hub?.setBriefed(false);
				hub?.memoryChanged();
			},
		};
	}

	/**
	 * Fork Thread made `fork` from thread `parent`: it joins the parent's
	 * project as a thread of its own, with a card, and the coordinator hears
	 * with its next wake.
	 */
	async threadForked(fork: AgentRecord, parent: AgentRecord, context: ForkContext): Promise<void> {
		const role = fork.project?.role === 'thread' ? fork.project : undefined;
		const project = role && this.projects.get(role.coordinator);
		if (!project) {
			return;
		}
		project.hub.addForkedThread({ id: fork.id, title: fork.title, ...(fork.worktree ? { branch: fork.worktree.branch } : {}) }, parent.id);
		this.showCard(project, fork.id);
		// A copied session already holds the project's notes the thread was given; the conversation alone doesn't.
		if (context === 'conversation') {
			const memory = await projectMemory(project.home, await project.loading, 'threads').catch(() => undefined);
			if (memory) {
				this.agents.controller(fork.id)?.addContext(threadMemoryContext(memory));
			}
		}
	}

	/** Merge Back on a thread, as its card does: Try in Workspace, or Keep Changes once tried; with merge commits, the merge, after which it is resolved. */
	mergeThread(thread: string): Promise<void> {
		const record = this.agents.record(thread);
		const role = record?.project;
		if (!this.agents.mergeCommits(thread) && record?.tried?.state === 'trying') {
			// Once tried, the fork card's one button offers Keep Changes, Take Back and the rest.
			return this.agents.mergeBack(thread).then(() => undefined);
		}
		const action = this.agents.mergeCommits(thread) ? 'merge' : 'try';
		return role?.role === 'thread' ? this.threadAction(role.coordinator, thread, action) : Promise.resolve();
	}

	/** A project agent started: a coordinator opens its project, a thread joins its own. */
	attach(record: AgentRecord): void {
		if (record.project?.role === 'coordinator') {
			this.openProject(record);
		}
	}

	/** The Project Settings command: opens the project chat with its settings. */
	async openSettingsOf(coordinatorId: string): Promise<void> {
		await this.agents.open(coordinatorId);
		await this.openSettings(coordinatorId);
	}

	/** The New Thread command: opens the project chat with its dialog. */
	async openNewThread(coordinatorId: string): Promise<void> {
		await this.agents.open(coordinatorId);
		this.agents.controller(coordinatorId)?.openNewThread();
	}

	/** A project agent's session stopped in this window. */
	detach(id: string): void {
		const project = this.projects.get(id);
		if (project) {
			this.projects.delete(id);
			clearTimeout(project.panelTimer);
			clearTimeout(project.quotaTimer);
			vscode.Disposable.from(...project.disposables).dispose();
			project.hub.dispose();
		}
	}

	/** A thread's chat changed what it is doing. */
	threadActivity(record: AgentRecord, before: ChatActivity, after: ChatActivity): void {
		if (record.project?.role === 'coordinator') {
			// The coordinator's model is known once its session is ready (by the time a turn starts), and a turn may have started threads.
			const project = this.projects.get(record.id);
			if (project && (!after.busy || !before.busy)) {
				this.schedulePanel(project);
			}
			return;
		}
		if (record.project?.role !== 'thread') {
			return;
		}
		const project = this.projects.get(record.project.coordinator);
		if (!project) {
			return;
		}
		const { hub } = project;
		if (after.needsPermission) {
			hub.updateThread(record.id, { state: 'waiting', detail: after.step });
		} else if (after.busy) {
			if (!before.busy) {
				project.reported.delete(record.id);
			}
			hub.updateThread(record.id, { state: 'working', detail: after.step });
		} else if (before.busy) {
			this.threadTurnEnded(project, record);
		}
		this.showCard(project, record.id);
	}

	/** A thread was removed (Undo thread, or Remove in the Agents pane): its card says so and the coordinator no longer lists it. */
	threadRemoved(record: AgentRecord): void {
		const project = record.project?.role === 'thread' ? this.projects.get(record.project.coordinator) : undefined;
		if (!project || project.removed.has(record.id)) {
			return;
		}
		project.removed.add(record.id);
		project.queued.delete(record.id);
		project.coordinator.showThread({ thread: record.id, title: record.title, state: 'done', startedAt: record.createdAt, removed: true });
		project.hub.removeThread(record.id);
		this.schedulePanel(project);
	}

	/** A project's repositories when it has several, for the coordinator's footer; undefined with one. */
	repoFolders(coordinatorId: string): readonly { readonly name: string; readonly folder: string }[] | undefined {
		const repos = this.projects.get(coordinatorId)?.config?.repos;
		return repos && repos.length > 1 ? repos.map(repo => ({ name: repo.key, folder: repo.folder })) : undefined;
	}

	/** A thread's files changed: its card shows the new counts. */
	threadChanged(record: AgentRecord): void {
		const project = record.project?.role === 'thread' ? this.projects.get(record.project.coordinator) : undefined;
		if (project) {
			this.showCard(project, record.id);
		}
	}

	/**
	 * A coordinator without its tools can't start a thread, and says so after
	 * a wasted turn; that happens when its session opened before the CLI
	 * trusted the project's folders. So the first wake checks the CLI listed
	 * the tools, and if not gets them loaded before sending anything.
	 */
	private async ensureTools(record: AgentRecord, coordinator: ChatController): Promise<void> {
		const caller = callerOf(record);
		const server = this.server;
		if (!caller || !server) {
			return;
		}
		// The CLI lists a server's tools as the session opens, which may not have happened yet.
		await coordinator.openSession();
		if (await server.whenListed(caller, toolsListedMs)) {
			return;
		}
		// A session that opened before the server listened was never given it: opening it again gives it.
		const opened = this.agents.sessionServers(record.id);
		if (opened && !opened.includes(projectServerName) && this.mcpServersFor(record).length) {
			this.agents.log(`The coordinator of ${record.title} opened without the project's tools (servers: ${opened.join(', ') || 'none'}); opening its session again`);
			await this.agents.reopenSession(record.id);
			if (await server.whenListed(caller, toolsListedMs)) {
				return;
			}
		}
		const folder = coordinatorHome(record.id);
		const block = await projectToolsBlock({ folder, server: projectServerName });
		this.agents.log(`The coordinator of ${record.title} has no project tools (opened with: ${this.agents.sessionServers(record.id)?.join(', ') || 'none'}, contacted: ${server.wasContacted(caller)}, block: ${block ? JSON.stringify(block) : 'none found'})`);
		// Only an untrusted folder, or one trusted after the agent started, is GeminiCode's to put right.
		if (block && block.kind !== 'untrusted') {
			throw new Error(blockMessage(block));
		}
		const problem = this.agents.mcpProblem(projectServerName);
		if (!block && problem) {
			throw new Error(vscode.l10n.t("The Gemini CLI couldn't connect to the project's tools: {0}", problem));
		}
		coordinator.addNotice(block
			? vscode.l10n.t("The Gemini CLI doesn't trust the coordinator's folder, so it loaded none of the project's tools and can't start threads. Trust the project's folders to go on; your message waits.")
			: vscode.l10n.t("The project's tools didn't load because Gemini started before their folders were trusted. Restarting Gemini once no agent is working; your message waits until then."));
		server.forgetListed(caller);
		if (!await this.agents.reloadProjectTools(record.id)) {
			throw new Error(vscode.l10n.t("The project's folders aren't trusted, so the Gemini CLI loads no project tools there. Trust them to start threads."));
		}
		if (!await server.whenListed(caller, toolsReloadMs)) {
			const after = await projectToolsBlock({ folder, server: projectServerName });
			const failed = this.agents.mcpProblem(projectServerName);
			this.agents.log(`The coordinator of ${record.title} still has no project tools after a restart (contacted: ${server.wasContacted(caller)}, block: ${after ? JSON.stringify(after) : 'none found'}, MCP problem: ${failed ?? 'none'})`);
			throw new Error(after ? blockMessage(after) : failed ? vscode.l10n.t("The Gemini CLI couldn't connect to the project's tools: {0}", failed) : vscode.l10n.t("The project's tools still didn't load, and nothing GeminiCode checks explains why. The Gemini log (Output, Gemini) has the details."));
		}
		coordinator.addNotice(vscode.l10n.t("The project's tools loaded."));
	}

	dispose(): void {
		for (const id of [...this.projects.keys()]) {
			this.detach(id);
		}
		this.server?.dispose();
	}

	private openProject(record: AgentRecord): void {
		this.detach(record.id);
		const coordinator = this.agents.controller(record.id);
		const folder = this.agents.workspaceFolder(record.id);
		if (!coordinator || !folder) {
			return;
		}
		const conductor = new ConductorReader(folder);
		const home = coordinatorHome(record.id);
		const hub = new ProjectHub(record.id, {
			prompt: async text => {
				await this.ensureTools(record, coordinator);
				// Plan mode takes away the project's tools, and the coordinator never edits anyway.
				await coordinator.leavePlanMode();
				return coordinator.sendUnseen(text);
			},
		}, {
			start: request => this.startRequested(project, request),
			message: (thread, text) => this.message(record.id, thread, text),
			read: (thread, last) => this.read(thread, last),
			addRepo: async (thread, key) => {
				const config = await project.loading;
				const repo = config.repos.find(each => each.key === key);
				if (!repo) {
					throw new Error(`No repository ${key}.`);
				}
				const said = await this.agents.addRepo(thread, repo, await projectMemory(home, config, 'threads'));
				this.showCard(project, thread);
				return said;
			},
		}, {
			// The memory is read first in each wake, so the repositories are known by the time they are asked for.
			memory: async () => projectMemory(home, await project.loading, 'coordinator'),
			repos: () => repoKeys(project.config),
			outline: async () => {
				const repos = (await project.loading).repos;
				const outlines = await Promise.all(repos.map(async repo => [repo.key, await this.agents.outline?.(repo.folder)] as const));
				const known = outlines.filter((entry): entry is readonly [string, string] => !!entry[1]);
				// Each repository's outline trimmed, so several fit in one wake.
				return known.length ? known.map(([key, text]) => repos.length > 1 ? `[${key}]\n${text.slice(0, outlineChars)}` : text.slice(0, outlineChars)).join('\n\n') : undefined;
			},
			conductor: () => conductor.read(),
			trackBrief: track => conductor.trackBrief(track),
			maxRunning: () => maxRunningThreads(),
			quotaHeld: () => !!quotaHold(this.agents.quota()),
		});
		// A coordinator reopened with its history already has the role brief.
		hub.setBriefed(!!record.sessionId);
		const project: LiveProject = {
			id: record.id, hub, coordinator, conductor,
			reported: new Set(), queued: new Map(), planning: new Set(), merged: new Set(), removed: new Set(),
			disposables: [], home, loading: Promise.resolve({ repos: [], instructions: '', files: [], defaults: {} }),
			requests: new Map(),
		};
		project.loading = this.loadConfig(project, folder);
		const threads = this.agents.threadsOf(record.id);
		/** Threads with a brief or notes a closed window kept from them: they start first, and get them. */
		const pending: string[] = [];
		for (const thread of threads) {
			if (thread.project?.role === 'thread') {
				const resolved = !!thread.project.resolved;
				hub.restoreThread({ id: thread.id, title: thread.title, state: 'done', byCoordinator: thread.project.byCoordinator, ...(resolved ? { resolved } : {}) });
				if (resolved) {
					project.merged.add(thread.id);
				}
				const held = thread.project.pending;
				if (held?.notes?.length) {
					project.queued.set(thread.id, [...held.notes]);
				}
				if (held?.brief || held?.notes?.length) {
					pending.push(thread.id);
				}
			}
		}
		project.disposables.push(
			hub.onDidPost(entry => {
				if (entry.kind === 'coordinator') {
					coordinator.addCoordinatorPost(entry.text);
				} else if (entry.kind === 'thread') {
					this.showCard(project, entry.thread);
				}
			}),
			hub.onDidChangeThread(thread => this.showCard(project, thread.id)),
			// A lower quota, or a higher limit, lets queued threads start.
			this.agents.onDidChangeQuota(() => {
				hub.limitsChanged();
				this.schedulePanel(project);
			}),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(`${configSection}.projects.maxRunningThreads`)) {
					hub.limitsChanged();
					this.schedulePanel(project);
				}
			}),
			// A failed wake offers Retry on its error, until the next wake starts.
			hub.onDidFailWake(failure => coordinator.offerRetry(failure.message)),
			hub.onDidChangeBusy(busy => busy && coordinator.clearRetry()),
		);
		this.projects.set(record.id, project);
		this.schedulePanel(project);
		// Cards as saved may be out of date: a thread removed while this project wasn't open, or a try that changed.
		for (const item of coordinator.conversation) {
			if (item.kind === 'thread' && !item.removed && !this.agents.record(item.thread)) {
				project.removed.add(item.thread);
				coordinator.showThread({ thread: item.thread, title: item.title, state: 'done', startedAt: item.startedAt, removed: true, tried: undefined, guide: undefined });
			}
		}
		for (const thread of threads) {
			this.showCard(project, thread.id);
		}
		// Each thread's requests, from its saved chat, once; its turns' ends keep them current.
		void Promise.all(threads.map(async thread => {
			const count = requestCount(await this.agents.savedConversation(thread.id).catch(() => []));
			if (!project.requests.has(thread.id)) {
				project.requests.set(thread.id, count);
			}
		})).then(() => this.schedulePanel(project));
		// A new project's Memory text starts as Gemini's draft, made in the background for the user to review.
		void project.loading.then(async config => {
			if (!config.instructions.trim() && !await fs.access(path.join(home, configFile)).then(() => true, () => false)) {
				await this.draft(project);
			}
		}).catch(err => this.agents.log(`${home}: the project's settings could not be read: ${errorMessage(err)}`));
		// The most recently used open threads start with it, so the ones a developer goes back to
		// are live; however many threads the project has, opening it costs the same. Any other
		// thread starts when it is needed: the pointer on its card or row, opening it, or a note
		// from the coordinator. A merged one starts only when it is opened.
		// One at a time, a moment apart: starting them all at once would compete with the window's own start.
		const warm = [...pending, ...warmThreads(threads).filter(thread => !pending.includes(thread))];
		void (async () => {
			for (const thread of warm) {
				await new Promise(resolve => setTimeout(resolve, threadStartGapMs));
				if (this.projects.get(record.id) !== project) {
					return;
				}
				// A thread with a brief still to send gets it, after its setup runs again (AgentProjects.resumeThread).
				await this.agents.resume(thread).catch(err => project.hub.updateThread(thread, { state: 'error', detail: `Couldn't start: ${errorMessage(err)}` }));
				if (pending.includes(thread)) {
					this.sendHeldNotes(project, thread);
				}
			}
		})();
	}

	private threadTurnEnded(project: LiveProject, record: AgentRecord): void {
		const { hub } = project;
		const controller = this.agents.controller(record.id);
		if (controller) {
			project.requests.set(record.id, requestCount(controller.conversation));
		}
		const planned = record.project?.role === 'thread' && !!record.project.planFirst && controller?.conversation.filter(item => item.kind === 'user').length === 1;
		if (planned) {
			hub.updateThread(record.id, { state: 'planned', detail: undefined });
		} else {
			hub.updateThread(record.id, { state: 'done', detail: undefined });
		}
		if (!project.reported.has(record.id) && !planned) {
			// Ending a turn without a report still tells the coordinator.
			const said = lastReply(controller);
			const reacted = reactionReport(lastPromptReactions(controller));
			const result = said ? `Finished its turn. It last said: ${said}` : 'Finished its turn without a reply.';
			hub.notify({ kind: 'report', thread: record.id, report: 'result', text: reacted ? `${reacted} ${result}` : result });
		}
		project.reported.delete(record.id);
		const queued = project.queued.get(record.id);
		if (queued?.length && controller) {
			project.queued.delete(record.id);
			this.agents.setPendingNotes(record.id, []);
			void controller.send(queued.join('\n\n'), [], 'coordinator');
		}
	}

	/**
	 * Notes a closed window kept for a thread whose brief went already: they
	 * go now (or after a turn that runs). A thread still to get its brief
	 * keeps them until that turn ends, as any notes held for setup.
	 */
	private sendHeldNotes(project: LiveProject, thread: string): void {
		const record = this.agents.record(thread);
		const held = record?.project?.role === 'thread' ? record.project.pending : undefined;
		const queued = project.queued.get(thread);
		const controller = this.agents.controller(thread);
		if (held?.brief || this.agents.settingUp(thread) || !queued?.length || !controller) {
			return;
		}
		project.queued.delete(thread);
		this.agents.setPendingNotes(thread, []);
		this.deliver(project, thread, controller, queued.join('\n\n'), 'coordinator');
	}

	private async message(coordinatorId: string, thread: string, text: string): Promise<boolean> {
		const project = this.projects.get(coordinatorId);
		// A merged thread whose folder was cleaned up gets it back from its branch first.
		if (!project || !this.agents.record(thread) || !await this.agents.restoreFolder(thread)) {
			return false;
		}
		const controller = this.agents.controller(thread);
		if (!controller) {
			return false;
		}
		// Reopened: the hub only sends to a resolved thread when the user asked to reopen it.
		if (project.merged.delete(thread)) {
			this.agents.setResolved(thread, false);
			this.showCard(project, thread);
		}
		this.deliver(project, thread, controller, text, 'coordinator');
		return true;
	}

	/**
	 * Sends a thread its brief, once its setup ended: now, or after a turn
	 * that runs. Not when its chat already has a message, which means the brief
	 * went before the window closed. Resolves once it is sent or queued.
	 */
	async sendBrief(thread: string, text: string, from?: 'coordinator'): Promise<void> {
		const controller = this.agents.controller(thread);
		if (!controller) {
			return;
		}
		await controller.whenRestored;
		if (controller.conversation.some(item => item.kind === 'user')) {
			return;
		}
		this.sendToThread(thread, text, from);
	}

	/** Sends a thread `text` now, or when its running turn (or its setup) ends. */
	sendToThread(thread: string, text: string, from?: 'coordinator'): void {
		const coordinator = this.agents.record(thread)?.project;
		const project = coordinator?.role === 'thread' ? this.projects.get(coordinator.coordinator) : undefined;
		const controller = this.agents.controller(thread);
		if (!controller) {
			return;
		}
		if (project) {
			this.deliver(project, thread, controller, text, from);
		} else {
			void controller.send(text, [], from);
		}
	}

	private deliver(project: LiveProject, thread: string, controller: ChatController, text: string, from: 'coordinator' | undefined): void {
		// A thread just started shows its saved chat first; the note follows it, in the order notes came.
		const restoring = controller.whenRestored;
		if (restoring) {
			void restoring.then(() => this.deliver(project, thread, controller, text, from));
			return;
		}
		// A running turn queues the note in the thread's chat, where the user sees it and can send it now or remove it.
		if (controller.running && !this.agents.settingUp(thread)) {
			void controller.send(text, [], from, 'queue');
		} else if (this.agents.settingUp(thread) || this.agents.activity(thread)?.busy) {
			// The pane's activity can lag the controller by a tick: the note waits for the turn's end, on the thread's record too.
			const queued = [...project.queued.get(thread) ?? [], text];
			project.queued.set(thread, queued);
			this.agents.setPendingNotes(thread, queued);
		} else {
			void controller.send(text, [], from);
		}
	}

	/** Reads a thread's chat without starting it: the coordinator may read many threads it never messages. */
	private async read(thread: string, last: number): Promise<string | undefined> {
		if (!this.agents.record(thread)) {
			return undefined;
		}
		// Each message cut to about 2,000 characters: a thread's reply can hold a whole log.
		return threadMessages(await this.agents.savedConversation(thread).catch(() => []), last);
	}

	/** A thread the coordinator or the dialog asked for, with what the project's settings add. */
	private async startRequested(project: LiveProject, request: ThreadRequest): Promise<string> {
		const config = await project.loading;
		const repos = config.repos.length > 1 ? config.repos.filter(repo => request.repos?.includes(repo.key)) : [];
		const memory = await projectMemory(project.home, config, 'threads');
		// The project's own defaults, else the workspace's branch defaults (`gemini.agents.branchDefaults`).
		const workspace = branchDefaults(this.agents.workspaceFolder(project.id));
		const model = request.model ?? config.defaults.threadModel ?? workspace.model;
		const planFirst = config.defaults.planFirst ?? workspace.planFirst;
		const branchPrefix = config.defaults.branchPrefix ?? (workspace.prefix === defaultBranchPrefix ? undefined : workspace.prefix);
		return this.agents.startThread(project.id, {
			...request,
			// The dialog shows the default already; the coordinator plans first when the user asked, or by default.
			planFirst: request.planFirst || (request.byCoordinator && !!planFirst),
			...(model ? { model } : {}),
		}, {
			...(repos.length ? { repos } : {}),
			...(memory ? { memory } : {}),
			...(branchPrefix !== undefined ? { branchPrefix } : {}),
		});
	}

	private async loadConfig(project: LiveProject, folder: string): Promise<ProjectConfig> {
		const repository = await repositoryRoot(folder) ?? folder;
		const config = await readProjectConfig(project.home, repository);
		project.config = config;
		project.coordinator.refreshGit();
		if (config.broken) {
			// The project opens with its repository alone, and the user is told what was lost and where its file is.
			this.agents.log(`${project.home}: project.json could not be read; moved to ${config.broken}`);
			void vscode.window.showWarningMessage(vscode.l10n.t("The settings of project \"{0}\" could not be read, so it opened with its repository alone. The file was moved to {1}.", this.agents.record(project.id)?.title ?? project.id, config.broken));
		}
		return config;
	}

	private setConfig(project: LiveProject, config: ProjectConfig): void {
		project.config = config;
		project.coordinator.refreshGit();
		project.loading = Promise.resolve(config);
		project.hub.memoryChanged();
		this.schedulePanel(project);
	}

	private async openSettings(coordinatorId: string): Promise<void> {
		const project = this.projects.get(coordinatorId);
		if (!project) {
			return;
		}
		const config = await project.loading;
		project.coordinator.showProjectSettings(await this.settingsView(project), true);
		if (!config.instructions.trim() && !config.draftedAt && !project.drafting) {
			void this.draft(project);
		}
	}

	private async refreshSettings(project: LiveProject): Promise<void> {
		const view = await this.settingsView(project);
		if (this.projects.get(project.id) === project) {
			project.coordinator.showProjectSettings(view, false);
		}
	}

	private async settingsView(project: LiveProject): Promise<ProjectSettingsView> {
		const config = await project.loading;
		const threads = this.agents.threadsOf(project.id).filter(thread => thread.project?.role === 'thread');
		const userSettings = path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini', 'settings.json');
		const repoRules = await Promise.all(config.repos.map(async repo => {
			const names = (await ruleEntries(repo.folder, userSettings).catch(() => [])).filter(name => !ruleFolders.includes(name));
			const present = await Promise.all(names.map(name => fs.access(path.join(repo.folder, name)).then(() => true, () => false)));
			return { key: repo.key, files: names.filter((_, i) => present[i]) };
		}));
		const resolved = (thread: AgentRecord) => thread.project?.role === 'thread' && !!thread.project.resolved;
		return {
			name: this.agents.record(project.id)?.title ?? '',
			repos: config.repos.map(repo => ({ key: repo.key, folder: repo.folder, label: tildify(repo.folder) })),
			defaults: defaultsView(config.defaults),
			instructions: config.instructions,
			maxChars: maxInstructionsChars,
			...(config.draftedAt ? { draftedAt: config.draftedAt } : {}),
			...(project.drafting ? { drafting: true } : {}),
			...(project.draftError ? { draftError: project.draftError } : {}),
			files: await Promise.all(config.files.map(async file => {
				const size = await fs.stat(path.join(project.home, memoryFolder, file.name)).then(stat => stat.size, () => undefined);
				return { ...file, ...(size !== undefined ? { chars: size } : {}) };
			})),
			memoryFolder: tildify(path.join(project.home, memoryFolder)),
			repoRules,
			stats: {
				open: threads.filter(thread => !resolved(thread)).length,
				merged: threads.filter(resolved).length,
				added: threads.reduce((sum, thread) => sum + (thread.changes?.added ?? 0), 0),
				removed: threads.reduce((sum, thread) => sum + (thread.changes?.removed ?? 0), 0),
			},
		};
	}

	private async saveSettings(coordinatorId: string, save: ProjectSettingsSave): Promise<void> {
		const project = this.projects.get(coordinatorId);
		if (!project) {
			return;
		}
		try {
			const before = await project.loading;
			const name = save.name.trim();
			if (name && name !== this.agents.record(coordinatorId)?.title) {
				this.agents.rename(coordinatorId, name);
			}
			// The project's own repository stays first; the others are kept as the popup listed them, once each.
			const repos: ProjectRepo[] = before.repos.slice(0, 1);
			for (const repo of save.repos) {
				if (path.isAbsolute(repo.folder) && !repos.some(each => each.folder === repo.folder)) {
					const taken = repos.map(each => each.key);
					repos.push({ key: /^[\w.-]{1,80}$/.test(repo.key) && !taken.includes(repo.key) ? repo.key : repoKey(repo.folder, taken), folder: repo.folder });
				}
			}
			await Promise.all(save.removedFiles.map(file => removeMemoryFile(project.home, file)));
			const instructions = save.instructions.slice(0, maxInstructionsChars);
			const keepDraft = before.draftedAt && instructions === before.instructions && !save.reviewedDraft;
			const config: ProjectConfig = {
				repos,
				instructions,
				files: save.files.filter(file => !save.removedFiles.includes(file.name)).map(file => ({ name: file.name, coordinator: !!file.coordinator, threads: !!file.threads })),
				defaults: {
					...(save.defaults.threadModel ? { threadModel: save.defaults.threadModel } : {}),
					planFirst: !!save.defaults.planFirst,
					...(save.defaults.branchPrefix.trim() !== 'gemini/' ? { branchPrefix: save.defaults.branchPrefix.trim() } : {}),
				},
				...(keepDraft ? { draftedAt: before.draftedAt } : {}),
			};
			await writeProjectConfig(project.home, config);
			// Read back, so the file list matches the memory folder.
			this.setConfig(project, await readProjectConfig(project.home, repos[0].folder));
			if (repos.length > 1 && before.repos.length < 2) {
				await this.agents.trustThreads(coordinatorId);
			}
			const added = repos.some(repo => !before.repos.some(each => each.folder === repo.folder));
			if (added && (!instructions.trim() || keepDraft)) {
				void this.draft(project);
			}
		} catch (err) {
			void showError(vscode.l10n.t("Could not save the project's settings: {0}", errorMessage(err)));
		}
		void this.refreshSettings(project);
	}

	/** The "+" menu's Plan first switch: changes only that default, as Project settings would save it. */
	private async setPlanFirst(coordinatorId: string, on: boolean): Promise<void> {
		const project = this.projects.get(coordinatorId);
		if (!project) {
			return;
		}
		try {
			const before = await project.loading;
			if (!!before.defaults.planFirst === on) {
				return;
			}
			const config: ProjectConfig = { ...before, defaults: { ...before.defaults, planFirst: on } };
			await writeProjectConfig(project.home, config);
			this.setConfig(project, config);
		} catch (err) {
			void showError(vscode.l10n.t("Could not save the project's settings: {0}", errorMessage(err)));
		}
		void this.refreshSettings(project);
	}

	private async settingsAction(coordinatorId: string, action: ProjectSettingsAction, name?: string): Promise<void> {
		const project = this.projects.get(coordinatorId);
		if (!project) {
			return;
		}
		const memory = path.join(project.home, memoryFolder);
		try {
			switch (action) {
				case 'pickRepository': {
					const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: vscode.l10n.t("Add Repository"), title: vscode.l10n.t("Add a Repository to the Project") });
					if (!picked?.[0]) {
						return;
					}
					const root = await repositoryRoot(picked[0].fsPath);
					if (!root) {
						void showError(vscode.l10n.t("{0} is not in a Git repository. A project's threads each work on their own branch, so each repository needs Git.", path.basename(picked[0].fsPath)));
						return;
					}
					const config = await project.loading;
					project.coordinator.pickedRepository({ key: repoKey(root, config.repos.map(repo => repo.key)), folder: root, label: tildify(root) });
					return;
				}
				case 'addFiles': {
					const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: vscode.l10n.t("Add"), title: vscode.l10n.t("Add Context Files"), filters: { [vscode.l10n.t("Markdown")]: ['md', 'markdown', 'txt'] } });
					if (picked?.length) {
						await addMemoryFiles(project.home, picked.map(uri => uri.fsPath));
						await this.rereadConfig(project);
					}
					return;
				}
				case 'newFile': {
					const title = await vscode.window.showInputBox({ title: vscode.l10n.t("New Context File"), prompt: vscode.l10n.t("The file's name, such as \"release process\""), validateInput: value => value.trim() ? undefined : vscode.l10n.t("Enter a name.") });
					if (title?.trim()) {
						const file = await newMemoryFile(project.home, title);
						await this.rereadConfig(project);
						await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
					}
					return;
				}
				case 'openFile':
					if (name && path.basename(name) === name) {
						await vscode.window.showTextDocument(vscode.Uri.file(path.join(memory, name)), { preview: false });
					}
					return;
				case 'draft':
					return this.draft(project);
				case 'cleanUp':
					await this.agents.cleanUpMerged(coordinatorId);
					return this.refreshSettings(project);
			}
		} catch (err) {
			void showError(errorMessage(err));
		}
	}

	/** The memory folder changed: the popup's file list follows it. */
	private async rereadConfig(project: LiveProject): Promise<void> {
		const config = await project.loading;
		this.setConfig(project, await readProjectConfig(project.home, config.repos[0]?.folder ?? project.home));
		await this.refreshSettings(project);
	}

	/**
	 * Gemini drafts the Memory text from the repositories in one direct
	 * request, saved with the time it was drafted so the popup asks the user
	 * to review it. A save of the user's own text meanwhile wins.
	 */
	private async draft(project: LiveProject): Promise<void> {
		if (project.drafting) {
			return;
		}
		project.drafting = true;
		project.draftError = undefined;
		void this.refreshSettings(project);
		try {
			const before = await project.loading;
			const facts = await Promise.all(before.repos.map(repoFacts));
			const text = cleanDraft(await this.agents.direct(draftRequest(facts)) ?? '');
			if (!text) {
				throw new Error(vscode.l10n.t("Gemini's quick requests are off or not available with this sign-in."));
			}
			const current = await project.loading;
			if (current.instructions === before.instructions) {
				const next: ProjectConfig = { ...current, instructions: text.slice(0, maxInstructionsChars), draftedAt: Date.now() };
				await writeProjectConfig(project.home, next);
				this.setConfig(project, next);
			}
		} catch (err) {
			project.draftError = errorMessage(err);
		} finally {
			project.drafting = false;
			void this.refreshSettings(project);
		}
	}

	private async call(caller: ProjectCaller, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
		const project = this.projects.get(caller.project);
		if (!project) {
			return { content: [{ type: 'text', text: 'This project is not open.' }], isError: true };
		}
		if (caller.role === 'thread' && name === 'report') {
			project.reported.add(caller.thread);
		}
		return project.hub.call(caller, name, args);
	}

	/** A thread's work moved in or out of the user's checkout: its card and the coordinator's list show it. */
	refreshThread(thread: string): void {
		const role = this.agents.record(thread)?.project;
		const project = role?.role === 'thread' ? this.projects.get(role.coordinator) : undefined;
		if (project) {
			this.showCard(project, thread);
		}
	}

	/** A thread's work was kept in the user's checkout (resolved), or it is being tried again (open). */
	setThreadKept(thread: string, kept: boolean): void {
		this.agents.setResolved(thread, kept);
		const role = this.agents.record(thread)?.project;
		const project = role?.role === 'thread' ? this.projects.get(role.coordinator) : undefined;
		if (!project) {
			return;
		}
		if (kept) {
			project.merged.add(thread);
		} else {
			project.merged.delete(thread);
		}
		project.hub.updateThread(thread, { resolved: kept });
		this.showCard(project, thread);
	}

	private showCard(project: LiveProject, thread: string): void {
		const record = this.agents.record(thread);
		const info = project.hub.threadList.find(t => t.id === thread);
		if (!record || !info) {
			return;
		}
		const role = record.project?.role === 'thread' ? record.project : undefined;
		// Discarded work later turns replaced is offered from the card's ⋯ menu (tryState.ts, discardOffer).
		const offer = !record.discarded?.length ? undefined : record.discarded.some(repo => repo.superseded) ? 'menu' : 'restore';
		// A try still being written shows as trying; it is one in a moment, or taken back on the next start.
		const workspace = offer === 'restore' ? 'discarded' : record.tried?.state === 'applying' ? 'trying' : record.tried?.state;
		if (info.workspace !== workspace) {
			project.hub.updateThread(thread, { workspace });
		}
		project.coordinator.showThread({
			thread,
			title: record.title,
			// A queued thread has no agent, so no card, until it starts.
			state: info.state === 'queued' ? 'starting' : info.state,
			...(info.detail ? { detail: info.detail } : {}),
			...(record.worktree ? { branch: record.worktree.branch } : {}),
			...(record.changes ? { changes: record.changes } : {}),
			startedAt: record.createdAt,
			...(role?.track ? { track: role.track } : {}),
			...(project.merged.has(thread) ? { merged: true } : {}),
			...(project.removed.has(thread) ? { removed: true } : {}),
			...(record.repos?.length ? { repos: repoCards(record, this.agents.changedFiles(thread)) } : {}),
			// Set every time, so a card loses what no longer applies.
			tried: triedCard(record, this.agents.triedEdits(thread)),
			discarded: offer === 'restore' ? true : undefined,
			restorable: offer === 'menu' ? true : undefined,
			guide: record.tried?.state === 'trying' && !this.agents.guideSeen() ? true : undefined,
			tryChoice: this.agents.tryChoice(thread) === 'try' ? undefined : this.agents.tryChoice(thread) as 'merge' | 'mr',
			mergeRequests: this.agents.mergeRequests() || undefined,
		});
		this.schedulePanel(project);
	}

	/** Refreshes the side panel once a burst of card updates has settled. */
	private schedulePanel(project: LiveProject): void {
		if (project.panelTimer) {
			return;
		}
		project.panelTimer = setTimeout(() => {
			project.panelTimer = undefined;
			void this.showPanel(project);
		}, panelDelayMs);
	}

	private async showPanel(project: LiveProject): Promise<void> {
		// Three stats at most: the reader keeps the files until they change.
		const [conductor, config] = await Promise.all([project.conductor.read().catch(() => undefined), project.loading]);
		if (this.projects.get(project.id) !== project) {
			return;
		}
		const model = project.coordinator.model;
		const now = Date.now();
		const list = project.hub.threadList;
		const running = runningThreads(list);
		const limit = maxRunningThreads();
		const requests = (count: number) => count === 1 ? vscode.l10n.t("1 request") : vscode.l10n.t("{0} requests", count);
		const counted = list.filter(thread => !project.removed.has(thread.id) && project.requests.has(thread.id));
		const total = counted.reduce((sum, thread) => sum + (project.requests.get(thread.id) ?? 0), 0);
		project.coordinator.showProjectPanel({
			name: this.agents.record(project.id)?.title ?? '',
			counts: threadCounts(list, project.merged, project.removed),
			// Archived threads leave the list (the Agents pane has them under Archived); the merged count still counts them.
			threads: list.flatMap(thread => {
				const state = panelState(thread, project.merged, project.removed);
				const record = this.agents.record(thread.id);
				const count = project.requests.get(thread.id);
				const detail = thread.queued === 'quota'
					? vscode.l10n.t("Starts when today's quota resets, or with Start Anyway")
					: thread.queued ? vscode.l10n.t("Starts when a running thread finishes · {0} of {1} running", running, limit) : undefined;
				return state && !(record && isArchived(record, now)) ? [{
					id: thread.id, title: record?.title ?? thread.title, state,
					...count ? { requests: requests(count) } : {},
					...detail ? { detail } : {},
				}] : [];
			}),
			...total ? { requests: counted.length === 1 ? vscode.l10n.t("This project: {0} across 1 thread", requests(total)) : vscode.l10n.t("This project: {0} across {1} threads", requests(total), counted.length) } : {},
			...this.heldBanner(project),
			...(conductor ? { conductor: { openTracks: conductor.tracks.filter(track => track.state !== 'done').length } } : {}),
			...(model ? { model } : {}),
			...(config.repos.length > 1 ? { repos: repoKeys(config) } : {}),
			defaults: defaultsView(config.defaults),
		});
	}

	/**
	 * The side panel's banner while today's quota holds new threads, with
	 * when they start; and, when the quota says when it resets, a read of
	 * the quota then, so they start without waiting for the meter's next read.
	 */
	private heldBanner(project: LiveProject): { readonly held?: string } {
		const hold = quotaHold(this.agents.quota());
		const held = project.hub.queued.filter(thread => thread.queued === 'quota').length;
		clearTimeout(project.quotaTimer);
		project.quotaTimer = undefined;
		if (!hold || !held) {
			return {};
		}
		const resetAt = hold.resetTime ? Date.parse(hold.resetTime) : NaN;
		const percent = Math.round(hold.used * 100);
		if (Number.isFinite(resetAt) && resetAt > Date.now()) {
			// Timers past about 24 days fire at once; a quota resets daily.
			project.quotaTimer = setTimeout(() => this.agents.refreshQuota(), Math.min(resetAt - Date.now() + 60_000, 2 ** 31 - 1));
			const at = new Date(resetAt).toLocaleTimeString(vscode.env.language, { hour: '2-digit', minute: '2-digit' });
			return { held: held === 1 ? vscode.l10n.t("Holding 1 new thread: today's quota is {0}% used. It starts when the quota resets at {1}.", percent, at) : vscode.l10n.t("Holding {0} new threads: today's quota is {1}% used. They start when it resets at {2}.", held, percent, at) };
		}
		return { held: held === 1 ? vscode.l10n.t("Holding 1 new thread: today's quota is {0}% used. It starts when the quota resets.", percent) : vscode.l10n.t("Holding {0} new threads: today's quota is {1}% used. They start when it resets.", held, percent) };
	}

	private async threadAction(coordinatorId: string, thread: string, action: ThreadAction, repo?: string, choice?: unknown): Promise<void> {
		const project = this.projects.get(coordinatorId);
		switch (action) {
			case 'startAnyway':
				project?.hub.startAnyway();
				if (project) {
					this.schedulePanel(project);
				}
				return;
			case 'open':
				return this.agents.open(thread);
			case 'stop':
				return this.agents.stopTurn(thread);
			case 'review':
				return this.agents.openChanges(thread);
			case 'merge':
				if (await this.agents.mergeBack(thread, repo) && project) {
					project.merged.add(thread);
					this.agents.setResolved(thread, true);
					project.hub.updateThread(thread, { resolved: true });
				}
				if (project) {
					this.showCard(project, thread);
				}
				return;
			case 'remove':
				// threadRemoved updates the card and the hub.
				await this.agents.undoThread(thread);
				return;
			case 'tryMenu':
				return isTryChoice(choice) ? this.agents.chooseTry(thread, choice) : undefined;
			case 'try':
			case 'keep':
			case 'takeBack':
			case 'send':
			case 'resolve':
			case 'discard':
			case 'restore':
				await this.agents.tryAction(thread, action);
				if (project) {
					this.showCard(project, thread);
				}
				return;
			case 'guide':
			case 'dismissGuide':
				await this.agents.setGuideSeen(action === 'dismissGuide');
				for (const each of project ? this.agents.threadsOf(project.id) : []) {
					this.showCard(project!, each.id);
				}
				return;
			case 'terminal':
				return this.agents.openTerminal(thread);
			case 'checks':
				await vscode.commands.executeCommand('gemini.team.runChecks', thread);
				return;
			case 'approve': {
				const controller = this.agents.controller(thread);
				if (controller && !await controller.approvePlan()) {
					await controller.send(vscode.l10n.t("The plan is approved. Carry it out."));
				}
				return;
			}
			case 'retry': {
				const controller = this.agents.controller(thread);
				const brief = controller?.conversation.find(item => item.kind === 'user');
				if (controller && brief?.kind === 'user') {
					await controller.send(brief.text, [], brief.from);
				}
				return;
			}
		}
	}

	/** The New thread dialog: the thread starts at once, and the coordinator hears with its next wake. */
	private async startThread(coordinatorId: string, thread: NewThread): Promise<void> {
		const project = this.projects.get(coordinatorId);
		const title = thread.title.trim();
		const brief = thread.brief.trim();
		if (!project || !title || !brief) {
			return;
		}
		const config = await project.loading;
		const repos = config.repos.length > 1 ? repoKeys(config).filter(key => thread.repos?.includes(key)) : [];
		if (config.repos.length > 1 && !repos.length) {
			void showError(vscode.l10n.t("Choose at least one repository for the thread."));
			return;
		}
		try {
			await project.hub.startThread(title, brief, thread.planFirst, {
				...(thread.branch?.trim() ? { branch: thread.branch.trim() } : {}),
				...(thread.model ? { model: thread.model } : {}),
				...(repos.length ? { repos } : {}),
			});
		} catch (err) {
			void showError(vscode.l10n.t("Could not start the thread: {0}", err instanceof Error ? err.message : String(err)));
		}
	}
}

/** How long the side panel waits for a burst of card updates to settle. */
const panelDelayMs = 100;
/** The gap between starting one of an opened project's threads and the next. */
const threadStartGapMs = 1_500;

/** The project's repositories by key, when it has several; none for a project with one. */
function repoKeys(config: ProjectConfig | undefined): string[] {
	return config && config.repos.length > 1 ? config.repos.map(repo => repo.key) : [];
}

function defaultsView(defaults: ProjectDefaults): ProjectDefaultsView {
	return { ...(defaults.threadModel ? { threadModel: defaults.threadModel } : {}), planFirst: !!defaults.planFirst, branchPrefix: defaults.branchPrefix ?? 'gemini/' };
}

/** A card's view of a thread's try: its file count, how often it followed, and what holds it back. */
function triedCard(record: AgentRecord, edits: readonly string[] | undefined): TriedCard | undefined {
	const tried = record.tried;
	if (!tried) {
		return undefined;
	}
	const conflicts = tried.repos.flatMap(repo => repo.conflicts ?? []);
	const unmerged = tried.state === 'trying' ? tried.repos.flatMap(repo => repo.unmerged ?? []) : [];
	return {
		state: tried.state === 'applying' ? 'trying' : tried.state,
		files: tried.repos.reduce((sum, repo) => sum + repo.files.length, 0),
		...tried.updates ? { updates: tried.updates } : {},
		...conflicts.length ? { conflicts } : {},
		...unmerged.length ? { unmerged } : {},
		...tried.state === 'trying' && edits?.length ? { edits } : {},
	};
}

/** A multi-repository thread's card rows: each repository's changed files, from the edits its agent made there. */
function repoCards(record: AgentRecord, files: readonly EditedFile[] | undefined): NonNullable<ThreadCard['repos']> {
	return (record.repos ?? []).map(repo => {
		const inside = (files ?? []).filter(file => file.path === repo.folder || file.path.startsWith(repo.folder + path.sep));
		return {
			key: repo.key,
			files: inside.length,
			added: inside.reduce((sum, file) => sum + file.added, 0),
			removed: inside.reduce((sum, file) => sum + file.removed, 0),
			...(repo.merged ? { merged: true } : {}),
		};
	});
}

/** How long the first wake waits for the CLI to list the coordinator's tools as its session opens. */
const toolsListedMs = 10_000;
/** How long it then waits for a restart to bring them, which waits for working agents to finish. */
const toolsReloadMs = 10 * 60_000;

/** What a block on the project's tools means, and what to do about it. */
function blockMessage(block: ProjectToolsBlock): string {
	switch (block.kind) {
		case 'untrusted':
			return vscode.l10n.t("The Gemini CLI doesn't trust {0}, so it loads no project tools there. Trust the project's folders to start threads.", tildify(block.folder));
		case 'excluded':
			return vscode.l10n.t("Your Gemini settings ({0}) leave out {1} in mcp.excluded. Remove it there to start threads.", tildify(block.file), projectServerName);
		case 'disabled':
			return vscode.l10n.t("{0} is turned off for the Gemini CLI. Run \"gemini mcp enable {0}\" in a terminal, then send your message again.", projectServerName);
		case 'enablementUnreadable':
			return vscode.l10n.t("The Gemini CLI can't read {0}, so it loads no MCP servers at all. Fix or delete that file, then send your message again.", tildify(block.file));
	}
}

function callerOf(record: AgentRecord): ProjectCaller | undefined {
	const role: AgentProjectRole | undefined = record.project;
	return role?.role === 'coordinator' ? { role: 'coordinator', project: record.id }
		: role?.role === 'thread' ? { role: 'thread', project: role.coordinator, thread: record.id }
			: undefined;
}

/** The reactions the turn's prompt carried, so the coordinator hears of them as a line rather than as their notes. */
function lastPromptReactions(controller: ChatController | undefined): readonly ReactionRef[] {
	const prompt = controller?.conversation.findLast(item => item.kind === 'user');
	return prompt?.kind === 'user' ? prompt.reactions ?? [] : [];
}

function lastReply(controller: ChatController | undefined): string | undefined {
	const items = controller?.conversation ?? [];
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind === 'user') {
			return undefined;
		}
		if (item.kind === 'agent' && item.text.trim()) {
			const text = item.text.trim();
			return text.length > 600 ? `...${text.slice(-600)}` : text;
		}
	}
	return undefined;
}

/** The coordinator's prompt is text only; attached context goes by name, for its threads to read. */
function withAttachments(text: string, attachments: readonly Attachment[]): string {
	return attachments.length ? `${text}\n\nAttached: ${attachments.map(attachmentLabel).join(', ')}` : text;
}

