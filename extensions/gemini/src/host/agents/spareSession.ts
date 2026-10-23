/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The spare session: one session kept open ahead of the next agent, in the
// folder it most likely starts in, so starting it waits for no `session/new`.

import type * as acp from '@agentclientprotocol/sdk';
import type * as vscode from 'vscode';
import { supportedMcpServers } from '../../acp/agentClient';
import type { AgentService } from '../agentService';

/** How long after the agent is ready, or a spare was taken, to open the next spare: out of the way of the start itself. */
export const spareDelayMs = 1500;

/** The MCP servers a new agent's session gets, which a spare must match. */
export interface SpareServers {
	/** The servers a session opened ahead in `folder` gets now. */
	servers(folder: string): acp.McpServer[];
	/** Whether each of GeminiCode's servers (the browser's, the team tools', the index's) is serving. */
	serving(): readonly boolean[];
}

export class SpareSession implements vscode.Disposable {

	/** The folder the spare session is kept for, and the wait for the agent to be ready to open it. */
	private spare: { folder: string; waiting?: { dispose(): void }; timer?: ReturnType<typeof setTimeout> } | undefined;

	constructor(
		private readonly service: Pick<AgentService, 'runtime'>,
		private readonly servers: SpareServers,
	) { }

	/**
	 * Keeps a spare session open in `folder` for the next agent started there,
	 * such as while the user types a task on Agent Home, so starting it waits
	 * for no `session/new`. Every way of starting an agent takes it, and it is
	 * refilled once taken. One spare at a time: gemini-cli cannot close a
	 * session, so moving it to another folder leaves the old one in the agent.
	 */
	prepare(folder: string, delayMs = 0): void {
		if (this.spare?.folder !== folder) {
			this.dispose();
			this.spare = { folder };
		}
		const spare = this.spare;
		const runtime = this.service.runtime;
		const open = () => {
			if (this.spare !== spare || runtime.state.kind !== 'ready') {
				return;
			}
			const key = this.key(folder);
			if (runtime.spareKey === key) {
				return;
			}
			runtime.prepareSession(folder, supportedMcpServers(runtime.state.agent, this.servers.servers(folder)), key);
		};
		if (runtime.state.kind === 'ready') {
			clearTimeout(spare.timer);
			spare.timer = setTimeout(open, delayMs);
		}
		// Again whenever the agent restarts, since a spare belongs to the process that opened it.
		spare.waiting ??= runtime.onDidChangeState(state => {
			if (state.kind === 'ready') {
				clearTimeout(spare.timer);
				spare.timer = setTimeout(open, spareDelayMs);
			}
		});
	}

	/**
	 * Opens the spare again when the servers a new session would get change (a
	 * tool connected, the browser turned on or off), so the next agent in the
	 * folder still finds one that matches; the runtime closes the old one.
	 */
	refresh(): void {
		const spare = this.spare;
		if (spare && this.service.runtime.spareKey !== undefined && this.service.runtime.spareKey !== this.key(spare.folder)) {
			this.prepare(spare.folder, spareDelayMs);
		}
	}

	/** Matches a spare session to the agents that can take it: same folder, and the browser the same way. */
	key(folder: string): string {
		return JSON.stringify(['agent', folder, ...this.servers.serving()]);
	}

	/** Stops keeping a spare. */
	dispose(): void {
		this.spare?.waiting?.dispose();
		clearTimeout(this.spare?.timer);
		this.spare = undefined;
	}
}
