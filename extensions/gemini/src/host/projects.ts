/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Projects (preview, `gemini.projects.enabled`): a coordinator agent whose
// chat is the project chat, and threads that do the work, each an agent on a
// new branch in its own worktree. The extension host plays the platform: the
// coordinator's chat sends what the user writes to a ProjectHub, which wakes
// the coordinator (on a named Flash model) with the threads' state, and the
// `geminicode-project` MCP server gives it start_thread, message_thread and
// post, and each thread a report tool. Threads show as cards in the project
// chat that update in place. Approvals stay in the thread that asked.
// Nothing here runs until a project's coordinator starts.

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import type { AgentProjectRole, AgentRecord } from '../acp/agents';
import { attachmentLabel, type Attachment } from '../acp/attachments';
import { ConductorReader } from '../acp/conductor';
import type { InstantAnswer } from '../acp/permissions';
import { ProjectHub, type ThreadRequest } from '../acp/projectHub';
import { coordinatorTools, isProjectToolCall, isProjectToolTitle, ProjectMcpServer, threadTools, type ProjectCaller } from '../acp/projectMcp';
import type { McpToolResult } from '../acp/browserMcp';
import type { ChatActivity, ChatController, ChatProject } from './chatController';
import type { ThreadAction } from './chatProtocol';
import { configSection } from './configuration';

/** What Projects needs from the Agents pane. */
export interface ProjectAgents {
	record(id: string): AgentRecord | undefined;
	/** The folder of the agent's workspace: the project's repository. */
	workspaceFolder(id: string): string | undefined;
	threadsOf(coordinatorId: string): readonly AgentRecord[];
	/** The agent's chat, starting its session (without a tab) if it has none. */
	controller(id: string): ChatController | undefined;
	activity(id: string): ChatActivity | undefined;
	startThread(coordinatorId: string, request: ThreadRequest): Promise<string>;
	open(id: string): Promise<void>;
	stopTurn(id: string): void;
	mergeBack(id: string): Promise<boolean>;
	openChanges(id: string): Promise<void>;
	/** Asks, then removes the thread with its folder and branch; returns whether it did. */
	undoThread(id: string): Promise<boolean>;
}

export function projectsEnabled(): boolean {
	return vscode.workspace.getConfiguration(configSection).get<boolean>('projects.enabled', false);
}

/** One open project: its hub, and what the threads are doing. */
interface LiveProject {
	readonly hub: ProjectHub;
	readonly coordinator: ChatController;
	/** Threads that called report in the turn now running. */
	readonly reported: Set<string>;
	/** Notes for threads that were busy, sent when their turn ends. */
	readonly queued: Map<string, string[]>;
	/** Threads whose current turn is their plan (Plan first). */
	readonly planning: Set<string>;
	readonly merged: Set<string>;
	readonly removed: Set<string>;
	readonly disposables: vscode.Disposable[];
}

export class Projects implements vscode.Disposable {

	private server: ProjectMcpServer | undefined;
	private readonly projects = new Map<string, LiveProject>();

	constructor(private readonly agents: ProjectAgents, private readonly version: string) { }

	/** Starts the MCP server; a project agent's session must not open before it listens. */
	async ready(): Promise<void> {
		this.server ??= new ProjectMcpServer({ call: (caller, name, args) => this.call(caller, name, args) }, this.version);
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
			if (isProjectToolCall(request, coordinatorTools)) {
				return allow && { optionId: allow.optionId, quiet: true };
			}
			const reject = request.options.find(option => option.kind === 'reject_once') ?? request.options.find(option => option.kind.startsWith('reject'));
			return reject && { optionId: reject.optionId, label: vscode.l10n.t("Refused: the coordinator starts a thread for this") };
		}
		if (record.project?.role === 'thread' && isProjectToolCall(request, threadTools)) {
			return allow && { optionId: allow.optionId, quiet: true };
		}
		return undefined;
	}

	/** What makes the coordinator's chat the project chat. */
	chatProject(coordinatorId: string): ChatProject {
		return {
			post: (text, attachments) => this.projects.get(coordinatorId)?.hub.post(withAttachments(text, attachments)),
			hidesToolCall: title => isProjectToolTitle(title, coordinatorTools),
			threadAction: (thread, action) => void this.threadAction(coordinatorId, thread, action),
			newThread: () => void this.newThread(coordinatorId),
		};
	}

	/** A project agent started: a coordinator opens its project, a thread joins its own. */
	attach(record: AgentRecord): void {
		if (record.project?.role === 'coordinator') {
			this.openProject(record);
		}
	}

	/** A project agent's session stopped in this window. */
	detach(id: string): void {
		const project = this.projects.get(id);
		if (project) {
			this.projects.delete(id);
			vscode.Disposable.from(...project.disposables).dispose();
			project.hub.dispose();
		}
	}

	/** A thread's chat changed what it is doing. */
	threadActivity(record: AgentRecord, before: ChatActivity, after: ChatActivity): void {
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

	/** A thread's files changed: its card shows the new counts. */
	threadChanged(record: AgentRecord): void {
		const project = record.project?.role === 'thread' ? this.projects.get(record.project.coordinator) : undefined;
		if (project) {
			this.showCard(project, record.id);
		}
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
		const hub = new ProjectHub(record.id, { prompt: text => coordinator.sendUnseen(text) }, {
			start: request => this.agents.startThread(record.id, request),
			message: (thread, text) => this.message(record.id, thread, text),
			read: (thread, last) => this.read(thread, last),
		}, {
			conductor: () => conductor.read(),
			trackBrief: track => conductor.trackBrief(track),
		});
		// A coordinator reopened with its history already has the role brief.
		hub.setBriefed(!!record.sessionId);
		const project: LiveProject = {
			hub, coordinator,
			reported: new Set(), queued: new Map(), planning: new Set(), merged: new Set(), removed: new Set(),
			disposables: [],
		};
		for (const thread of this.agents.threadsOf(record.id)) {
			if (thread.project?.role === 'thread') {
				hub.restoreThread({ id: thread.id, title: thread.title, state: 'done', byCoordinator: thread.project.byCoordinator });
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
		);
		this.projects.set(record.id, project);
	}

	private threadTurnEnded(project: LiveProject, record: AgentRecord): void {
		const { hub } = project;
		const controller = this.agents.controller(record.id);
		const planned = record.project?.role === 'thread' && !!record.project.planFirst && controller?.conversation.filter(item => item.kind === 'user').length === 1;
		if (planned) {
			hub.updateThread(record.id, { state: 'planned', detail: undefined });
		} else {
			hub.updateThread(record.id, { state: 'done', detail: undefined });
		}
		if (!project.reported.has(record.id) && !planned) {
			// Ending a turn without a report still tells the coordinator.
			const said = lastReply(controller);
			hub.notify({ kind: 'report', thread: record.id, report: 'result', text: said ? `Finished its turn. It last said: ${said}` : 'Finished its turn without a reply.' });
		}
		project.reported.delete(record.id);
		const queued = project.queued.get(record.id);
		if (queued?.length && controller) {
			project.queued.delete(record.id);
			void controller.send(queued.join('\n\n'), [], 'coordinator');
		}
	}

	private message(coordinatorId: string, thread: string, text: string): void {
		const project = this.projects.get(coordinatorId);
		const controller = this.agents.controller(thread);
		if (!project || !controller) {
			return;
		}
		if (this.agents.activity(thread)?.busy) {
			project.queued.set(thread, [...project.queued.get(thread) ?? [], text]);
		} else {
			void controller.send(text, [], 'coordinator');
		}
	}

	private read(thread: string, last: number): string | undefined {
		const controller = this.agents.controller(thread);
		if (!controller) {
			return undefined;
		}
		return controller.conversation
			.flatMap(item => item.kind === 'user' ? [`User: ${item.text}`] : item.kind === 'agent' ? [`Thread: ${item.text}`] : [])
			.slice(-last)
			.join('\n\n');
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

	private showCard(project: LiveProject, thread: string): void {
		const record = this.agents.record(thread);
		const info = project.hub.threadList.find(t => t.id === thread);
		if (!record || !info) {
			return;
		}
		const role = record.project?.role === 'thread' ? record.project : undefined;
		project.coordinator.showThread({
			thread,
			title: record.title,
			state: info.state,
			...(info.detail ? { detail: info.detail } : {}),
			...(record.worktree ? { branch: record.worktree.branch } : {}),
			...(record.changes ? { changes: record.changes } : {}),
			startedAt: record.createdAt,
			...(role?.track ? { track: role.track } : {}),
			...(project.merged.has(thread) ? { merged: true } : {}),
			...(project.removed.has(thread) ? { removed: true } : {}),
		});
	}

	private async threadAction(coordinatorId: string, thread: string, action: ThreadAction): Promise<void> {
		const project = this.projects.get(coordinatorId);
		switch (action) {
			case 'open':
				return this.agents.open(thread);
			case 'stop':
				return this.agents.stopTurn(thread);
			case 'review':
				return this.agents.openChanges(thread);
			case 'merge':
				if (await this.agents.mergeBack(thread) && project) {
					project.merged.add(thread);
					this.showCard(project, thread);
				}
				return;
			case 'undo': {
				const record = this.agents.record(thread);
				if (project && record && await this.agents.undoThread(thread)) {
					project.removed.add(thread);
					project.coordinator.showThread({ thread, title: record.title, state: 'done', startedAt: record.createdAt, removed: true });
					project.hub.removeThread(thread);
				}
				return;
			}
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

	/** "New thread": the user starts one directly; the coordinator hears with its next wake. */
	private async newThread(coordinatorId: string): Promise<void> {
		const project = this.projects.get(coordinatorId);
		if (!project) {
			return;
		}
		const title = await vscode.window.showInputBox({
			title: vscode.l10n.t("New Thread"),
			prompt: vscode.l10n.t("A few words naming the work. The thread gets its own new branch and worktree."),
			validateInput: value => value.trim() ? undefined : vscode.l10n.t("Enter a title."),
		});
		if (!title?.trim()) {
			return;
		}
		const brief = await vscode.window.showInputBox({
			title: vscode.l10n.t("New Thread: {0}", title.trim()),
			prompt: vscode.l10n.t("What should it do? Say which files, and how to check the work."),
			validateInput: value => value.trim() ? undefined : vscode.l10n.t("Say what the thread should do."),
		});
		if (!brief?.trim()) {
			return;
		}
		const start = vscode.l10n.t("Start Now");
		const plan = vscode.l10n.t("Plan First");
		const pick = await vscode.window.showQuickPick([
			{ label: start, detail: vscode.l10n.t("The thread starts working right away.") },
			{ label: plan, detail: vscode.l10n.t("The thread writes a short plan and waits for your OK before changing files.") },
		], { title: vscode.l10n.t("New Thread: {0}", title.trim()) });
		if (!pick) {
			return;
		}
		try {
			await project.hub.startThread(title.trim(), brief.trim(), pick.label === plan);
		} catch (err) {
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not start the thread: {0}", err instanceof Error ? err.message : String(err)));
		}
	}
}

function callerOf(record: AgentRecord): ProjectCaller | undefined {
	const role: AgentProjectRole | undefined = record.project;
	return role?.role === 'coordinator' ? { role: 'coordinator', project: record.id }
		: role?.role === 'thread' ? { role: 'thread', project: role.coordinator, thread: record.id }
			: undefined;
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

