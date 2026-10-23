/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Agents pane's model: workspaces the user added, and the agents under
// each. Names follow upstream's Agents Window (workspace, session) so the pane
// can move onto it later. Plain data, so the host can persist it as JSON.

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ChangeTotals } from './agentChanges';
import { Emitter } from './events';
import type { AgentWorktree, RepoWorktree } from './worktrees';

export interface WorkspaceRecord {
	readonly id: string;
	/** Absolute folder path; agents in this workspace run with it as their `cwd`. */
	readonly folder: string;
}

export interface AgentRecord {
	readonly id: string;
	readonly workspaceId: string;
	readonly title: string;
	/** Whether the user named it; otherwise the first prompt names it. */
	readonly titleSetByUser?: boolean;
	readonly createdAt: number;
	/** Last prompt or creation, in ms since the epoch. */
	readonly updatedAt: number;
	/** The agent's ACP session, reopened with `session/load` in a later window. */
	readonly sessionId?: string;
	/** What the agent's edits add up to, for its row before it is opened. */
	readonly changes?: ChangeTotals;
	/**
	 * The agent's own branch and folder, when it works in a worktree instead of the workspace folder.
	 * For a thread in several repositories, the thread's own folder (not a repository), which holds `repos`.
	 */
	readonly worktree?: AgentWorktree;
	/** A project thread in several repositories: each one's worktree, inside `worktree.folder`. */
	readonly repos?: readonly ThreadRepo[];
	/** Its part in a project (Projects preview): the project's coordinator, or one of its threads. */
	readonly project?: AgentProjectRole;
	/** The last checks run on the agent's branch, in a line, for Open Merge Request's attachment; kept across restarts. */
	readonly checks?: { readonly summary: string; readonly at: number };
}

/** One repository's worktree in a thread that works in several. */
export interface ThreadRepo extends RepoWorktree {
	/** Merged back into its repository: done, and its worktree removed. */
	readonly merged?: boolean;
}

export type AgentProjectRole =
	| {
		readonly role: 'coordinator';
		/** The model the user picked in the project chat; unset, the coordinator runs on Flash (`coordinatorModel`). */
		readonly model?: string;
	}
	| {
		readonly role: 'thread';
		/** The coordinator agent's id. */
		readonly coordinator: string;
		/** Started by the coordinator, rather than by the user. */
		readonly byCoordinator: boolean;
		readonly planFirst?: boolean;
		/** The Conductor track its brief came from. */
		readonly track?: string;
		/** Merged back: the thread's work is done, and it takes no more unless the user reopens it. */
		readonly resolved?: boolean;
		/** When it was merged back, in ms since the epoch; a week on, it is archived (`isArchived`). */
		readonly resolvedAt?: number;
	};

export interface AgentsSnapshot {
	readonly workspaces: readonly WorkspaceRecord[];
	readonly agents: readonly AgentRecord[];
}

const maxTitleLength = 48;

/** How many of a project's open threads start with it: the most recently used. The rest start when needed. */
export const warmThreadCount = 6;
/** How long a merged thread stays in the project's list before it moves under Archived. */
export const archiveAfterMs = 7 * 24 * 60 * 60 * 1000;

/** The threads to start as their project opens: open ones, most recently used first, `limit` at most. */
export function warmThreads(threads: readonly AgentRecord[], limit = warmThreadCount): string[] {
	return threads
		.filter(thread => thread.project?.role === 'thread' && !thread.project.resolved)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, limit)
		.map(thread => thread.id);
}

/**
 * A thread merged back over a week ago: listed under Archived, and never
 * started until the user opens it. Its chat, branch and record all stay.
 */
export function isArchived(record: AgentRecord, now: number): boolean {
	const project = record.project;
	return project?.role === 'thread' && !!project.resolved && (project.resolvedAt ?? record.updatedAt) <= now - archiveAfterMs;
}

/** When a thread was merged back: kept since this version, else its last use. */
export function resolvedAt(record: AgentRecord): number {
	return record.project?.role === 'thread' ? record.project.resolvedAt ?? record.updatedAt : record.updatedAt;
}

/** `base`, or `base 2`, `base 3`... when `taken` has it, as a new project is named after its repository. */
export function freeTitle(base: string, taken: ReadonlySet<string>): string {
	let title = base;
	for (let n = 2; taken.has(title); n++) {
		title = `${base} ${n}`;
	}
	return title;
}

/** A short title from a prompt's first line. */
export function titleFromPrompt(text: string): string | undefined {
	const line = text.split('\n').map(l => l.trim()).find(Boolean)?.replace(/\s+/g, ' ');
	if (!line) {
		return undefined;
	}
	return line.length > maxTitleLength ? `${line.slice(0, maxTitleLength - 1).trimEnd()}…` : line;
}

function sameFolder(a: string, b: string): boolean {
	const normalize = (p: string) => {
		const resolved = path.resolve(p);
		return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
	};
	return normalize(a) === normalize(b);
}

export class AgentsModel {

	private readonly onDidChangeEmitter = new Emitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	private _workspaces: WorkspaceRecord[];
	private _agents: AgentRecord[];

	constructor(snapshot: AgentsSnapshot = { workspaces: [], agents: [] }, private readonly now: () => number = Date.now) {
		this._workspaces = (snapshot.workspaces ?? []).filter(isWorkspaceRecord);
		const ids = new Set(this._workspaces.map(w => w.id));
		this._agents = (snapshot.agents ?? []).filter(a => isAgentRecord(a) && ids.has(a.workspaceId));
	}

	get workspaces(): readonly WorkspaceRecord[] {
		return this._workspaces;
	}

	workspace(id: string): WorkspaceRecord | undefined {
		return this._workspaces.find(w => w.id === id);
	}

	workspaceFor(folder: string): WorkspaceRecord | undefined {
		return this._workspaces.find(w => sameFolder(w.folder, folder));
	}

	agent(id: string): AgentRecord | undefined {
		return this._agents.find(a => a.id === id);
	}

	/** A workspace's agents, most recently used first. */
	agentsIn(workspaceId: string): readonly AgentRecord[] {
		return this._agents.filter(a => a.workspaceId === workspaceId).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** Adds a folder, or returns the workspace that already has it. */
	addWorkspace(folder: string): WorkspaceRecord {
		const existing = this.workspaceFor(folder);
		if (existing) {
			return existing;
		}
		const workspace: WorkspaceRecord = { id: randomUUID(), folder: path.resolve(folder) };
		this._workspaces = [...this._workspaces, workspace];
		this.changed();
		return workspace;
	}

	/** Removes a workspace and its agents; returns the agents removed. */
	removeWorkspace(id: string): readonly AgentRecord[] {
		const removed = this._agents.filter(a => a.workspaceId === id);
		this._workspaces = this._workspaces.filter(w => w.id !== id);
		this._agents = this._agents.filter(a => a.workspaceId !== id);
		this.changed();
		return removed;
	}

	/** `id` is one chosen ahead, such as the one a session was opened for before the agent existed; it must be unused. */
	addAgent(workspaceId: string, title: string, worktree?: AgentWorktree, id: string = randomUUID(), project?: AgentProjectRole): AgentRecord {
		if (!this.workspace(workspaceId)) {
			throw new Error(`Unknown workspace ${workspaceId}`);
		}
		if (this.agent(id)) {
			throw new Error(`Agent ${id} already exists`);
		}
		const now = this.now();
		const agent: AgentRecord = { id, workspaceId, title, createdAt: now, updatedAt: now, ...(worktree ? { worktree } : {}), ...(project ? { project } : {}) };
		this._agents = [...this._agents, agent];
		this.changed();
		return agent;
	}

	rename(id: string, title: string): void {
		this.update(id, a => ({ ...a, title, titleSetByUser: true }));
	}

	/** Marks a prompt: bumps the agent to the top and names it after its first prompt. */
	recordPrompt(id: string, text: string): void {
		this.update(id, a => {
			const title = !a.titleSetByUser && a.createdAt === a.updatedAt ? titleFromPrompt(text) : undefined;
			return { ...a, title: title ?? a.title, updatedAt: Math.max(this.now(), a.updatedAt + 1) };
		});
	}

	/** A saved session was reopened in the agent: it takes that session's title, unless the user named the agent. */
	recordRestore(id: string, title: string): void {
		this.update(id, a => ({ ...a, title: a.titleSetByUser ? a.title : titleFromPrompt(title) ?? a.title, updatedAt: Math.max(this.now(), a.updatedAt + 1) }));
	}

	setSessionId(id: string, sessionId: string): void {
		if (this.agent(id)?.sessionId !== sessionId) {
			this.update(id, a => ({ ...a, sessionId }));
		}
	}

	setChanges(id: string, changes: ChangeTotals): void {
		const current = this.agent(id)?.changes;
		const same = current
			? current.files === changes.files && current.added === changes.added && current.removed === changes.removed
			: !changes.files;
		if (!same) {
			this.update(id, a => {
				const { changes: _, ...rest } = a;
				return changes.files ? { ...rest, changes } : rest;
			});
		}
	}

	/** A multi-repository thread's repositories changed: one was added or merged. */
	setRepos(id: string, repos: readonly ThreadRepo[]): void {
		this.update(id, a => ({ ...a, repos }));
	}

	/** Keeps the last checks' result on the agent's record. */
	setChecks(id: string, summary: string): void {
		this.update(id, a => ({ ...a, checks: { summary, at: this.now() } }));
	}

	/** Keeps the model the user picked in a project's chat, so the coordinator reopens on it. */
	setCoordinatorModel(id: string, model: string): void {
		const project = this.agent(id)?.project;
		if (project?.role === 'coordinator' && project.model !== model) {
			this.update(id, a => ({ ...a, project: { ...project, model } }));
		}
	}

	/** Marks a project's thread resolved (merged back) or open again. */
	setThreadResolved(id: string, resolved: boolean): void {
		const project = this.agent(id)?.project;
		if (project?.role !== 'thread' || !!project.resolved === resolved) {
			return;
		}
		const { resolved: _, resolvedAt: __, ...rest } = project;
		this.update(id, a => ({ ...a, project: resolved ? { ...rest, resolved: true, resolvedAt: this.now() } : rest }));
	}

	/** A project's threads, oldest first. */
	threadsOf(coordinatorId: string): readonly AgentRecord[] {
		return this._agents.filter(a => a.project?.role === 'thread' && a.project.coordinator === coordinatorId).sort((a, b) => a.createdAt - b.createdAt);
	}

	/** The project `agent` belongs to: its coordinator, when that still exists. */
	coordinatorOf(agent: AgentRecord): AgentRecord | undefined {
		const id = agent.project?.role === 'thread' ? agent.project.coordinator : agent.project?.role === 'coordinator' ? agent.id : undefined;
		const coordinator = id === undefined ? undefined : this.agent(id);
		return coordinator?.project?.role === 'coordinator' ? coordinator : undefined;
	}

	/** Where the agent runs: its worktree, else its workspace's folder. */
	folderOf(agent: AgentRecord): string | undefined {
		return agent.worktree?.cwd ?? this.workspace(agent.workspaceId)?.folder;
	}

	removeAgent(id: string): void {
		this._agents = this._agents.filter(a => a.id !== id);
		this.changed();
	}

	snapshot(): AgentsSnapshot {
		return { workspaces: this._workspaces, agents: this._agents };
	}

	dispose(): void {
		this.onDidChangeEmitter.dispose();
	}

	private update(id: string, change: (agent: AgentRecord) => AgentRecord): void {
		const index = this._agents.findIndex(a => a.id === id);
		if (index < 0) {
			return;
		}
		this._agents = this._agents.map((agent, i) => i === index ? change(agent) : agent);
		this.changed();
	}

	private changed(): void {
		this.onDidChangeEmitter.fire();
	}
}

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
	const w = value as WorkspaceRecord;
	return typeof w?.id === 'string' && typeof w.folder === 'string' && path.isAbsolute(w.folder);
}

function isAgentRecord(value: unknown): value is AgentRecord {
	const a = value as AgentRecord;
	return typeof a?.id === 'string' && typeof a.workspaceId === 'string' && typeof a.title === 'string'
		&& typeof a.createdAt === 'number' && typeof a.updatedAt === 'number'
		&& (a.worktree === undefined || (typeof a.worktree.folder === 'string' && typeof a.worktree.cwd === 'string' && typeof a.worktree.branch === 'string' && typeof a.worktree.base === 'string'))
		&& (a.repos === undefined || (Array.isArray(a.repos) && a.repos.every(r => typeof r?.key === 'string' && typeof r.folder === 'string' && typeof r.repository === 'string' && typeof r.branch === 'string')))
		&& (a.project === undefined || (a.project.role === 'coordinator' && (a.project.model === undefined || typeof a.project.model === 'string')) || (a.project.role === 'thread' && typeof a.project.coordinator === 'string'));
}
