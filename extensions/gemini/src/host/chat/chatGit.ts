/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The composer's git controls: the branch pill and its menu, the workspace
// pill and its menu (one per repository in a project's chat), Commit to the
// branch the folder is on (with a message box the commit message generator
// fills) or Create Branch & Commit on the default branch, the review chip and
// Open Merge Request. The branch is read again whenever it may have changed: a
// turn started or ended, the window got the focus, or the agent's files
// changed. Which branch is the default, whether the repository has a commit and
// whether the folder is trusted (for the mode menu's Auto Edit tag) are read
// at most once a minute.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { recommendedMode } from '../../acp/chatTurns';
import { readGitHead } from '../../acp/gitHead';
import { foldersTrusted } from '../../acp/trustedFolders';
import type { FromWebview, ToWebview } from '../chatProtocol';
import { relativeTime, tildify } from '../displayText';
import { commitToCurrentBranch, createBranchAndCommit, defaultBranch, hasCommits, localBranches, switchBranch } from '../gitActions';
import type { ChatControllerOptions } from './chatOptions';

export type GitMessage = Extract<FromWebview, { readonly type: 'listBranches' | 'switchBranch' | 'createBranchAndCommit' | 'writeCommitMessage' | 'commitToBranch' | 'workspaceAction' | 'openReview' | 'openMergeRequest' }>;

/** How long the repository's default branch, first commit and the folder's trust are trusted before they are read again. */
const repoFactsMs = 60_000;

interface RepoFacts {
	readonly folder: string;
	readonly at: number;
	readonly facts: Promise<{ readonly defaultBranch?: string; readonly committed: boolean; readonly trusted: boolean }>;
}

export class ChatGitControls implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private repoFacts: RepoFacts | undefined;
	/** The commit box's message, being written; asked for again only when the box opens again. */
	private writing: Promise<string | undefined> | undefined;

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
			case 'writeCommitMessage':
				void this.writeMessage();
				break;
			case 'commitToBranch':
				void this.commitToBranch(typeof message.message === 'string' ? message.message : '');
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
		if (await createBranchAndCommit({ folder, files, suggestedBranch: suggestion.branch, suggestedMessage: suggestion.message, writeMessage: suggestion.writeMessage })) {
			commit.committed();
		}
		this.refresh();
	}

	/** The commit box opened: writes a message from the agent's changes, as Source Control's ✨ does; the box shows the agent's name when none can be written. */
	private async writeMessage(): Promise<void> {
		const commit = this.options.git?.commit;
		if (!commit) {
			return;
		}
		const suggestion = commit.suggestion();
		const writing = this.writing = (suggestion.writeMessage?.() ?? Promise.resolve(undefined)).catch(() => undefined);
		const written = await writing;
		if (this.writing === writing) {
			this.writing = undefined;
			this.post({ type: 'commitMessage', message: written ?? suggestion.message });
		}
	}

	/** The commit box's Commit: the agent's files, to the branch the folder is on, with the message the user edited. */
	private async commitToBranch(message: string): Promise<void> {
		const folder = this.options.git?.folder();
		const commit = this.options.git?.commit;
		const files = commit?.files() ?? [];
		let ok = false;
		if (folder && commit && files.length && message.trim() && !this.isBusy()) {
			ok = await commitToCurrentBranch({ folder, files, suggestedMessage: message, message });
			if (ok) {
				commit.committed();
			}
		}
		this.post({ type: 'commitDone', ok });
		this.refresh();
	}

	/** The default branch, first commit and trust of `folder`, read again after a minute. */
	private factsOf(folder: string): RepoFacts['facts'] {
		const known = this.repoFacts;
		if (known?.folder === folder && Date.now() - known.at < repoFactsMs) {
			return known.facts;
		}
		const facts = Promise.all([
			defaultBranch(folder),
			hasCommits(folder),
			foldersTrusted([folder], process.env).catch(() => false),
		]).then(([branch, committed, trusted]) => ({ ...branch ? { defaultBranch: branch } : {}, committed, trusted: trusted && vscode.workspace.isTrusted }));
		this.repoFacts = { folder, at: Date.now(), facts };
		return facts;
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
		void (folder ? readGitHead(folder).catch(() => undefined) : Promise.resolve(undefined)).then(async branch => {
			const facts = folder && branch ? await this.factsOf(folder).catch(() => undefined) : undefined;
			// A short commit id: detached, so there is no branch to commit to.
			const commitTo = canCommit && branch && facts && branch !== facts.defaultBranch && !/^[0-9a-f]{7}$/.test(branch) ? branch : undefined;
			const recommendMode = facts && recommendedMode(facts);
			this.post({ type: 'git', git: { branch, canCommit, ...commitTo ? { commitTo } : {}, ...recommendMode ? { recommendMode } : {}, ...(workspace ? { workspace } : {}), ...(review ? { review } : {}) } });
		});
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
