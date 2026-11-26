/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the Agents pane lists under a workspace: its projects, its own agents
// and the agents the user archived. Threads go under their project and forks
// under the agent they were forked from, so neither is listed here.

import { AgentRecord, AgentsModel, isArchived } from './agents';

export interface WorkspaceRows {
	/** The workspace's projects (coordinators), newest first; none while Projects are off. */
	readonly projects: readonly AgentRecord[];
	/** Its own agents, most recently used first. */
	readonly agents: readonly AgentRecord[];
	/** Its agents the user archived, most recently archived first, unless they run in this window. */
	readonly archived: readonly AgentRecord[];
}

export interface WorkspaceRowOptions {
	/** Whether Projects are on: off, a coordinator and its threads are plain agents. */
	readonly projects: boolean;
	/** Whether agent `id` runs in this window: an archived one that does stays in the list. */
	readonly live: (id: string) => boolean;
	readonly now: number;
}

/** The rows under workspace `workspaceId`, grouped as the pane shows them. */
export function workspaceRows(model: AgentsModel, workspaceId: string, options: WorkspaceRowOptions): WorkspaceRows {
	const { projects, live, now } = options;
	const all = model.agentsIn(workspaceId);
	const coordinators = projects ? [...all].filter(record => record.project?.role === 'coordinator').sort((a, b) => b.createdAt - a.createdAt) : [];
	const own = all.filter(record => {
		if (record.project?.role === 'thread') {
			return !projects || !model.coordinatorOf(record);
		}
		if (record.project?.role === 'coordinator' && projects) {
			return false;
		}
		const parent = model.parentOf(record);
		return !parent || !!parent.project;
	});
	const archivedOf = (record: AgentRecord) => record.archivedAt !== undefined && isArchived(record, now) && !live(record.id);
	return {
		projects: coordinators,
		agents: own.filter(record => !archivedOf(record)),
		archived: own.filter(archivedOf).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
	};
}
