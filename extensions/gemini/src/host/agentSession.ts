/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { isModeAllowed } from '../acp/toolPolicy';
import { AgentClient, type AgentClientOptions } from '../acp/agentClient';
import { createFileHandlers, isInside } from '../acp/fileAccess';
import { PermissionBroker } from '../acp/permissions';
import { AgentStatus } from '../acp/status';
import { isTeamWriteToolCall } from '../acp/teamTools';
import { AgentService } from './agentService';
import { ChatHost } from './chatController';
import { getApprovalPolicy } from './configuration';
import { sessionModel, sessionModelList } from './modelPreference';
import { agentFileAccessPolicy, getFileAccessPolicy, WorkspaceFileSystem } from './workspaceFileSystem';

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
	/** `spare` lets a new session take the spare one (see `AgentClientOptions.spareKey`). */
	constructor(
		private readonly service: AgentService,
		readonly folder: string,
		resumeSessionId?: string,
		mcpServers?: () => readonly acp.McpServer[],
		openLater = false,
		spare?: Pick<AgentClientOptions, 'spareKey' | 'onDidOpenSession' | 'beforeOpen'>,
		/** Overrides the model each session switches to, such as a project coordinator's Flash model. */
		preferredModel?: AgentClientOptions['preferredModel'],
	) {
		const ownFiles = isInWorkspace(folder) ? undefined : createFileHandlers(new WorkspaceFileSystem(), () => agentFileAccessPolicy(folder), (...args) => service.writeGuard?.(...args));
		this.client = new AgentClient(service.runtime, {
			cwd: folder,
			resumeSessionId,
			openLater,
			mcpServers,
			...spare,
			preferredModel: preferredModel ?? sessionModel,
			modelList: sessionModelList,
			isModeAllowed: modeId => isModeAllowed(getApprovalPolicy(), modeId),
			alwaysAsks: isTeamWriteToolCall,
			onDidWriteFile: filePath => this.permissions.approvals.noteWrite(filePath),
			requestPermission: params => this.permissions.request(params),
			// A folder outside this window's workspace is the agent's only root.
			fileSystem: ownFiles,
			explainFileError: sessionId => (ownFiles ?? service.files).lastDenial(sessionId),
		});
		// Redirects into the agent's folders may be approved for the session; others always ask.
		this.permissions.roots = () => agentFileAccessPolicy(folder).roots;
		const fire = () => this.onDidChangeStatusEmitter.fire(this.status);
		this.disposables.push(
			this.onDidChangeStatusEmitter,
			service.onDidChangeStatus(fire),
			this.client.onDidChangeState(state => {
				// A request from a session that is gone can no longer be answered.
				if (state.kind !== 'ready') {
					this.permissions.cancelAll();
					// Session approvals end with the session.
					this.permissions.approvals.clear();
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

	ensureReady(signal?: AbortSignal): Promise<unknown> {
		return this.service.ensureReady(this.client, signal);
	}

	writeLog(message: string): void {
		this.service.writeLog(message);
	}

	askToTrust(folder: string): Promise<boolean> {
		return this.service.trust.ask(folder, { explicit: true });
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
