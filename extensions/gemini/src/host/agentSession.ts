/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { isModeAllowed } from '../acp/adminPolicy';
import { AgentClient } from '../acp/agentClient';
import { createFileHandlers, isInside } from '../acp/fileAccess';
import { PermissionBroker } from '../acp/permissions';
import { AgentStatus } from '../acp/status';
import { AgentService } from './agentService';
import { ChatHost } from './chatController';
import { getApprovalPolicy } from './configuration';
import { sessionModel } from './modelPreference';
import { getFileAccessPolicy, isIgnoredByGitCached, WorkspaceFileSystem } from './workspaceFileSystem';

/**
 * One agent from the Agents pane: its own ACP session, in its workspace's
 * folder, on the shared agent process, with its own permission requests.
 */
export class AgentSession implements ChatHost, vscode.Disposable {

	readonly client: AgentClient;
	readonly permissions = new PermissionBroker();
	private readonly disposables: vscode.Disposable[] = [];

	private readonly onDidChangeStatusEmitter = new vscode.EventEmitter<AgentStatus>();
	readonly onDidChangeStatus = this.onDidChangeStatusEmitter.event;

	/** `mcpServers` are the servers GeminiCode serves this agent, such as its browser. */
	/** With `openLater`, the session opens on `open()` (see `AgentClientOptions.openLater`). */
	constructor(private readonly service: AgentService, readonly folder: string, resumeSessionId?: string, mcpServers?: () => readonly acp.McpServer[], openLater = false) {
		this.client = new AgentClient(service.runtime, {
			cwd: folder,
			resumeSessionId,
			openLater,
			mcpServers,
			preferredModel: sessionModel,
			isModeAllowed: modeId => isModeAllowed(getApprovalPolicy(), modeId),
			requestPermission: params => this.permissions.request(params),
			// A folder outside this window's workspace is the agent's only root.
			fileSystem: isInWorkspace(folder) ? undefined : createFileHandlers(new WorkspaceFileSystem(), () => ({ roots: [folder], isIgnored: isIgnoredByGitCached })),
		});
		const fire = () => this.onDidChangeStatusEmitter.fire(this.status);
		this.disposables.push(
			this.onDidChangeStatusEmitter,
			service.onDidChangeStatus(fire),
			this.client.onDidChangeState(state => {
				// A request from a session that is gone can no longer be answered.
				if (state.kind !== 'ready') {
					this.permissions.cancelAll();
				}
				fire();
			}),
		);
	}

	get status(): AgentStatus {
		return this.service.statusFor(this.client);
	}

	open(): void {
		this.client.open();
	}

	ensureReady(): Promise<unknown> {
		return this.service.ensureReady(this.client);
	}

	trustFolder(folder: string): boolean {
		return this.service.trustFolder(folder);
	}

	async cancel(): Promise<void> {
		this.permissions.cancelAll();
		await this.client.cancel();
	}

	dispose(): void {
		this.permissions.dispose();
		this.client.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

function isInWorkspace(folder: string): boolean {
	return getFileAccessPolicy().roots.some(root => isInside(root, folder));
}
