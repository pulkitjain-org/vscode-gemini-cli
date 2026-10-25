/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The composer's git controls: the branch pill and its menu, the workspace
// pill and its menu (one per repository in a project's chat), Create Branch &
// Commit, the review chip and Open Merge Request. The branch is read again
// whenever it may have changed: a turn started or ended, the window got the
// focus, or the agent's files changed.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { readGitHead } from '../../acp/gitHead';
import type { FromWebview, ToWebview } from '../chatProtocol';
import { relativeTime, tildify } from '../displayText';
import { createBranchAndCommit, localBranches, switchBranch } from '../gitActions';
import type { ChatControllerOptions } from './chatOptions';

export type GitMessage = Extract<FromWebview, { readonly type: 'listBranches' | 'switchBranch' | 'createBranchAndCommit' | 'workspaceAction' | 'openReview' | 'openMergeRequest' }>;

export class ChatGitControls implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly options: Pick<ChatControllerOptions, 'git' | 'workspace' | 'review' | 'openReview' | 'openMergeRequest'>,
		/** Whether a turn runs; meanwhile nothing can be committed. */
		private readonly isBusy: () => boolean,
		/** Whether a webview shows the chat. */
		private readonly isAttached: () => boolean,
		private readonly post: (message: ToWebview) => void,
	) {
		this.disposables.push(
			// The branch may have changed outside the editor.
			vscode.window.onDidChangeWindowState(state => state.focused && this.isAttached() && this.refresh()),
		);
		if (options.git?.commit) {
			this.disposables.push(options.git.commit.onDidChange(() => this.refresh()));
		}
	}

	onMessage(message: GitMessage): void {
		switch (message.type) {
			case 'listBranches':
				void this.postBranches();
				break;
			case 'switchBranch': {
				const folder = this.options.git?.folder();
				if (folder && !this.options.git?.ownBranch && typeof message.name === 'string') {
					void switchBranch(folder, message.name, !!message.create).finally(() => this.refresh());
				}
				break;
			}
			case 'createBranchAndCommit':
				void this.commit();
				break;
			case 'workspaceAction':
				void this.workspaceAction(message.action, typeof message.repo === 'string' ? message.repo : undefined);
				break;
			case 'openReview':
				this.options.openReview?.();
				break;
			case 'openMergeRequest':
				this.options.openMergeRequest?.();
				break;
		}
	}

	/** Commits the files the agent changed on a new branch, as the composer's Commit button does. */
	async commit(): Promise<void> {
		const folder = this.options.git?.folder();
		const commit = this.options.git?.commit;
		const files = commit?.files() ?? [];
		if (!folder || !commit || !files.length || this.isBusy()) {
			return;
		}
		const suggestion = commit.suggestion();
		if (await createBranchAndCommit({ folder, files, suggestedBranch: suggestion.branch, suggestedMessage: suggestion.message })) {
			commit.committed();
		}
		this.refresh();
	}

	/** Sends the branch and whether there is anything to commit; the branch is read from `.git/HEAD`, which is cheap. */
	refresh(): void {
		const git = this.options.git;
		const folder = git?.folder();
		if (!git || !this.isAttached()) {
			return;
		}
		const canCommit = !this.isBusy() && !!git.commit?.files().length;
		const ws = this.options.workspace?.();
		const workspace = ws && { name: path.basename(ws.folder) || ws.folder, path: tildify(ws.cwd), worktree: ws.worktree };
		const review = this.options.review?.();
		// Several repositories: each with its own branch, in place of one folder and branch.
		if (ws?.repos && ws.repos.length > 1) {
			void Promise.all(ws.repos.map(async repo => ({ name: repo.name, path: tildify(repo.folder), branch: await readGitHead(repo.folder).catch(() => undefined) })))
				.then(repos => this.post({ type: 'git', git: { canCommit: false, repos } }));
			return;
		}
		void (folder ? readGitHead(folder).catch(() => undefined) : Promise.resolve(undefined))
			.then(branch => this.post({ type: 'git', git: { branch, canCommit, ...(workspace ? { workspace } : {}), ...(review ? { review } : {}) } }));
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** The branch menu's list: the folder's local branches, or why this agent cannot switch. */
	private async postBranches(): Promise<void> {
		const ownBranch = this.options.git?.ownBranch;
		if (ownBranch) {
			this.post({ type: 'branches', branches: [], notice: vscode.l10n.t("This agent works on its own branch, {0}. Use Merge Back to bring its work into your branch.", ownBranch) });
			return;
		}
		const folder = this.options.git?.folder();
		const result = folder ? await localBranches(folder).catch(() => undefined) : undefined;
		const now = Date.now();
		this.post({
			type: 'branches',
			branches: (result?.branches ?? []).map(branch => ({
				name: branch.name,
				current: branch.name === result?.current,
				...(branch.committedAt ? { age: relativeTime(branch.committedAt, now) } : {}),
			})),
		});
	}

	/** What the folder menu offers. */
	private async workspaceAction(action: 'copyPath' | 'reveal' | 'showAgents' | 'addFolder', repo?: string): Promise<void> {
		if (action === 'addFolder') {
			return vscode.commands.executeCommand('workbench.action.addRootFolder');
		}
		const workspace = this.options.workspace?.();
		const folder = repo !== undefined ? workspace?.repos?.find(each => each.name === repo)?.folder : workspace?.cwd;
		if (!folder) {
			return;
		}
		switch (action) {
			case 'copyPath':
				return vscode.env.clipboard.writeText(folder);
			case 'reveal':
				return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folder));
			case 'showAgents':
				return vscode.commands.executeCommand('gemini.agents.focus');
		}
	}
}
