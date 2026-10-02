/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Agents pane's model (plan Phase 2B, agents-pane): workspaces the user
// added, and the agents under each. Names follow upstream's Agents Window
// (workspace, session) so the pane can move onto it later. Plain data, so
// the host can persist it as JSON.

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Emitter } from './events';

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
}

export interface AgentsSnapshot {
	readonly workspaces: readonly WorkspaceRecord[];
	readonly agents: readonly AgentRecord[];
}

const maxTitleLength = 48;

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

	addAgent(workspaceId: string, title: string): AgentRecord {
		if (!this.workspace(workspaceId)) {
			throw new Error(`Unknown workspace ${workspaceId}`);
		}
		const now = this.now();
		const agent: AgentRecord = { id: randomUUID(), workspaceId, title, createdAt: now, updatedAt: now };
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
		&& typeof a.createdAt === 'number' && typeof a.updatedAt === 'number';
}
