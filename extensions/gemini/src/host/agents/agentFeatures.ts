/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the Agents pane loads the first time it is needed: Merge Back's merge
// commits and Try in Workspace from dist/onDemand.js, Plan Review and the
// agents' Files pages from dist/pages.js. Each is made once, with what it
// asks of the pane, and disposed with the pane.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { agentFolder, AgentsModel } from '../../acp/agents';
import { writeCommitMessage } from '../../acp/commitMessage';
import { fileCommentsMessage, validComments } from '../../acp/fileComments';
import { inRepository } from '../../acp/worktrees';
import type { AgentsView } from '../agentsView';
import type { DiffPreview } from '../diffPreview';
import { agentColumn } from '../editorPlacement';
import { extensionChunk } from '../lazyFeature';
import type { Projects } from '../projects';
import type { AgentFilesPages } from '../agentFilesPage';
import type { PlanReviews } from '../planReviewPage';
import type { AgentMerge } from './agentMerge';
import type { AgentTries } from './agentTries';
import type { LiveAgent } from './agentStart';
import type { AgentTabs } from './agentTabs';

/** What the features loaded on demand ask of the Agents pane. */
export interface AgentFeaturesHost {
	readonly context: Pick<vscode.ExtensionContext, 'extensionUri' | 'workspaceState' | 'globalStorageUri' | 'globalState'>;
	readonly model: AgentsModel;
	/** The agents running in this window. */
	readonly live: ReadonlyMap<string, LiveAgent>;
	readonly projects: Pick<Projects, 'refreshThread' | 'setThreadKept'>;
	readonly diffPreview: Pick<DiffPreview, 'show'>;
	/** The pane's own surface the features call back into. */
	readonly view: Pick<AgentsView, 'open' | 'direct' | 'focusedSource'>;
	/** The pane's disposables, which a loaded feature joins. */
	readonly disposables: vscode.Disposable[];
	/** An agent started or ended a turn, for Plan Review. */
	readonly onDidChangeTurnEmitter: vscode.EventEmitter<string>;
	/** The agents' tabs: an agent's live chat, started without a tab when it has none in this window. */
	readonly tabs: Pick<AgentTabs, 'ensureLive'>;
	/** Removes the agent, its worktree folder and, with `deleteBranch`, its branch. */
	removeAgent(id: string, deleteBranch: boolean): Promise<void>;
	/** Redraws the list, or agent `id`'s row. */
	refresh(id?: string): void;
	log(message: string): void;
	/** Agent `id`'s try changed: the Changes panel's buttons follow it when it is in front. */
	tryChanged(id: string): void;
}

export class AgentFeatures {

	/** Merge Back's merge commits and Try in Workspace, from dist/onDemand.js once first needed. */
	readonly onDemand = extensionChunk<typeof import('../../onDemand')>('onDemand');
	private mergeLoaded: AgentMerge | undefined;
	private triesLoaded: AgentTries | undefined;
	/** Each tried agent's files the user edited and hasn't sent it, as AgentTries last said. */
	readonly triedEdits = new Map<string, readonly string[]>();
	/** Plan Review, from dist/pages.js the first time a plan is reviewed. */
	private readonly pages = extensionChunk<typeof import('../../pages')>('pages');
	private planReviewsLoaded: PlanReviews | undefined;
	private agentFilesLoaded: AgentFilesPages | undefined;

	constructor(private readonly host: AgentFeaturesHost) { }

	/** The agents' Files pages, when loaded. */
	get loadedAgentFiles(): AgentFilesPages | undefined {
		return this.agentFilesLoaded;
	}

	/** Merge Back, when loaded. */
	get loadedMerge(): AgentMerge | undefined {
		return this.mergeLoaded;
	}

	get agentFiles(): AgentFilesPages {
		if (!this.agentFilesLoaded) {
			this.agentFilesLoaded = new (this.pages().AgentFilesPages)({
				extensionUri: this.host.context.extensionUri,
				state: this.host.context.workspaceState,
				folder: id => {
					const record = this.host.model.agent(id);
					const workspace = record && this.host.model.workspace(record.workspaceId);
					return record && workspace ? agentFolder(record, workspace.folder) : undefined;
				},
				column: async id => {
					const live = this.host.live.get(id);
					return live ? agentColumn(id, live.panel) : vscode.ViewColumn.Active;
				},
				search: (id, query, limit) => this.host.live.get(id)?.files.search(query, limit) ?? Promise.resolve([]),
			});
			this.host.disposables.push(this.agentFilesLoaded);
		}
		return this.agentFilesLoaded;
	}

	get planReviews(): PlanReviews {
		if (!this.planReviewsLoaded) {
			this.planReviewsLoaded = new (this.pages().PlanReviews)({
				extensionUri: this.host.context.extensionUri,
				storageFolder: vscode.Uri.joinPath(this.host.context.globalStorageUri, 'planReviews').fsPath,
				globalState: this.host.context.globalState,
				title: id => this.host.model.agent(id)?.title,
				column: async id => {
					const live = this.host.live.get(id);
					return live ? agentColumn(id, live.panel) : vscode.ViewColumn.Active;
				},
				busy: id => !!this.host.live.get(id)?.activity.busy,
				canBuild: id => !!this.host.live.get(id)?.controller.canBuildPlan,
				// Waits for a running turn, as a queued message does; resolves once the message's own turn is over.
				send: (id, text) => new Promise<boolean>((settle, reject) => {
					const live = this.host.tabs.ensureLive(id);
					if (live) {
						live.controller.send(text, [], undefined, 'queue', { settle }).catch(reject);
					} else {
						settle(false);
					}
				}),
				build: async (id, text) => !!await this.host.live.get(id)?.controller.buildLatestPlan(text),
				showDiff: async (id, file, before) => {
					const now = await fs.promises.readFile(file, 'utf8').catch(() => '');
					const live = this.host.live.get(id);
					await this.host.diffPreview.show({ path: file, oldText: before, newText: now }, live ? { viewColumn: await agentColumn(id, live.panel) } : {});
				},
				onDidChangeAgent: this.host.onDidChangeTurnEmitter.event,
			});
			// The emitter is the pane's, disposed with it, not only once Plan Review has loaded.
			this.host.disposables.push(this.planReviewsLoaded);
		}
		return this.planReviewsLoaded;
	}

	/**
	 * Opens `file`, a Markdown file agent `id` wrote, beside its chat in the
	 * rich Markdown editor, where the user edits it in place and comments on it
	 * for the agent (the workbench's geminiMarkdownComments.ts takes the
	 * comments). False when the editor can't open, for the caller's fallback.
	 */
	async openMarkdown(id: string, file: string, preserveFocus: boolean): Promise<boolean> {
		const uri = vscode.Uri.file(file);
		const live = this.host.live.get(id);
		const viewColumn = live ? await agentColumn(id, live.panel) : vscode.ViewColumn.Active;
		// GeminiCode's workbench takes comments on the file from now on; outside it the editor has none.
		await Promise.resolve(vscode.commands.executeCommand('_gemini.markdownComments.allow', uri.toString(), id)).catch(() => undefined);
		try {
			await vscode.commands.executeCommand('vscode.openWith', uri, 'vscode.markdown.editor', { viewColumn, preserveFocus, preview: true });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * The comments the user left on a Markdown file agent `agent` wrote, from
	 * the workbench (`_gemini.sendFileComments`), as one message to that agent,
	 * after a running turn. The user's unsaved edits are saved first, so the
	 * agent revises what the user sees. Resolves whether the message reached
	 * the agent; when it didn't, the workbench puts the comments back.
	 */
	async sendFileComments(args: unknown): Promise<boolean> {
		const { agent, file, comments } = (args ?? {}) as { agent?: unknown; file?: unknown; comments?: unknown };
		const valid = validComments(comments);
		if (typeof agent !== 'string' || typeof file !== 'string' || !path.isAbsolute(file) || !valid.length) {
			return false;
		}
		const name = path.basename(file);
		if (!this.host.model.agent(agent)) {
			void vscode.window.showWarningMessage(vscode.l10n.t("The agent that wrote {0} was removed, so there's no one to send your comments to. They're back on the file.", name));
			return false;
		}
		let text = '';
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
			if (document.isDirty) {
				await document.save();
			}
			text = document.getText();
		} catch {
			// A file that is gone still gets the comments, without quotes.
		}
		const message = fileCommentsMessage(name, text, valid, {
			intro: vscode.l10n.t("Revise {0} using my comments. Change only what they ask for, and keep any edits I made to it."),
			comments: vscode.l10n.t("Comments:"),
			onText: vscode.l10n.t("On \"{0}\" (line {1})"),
			onLine: vscode.l10n.t("At line {0}"),
		});
		const live = message ? this.host.tabs.ensureLive(agent) : undefined;
		if (!message || !live) {
			return false;
		}
		// Waits for a running turn, as Plan Review's comments do; resolves once the message's own turn is over.
		const sent = await new Promise<boolean>(settle => live.controller.send(message, [], undefined, 'queue', { settle }).catch(() => settle(false)));
		if (!sent) {
			void vscode.window.showWarningMessage(vscode.l10n.t("Your comments on {0} didn't go to Gemini: the turn before them was stopped or failed, or the message was taken out of the queue. They're back on the file: send them again when you're ready.", name));
		}
		return sent;
	}

	get merge(): AgentMerge {
		return this.mergeLoaded ??= new (this.onDemand().AgentMerge)(this.host.model, this.host.live, (id, deleteBranch) => this.host.removeAgent(id, deleteBranch), inRepository, folder => writeCommitMessage(folder, undefined, this.host.view.direct),
			// Take Back and Merge: tried work leaves the checkout quietly before the merge.
			id => this.tries.takeBack(id, true));
	}

	get tries(): AgentTries {
		if (!this.triesLoaded) {
			const host = this.host;
			this.triesLoaded = new (this.onDemand().AgentTries)({
				model: host.model,
				inRepository,
				// Not while the chat copies the edits for its own turn ("Include your edits"), busy so nothing else starts.
				busy: id => !!host.live.get(id)?.activity.busy && !host.live.get(id)?.controller.includingEdits,
				tell: (id, text) => host.tabs.ensureLive(id)?.controller.addContext(text),
				changed: id => {
					host.projects.refreshThread(id);
					host.refresh(id);
					// The Changes panel's buttons follow the agent's try.
					host.tryChanged(id);
				},
				open: id => host.view.open(id),
				log: message => host.log(message),
				postEdits: (id, files) => {
					if (files.length) {
						this.triedEdits.set(id, files);
					} else {
						this.triedEdits.delete(id);
					}
					host.live.get(id)?.controller.setTriedEdits(files);
					host.projects.refreshThread(id);
				},
				setResolved: (id, resolved) => {
					if (host.model.agent(id)?.project?.role === 'thread') {
						host.projects.setThreadKept(id, resolved);
					} else {
						host.model.setResolved(id, resolved ? 'kept' : undefined);
					}
				},
			});
			host.disposables.push(this.triesLoaded);
		}
		return this.triesLoaded;
	}
}
