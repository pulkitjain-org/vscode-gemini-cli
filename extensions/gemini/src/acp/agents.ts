/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Agents pane's model: workspaces the user added, and the agents under
// each. Names follow upstream's Agents Window (workspace, session) so the pane
// can move onto it later. Plain data, so the host can persist it as JSON.

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ChangeTotals } from './agentChanges';
import { Emitter } from './events';
import { isRecord, samePath } from './fsUtil';
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
	/** Its part in a project: the project's coordinator, or one of its threads. */
	readonly project?: AgentProjectRole;
	/** The last checks run on the agent's branch, in a line, for Open Merge Request's attachment; kept across restarts. */
	readonly checks?: { readonly summary: string; readonly at: number };
	/** The agent this one was forked from (Fork Agent), which it is listed under. */
	readonly forkedFrom?: AgentFork;
}

/** Where a forked agent came from. */
export interface AgentFork {
	/** The parent agent's id; it may have been removed since. */
	readonly agent: string;
	/** When it was forked, in ms since the epoch. */
	readonly at: number;
	/**
	 * The folder it shares with its parent, when it works there rather than
	 * on a branch of its own: the parent's worktree, which it does not own,
	 * so it never merges or removes it.
	 */
	readonly sharedFolder?: string;
}

/** Where an agent works: its worktree, the folder it shares with the agent it was forked from, else its workspace's folder. */
export function agentFolder(record: AgentRecord, workspaceFolder: string): string {
	return record.worktree?.cwd ?? record.forkedFrom?.sharedFolder ?? workspaceFolder;
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

/**
 * The list as saved. Version 2 keeps records this version doesn't recognise,
 * such as a newer version's, as they are (`AgentsModel.stored`); a snapshot
 * without a version is read the same way.
 */
export interface AgentsSnapshot {
	readonly version?: number;
	readonly workspaces: readonly WorkspaceRecord[];
	readonly agents: readonly AgentRecord[];
}

export const agentsSnapshotVersion = 2;

/** A saved record as it is, whether or not this version recognises it; its other fields are kept as they are. */
export interface SavedRecord {
	readonly id: string;
}

/** The whole list as saved, the records this version doesn't recognise included. */
export interface StoredAgents {
	readonly version: number;
	readonly workspaces: readonly SavedRecord[];
	readonly agents: readonly SavedRecord[];
}

/** Records another window added, changed or removed, by list. */
export interface AgentsChange {
	readonly workspaces?: { readonly upserted: readonly SavedRecord[]; readonly removed: readonly string[] };
	readonly agents?: { readonly upserted: readonly SavedRecord[]; readonly removed: readonly string[] };
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

/** The threads merged back, archived or not: their work is in the repository, so their checkpoints can go. */
export function mergedThreads(records: readonly AgentRecord[]): string[] {
	return records.filter(record => record.project?.role === 'thread' && !!record.project.resolved).map(record => record.id);
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

export class AgentsModel {

	private readonly onDidChangeEmitter = new Emitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	private _workspaces: WorkspaceRecord[] = [];
	private _agents: AgentRecord[] = [];
	/**
	 * Saved records this version doesn't recognise, such as a newer version's,
	 * or an agent whose workspace isn't here (yet): kept as they are and saved
	 * back, never dropped.
	 */
	private otherWorkspaces: SavedRecord[] = [];
	private otherAgents: SavedRecord[] = [];

	constructor(snapshot: AgentsSnapshot | StoredAgents = { workspaces: [], agents: [] }, private readonly now: () => number = Date.now) {
		this.take(snapshot.workspaces ?? [], snapshot.agents ?? []);
	}

	get workspaces(): readonly WorkspaceRecord[] {
		return this._workspaces;
	}

	workspace(id: string): WorkspaceRecord | undefined {
		return this._workspaces.find(w => w.id === id);
	}

	workspaceFor(folder: string): WorkspaceRecord | undefined {
		return this._workspaces.find(w => samePath(w.folder, folder));
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
		this.otherAgents = this.otherAgents.filter(a => (a as { readonly workspaceId?: unknown }).workspaceId !== id);
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

	/**
	 * Adds an agent forked from `fork.agent`, in its parent's workspace, already
	 * on session `sessionId` when it has one; `project` makes a fork of a
	 * project's thread a thread of that project.
	 */
	addFork(parent: AgentRecord, title: string, fork: Omit<AgentFork, 'agent' | 'at'>, worktree?: AgentWorktree, sessionId?: string, project?: AgentProjectRole): AgentRecord {
		const agent = this.addAgent(parent.workspaceId, title, worktree, undefined, project);
		// Named in the Fork dialog, so the first prompt doesn't rename it.
		this.update(agent.id, a => ({ ...a, titleSetByUser: true, forkedFrom: { agent: parent.id, at: this.now(), ...fork }, ...(sessionId ? { sessionId } : {}) }));
		return this.agent(agent.id)!;
	}

	/** The agents forked from `id` that are still here, oldest first. */
	forksOf(id: string): readonly AgentRecord[] {
		return this._agents.filter(a => a.forkedFrom?.agent === id).sort((a, b) => a.createdAt - b.createdAt);
	}

	/** The agent `record` was forked from, when it is still here. */
	parentOf(record: AgentRecord): AgentRecord | undefined {
		return record.forkedFrom ? this.agent(record.forkedFrom.agent) : undefined;
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
		const workspace = this.workspace(agent.workspaceId);
		return workspace && agentFolder(agent, workspace.folder);
	}

	removeAgent(id: string): void {
		this._agents = this._agents.filter(a => a.id !== id);
		this.changed();
	}

	/** The records this version recognises. */
	snapshot(): AgentsSnapshot {
		return { version: agentsSnapshotVersion, workspaces: this._workspaces, agents: this._agents };
	}

	/** Every record, those this version doesn't recognise included, to save. */
	stored(): StoredAgents {
		return {
			version: agentsSnapshotVersion,
			workspaces: this.otherWorkspaces.length ? [...this._workspaces, ...this.otherWorkspaces] : this._workspaces,
			agents: this.otherAgents.length ? [...this._agents, ...this.otherAgents] : this._agents,
		};
	}

	/**
	 * Takes in what another window added, changed or removed. A record changed
	 * here and not saved yet (`unsaved`) stays, unless theirs was used later;
	 * a removal always wins. Returns the agents that went.
	 */
	applyExternal(change: AgentsChange, unsaved: (record: SavedRecord) => boolean = () => false): readonly AgentRecord[] {
		const stored = this.stored();
		const workspaces = mergeRecords(stored.workspaces, change.workspaces, unsaved);
		const agents = mergeRecords(stored.agents, change.agents, unsaved);
		if (workspaces === stored.workspaces && agents === stored.agents) {
			return [];
		}
		const before = this._agents;
		this.take(workspaces, agents);
		const ids = new Set(this._agents.map(a => a.id));
		this.changed();
		return before.filter(a => !ids.has(a.id));
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

	/** Sorts saved records into those this version shows and the others, which it keeps. */
	private take(workspaces: readonly unknown[], agents: readonly unknown[]): void {
		this._workspaces = [];
		this.otherWorkspaces = [];
		for (const workspace of workspaces) {
			if (isWorkspaceRecord(workspace)) {
				this._workspaces.push(workspace);
			} else if (hasId(workspace)) {
				this.otherWorkspaces.push(workspace);
			}
		}
		const ids = new Set(this._workspaces.map(w => w.id));
		this._agents = [];
		this.otherAgents = [];
		for (const agent of agents) {
			if (isAgentRecord(agent) && ids.has(agent.workspaceId)) {
				this._agents.push(agent);
			} else if (hasId(agent)) {
				this.otherAgents.push(agent);
			}
		}
	}
}

/** `records` with `change` taken in; the same array when nothing changed. */
function mergeRecords(records: readonly SavedRecord[], change: { readonly upserted: readonly SavedRecord[]; readonly removed: readonly string[] } | undefined, unsaved: (record: SavedRecord) => boolean): readonly SavedRecord[] {
	if (!change || (!change.upserted.length && !change.removed.length)) {
		return records;
	}
	const removed = new Set(change.removed);
	const merged = removed.size ? records.filter(record => !removed.has(record.id)) : [...records];
	let changed = merged.length !== records.length;
	const index = new Map(merged.map((record, i) => [record.id, i]));
	for (const theirs of change.upserted) {
		const at = index.get(theirs.id);
		if (at === undefined) {
			index.set(theirs.id, merged.length);
			merged.push(theirs);
			changed = true;
			continue;
		}
		const ours = merged[at];
		if (ours === theirs || (unsaved(ours) && !(updatedAt(theirs) > updatedAt(ours)))) {
			continue;
		}
		merged[at] = theirs;
		changed = true;
	}
	return changed ? merged : records;
}

function updatedAt(record: SavedRecord): number {
	const value = (record as { readonly updatedAt?: unknown }).updatedAt;
	return typeof value === 'number' ? value : 0;
}

function hasId(value: unknown): value is SavedRecord {
	return isRecord(value) && typeof value.id === 'string';
}

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
	const w = value as WorkspaceRecord;
	return typeof w?.id === 'string' && typeof w.folder === 'string' && path.isAbsolute(w.folder);
}

/** Whether this version can show `value`; it ignores fields it doesn't know, and the model keeps a record it can't show (`stored`). */
function isAgentRecord(value: unknown): value is AgentRecord {
	const a = value as AgentRecord;
	return typeof a?.id === 'string' && typeof a.workspaceId === 'string' && typeof a.title === 'string'
		&& typeof a.createdAt === 'number' && typeof a.updatedAt === 'number'
		&& (a.worktree === undefined || (typeof a.worktree.folder === 'string' && typeof a.worktree.cwd === 'string' && typeof a.worktree.branch === 'string' && typeof a.worktree.base === 'string'))
		&& (a.repos === undefined || (Array.isArray(a.repos) && a.repos.every(r => typeof r?.key === 'string' && typeof r.folder === 'string' && typeof r.repository === 'string' && typeof r.branch === 'string')))
		&& (a.forkedFrom === undefined || (typeof a.forkedFrom.agent === 'string' && typeof a.forkedFrom.at === 'number' && (a.forkedFrom.sharedFolder === undefined || (typeof a.forkedFrom.sharedFolder === 'string' && path.isAbsolute(a.forkedFrom.sharedFolder)))))
		&& (a.project === undefined || (a.project.role === 'coordinator' && (a.project.model === undefined || typeof a.project.model === 'string')) || (a.project.role === 'thread' && typeof a.project.coordinator === 'string'));
}
