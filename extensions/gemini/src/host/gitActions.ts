/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Branch switching and Create Branch & Commit for the chat, through the
// built-in git extension's API. The extension is only activated when the user
// picks one of these actions; showing the branch reads `.git/HEAD` instead
// (gitHead.ts). Commit messages are written from the diff by the quick model,
// as Generate Commit Message writes them.

import * as vscode from 'vscode';
import { isValidBranchName } from '../acp/branchNames';
import { errorMessage } from '../acp/errors';

/** The parts of the git extension's API (extensions/git/src/api/git.d.ts) used here. */
interface GitRef {
	readonly name?: string;
	readonly remote?: string;
	readonly commitDetails?: { readonly commitDate?: Date };
}

interface GitRepository {
	readonly rootUri: vscode.Uri;
	readonly state: {
		readonly HEAD: GitRef | undefined;
		readonly indexChanges: readonly { readonly uri: vscode.Uri }[];
	};
	getBranches(query: { readonly remote?: boolean; readonly sort?: 'alphabetically' | 'committerdate' }): Promise<GitRef[]>;
	checkout(treeish: string): Promise<void>;
	createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
	add(paths: string[]): Promise<void>;
	commit(message: string): Promise<void>;
}

interface GitApi {
	openRepository(root: vscode.Uri): Promise<GitRepository | null>;
}

interface GitExtension {
	readonly enabled: boolean;
	getAPI(version: 1): GitApi;
}

async function repositoryFor(folder: string): Promise<GitRepository | undefined> {
	const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	const exports = extension && (extension.isActive ? extension.exports : await extension.activate());
	if (!exports?.enabled) {
		void vscode.window.showErrorMessage(vscode.l10n.t("Git is not available. Enable the Git extension (git.enabled) and try again."));
		return undefined;
	}
	const repository = await exports.getAPI(1).openRepository(vscode.Uri.file(folder));
	if (!repository) {
		void vscode.window.showErrorMessage(vscode.l10n.t("{0} is not in a Git repository.", folder));
	}
	return repository ?? undefined;
}

/** A local branch for the chat's branch menu. */
export interface LocalBranch {
	readonly name: string;
	/** When its last commit was made, in ms since the epoch, if the git extension says. */
	readonly committedAt?: number;
}

/** `folder`'s local branches, most recently committed first, and the current one. */
export async function localBranches(folder: string): Promise<{ readonly branches: readonly LocalBranch[]; readonly current?: string } | undefined> {
	const repository = await repositoryFor(folder);
	if (!repository) {
		return undefined;
	}
	const refs = await repository.getBranches({ remote: false, sort: 'committerdate' });
	return {
		current: repository.state.HEAD?.name,
		branches: refs.flatMap(ref => ref.name ? [{ name: ref.name, committedAt: ref.commitDetails?.commitDate?.getTime() }] : []),
	};
}

/** Switches `folder`'s repository to branch `name`, creating it from the current one when `create` is set. */
export async function switchBranch(folder: string, name: string, create: boolean): Promise<void> {
	const repository = await repositoryFor(folder);
	if (!repository) {
		return;
	}
	try {
		if (create) {
			await repository.createBranch(name, true);
		} else if (name !== repository.state.HEAD?.name) {
			await repository.checkout(name);
		}
	} catch (err) {
		void vscode.window.showErrorMessage(errorMessage(err));
	}
}

export interface CommitRequest {
	readonly folder: string;
	/** Absolute paths to stage and commit. */
	readonly files: readonly string[];
	readonly suggestedBranch: string;
	/** The message offered when none can be written from the changes. */
	readonly suggestedMessage: string;
	/** Writes a message from the changes (`writeCommitMessage`); undefined when it can't. */
	readonly writeMessage?: () => Promise<string | undefined>;
}

/** Creates a branch from the current one, then commits `files` on it. Resolves `true` once committed. */
export async function createBranchAndCommit(request: CommitRequest): Promise<boolean> {
	// Written while the user answers the questions before it.
	const written = request.writeMessage?.().catch(() => undefined);
	const repository = await repositoryFor(request.folder);
	if (!repository || !await confirmOtherStaged(repository, request.files)) {
		return false;
	}
	const branch = await askBranchName(request.suggestedBranch);
	if (!branch) {
		return false;
	}
	const message = await askCommitMessage(vscode.l10n.t("Commits {0} files the agent changed to {1}.", request.files.length, branch), await awaitCommitMessage(written, request.suggestedMessage));
	if (!message) {
		return false;
	}
	try {
		await repository.createBranch(branch, true);
	} catch (err) {
		void vscode.window.showErrorMessage(errorMessage(err));
		return false;
	}
	try {
		await repository.add([...request.files]);
		await repository.commit(message);
		return true;
	} catch (err) {
		void vscode.window.showErrorMessage(vscode.l10n.t("Created and switched to {0}, but could not commit: {1}", branch, errorMessage(err)));
		return false;
	}
}

/**
 * Commits `files` to the branch the folder has checked out, with a message
 * written from the changes for the user to edit. Resolves `true` once
 * committed. For a "Commit to {0}" choice beside Create Branch & Commit.
 */
export async function commitToCurrentBranch(request: Omit<CommitRequest, 'suggestedBranch'>): Promise<boolean> {
	const written = request.writeMessage?.().catch(() => undefined);
	const repository = await repositoryFor(request.folder);
	if (!repository || !await confirmOtherStaged(repository, request.files)) {
		return false;
	}
	const branch = repository.state.HEAD?.name;
	const prompt = branch
		? vscode.l10n.t("Commits {0} files the agent changed to {1}.", request.files.length, branch)
		: vscode.l10n.t("Commits {0} files the agent changed.", request.files.length);
	const message = await askCommitMessage(prompt, await awaitCommitMessage(written, request.suggestedMessage));
	if (!message) {
		return false;
	}
	try {
		await repository.add([...request.files]);
		await repository.commit(message);
		return true;
	} catch (err) {
		void vscode.window.showErrorMessage(vscode.l10n.t("Could not commit: {0}", errorMessage(err)));
		return false;
	}
}

/** The written message once it is ready, with a progress notification if that takes a moment; `fallback` when it can't be written or the user stops waiting. */
export async function awaitCommitMessage(written: Promise<string | undefined> | undefined, fallback: string): Promise<string> {
	if (!written) {
		return fallback;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const quick = await Promise.race([written, new Promise<null>(resolve => timer = setTimeout(() => resolve(null), 150))]).finally(() => clearTimeout(timer));
	if (quick !== null) {
		return quick || fallback;
	}
	const message = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Writing a commit message…"), cancellable: true }, (_progress, token) =>
		Promise.race([written, new Promise<undefined>(resolve => token.onCancellationRequested(() => resolve(undefined)))]));
	return message || fallback;
}

/** `commit` takes everything staged, so files the user staged would go too: asks first. */
async function confirmOtherStaged(repository: GitRepository, files: readonly string[]): Promise<boolean> {
	const agentFiles = new Set(files.map(file => vscode.Uri.file(file).fsPath));
	const otherStaged = repository.state.indexChanges.filter(change => !agentFiles.has(change.uri.fsPath)).length;
	if (!otherStaged) {
		return true;
	}
	const commitAnyway = vscode.l10n.t("Commit Anyway");
	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t("{0} other staged files will be committed too.", otherStaged),
		{ modal: true, detail: vscode.l10n.t("Unstage them first to commit only the agent's changes.") },
		commitAnyway);
	return choice === commitAnyway;
}

async function askCommitMessage(prompt: string, value: string): Promise<string | undefined> {
	const message = await vscode.window.showInputBox({
		title: vscode.l10n.t("Commit Message"),
		prompt,
		value,
		validateInput: value => value.trim() ? undefined : vscode.l10n.t("Enter a commit message."),
	});
	return message?.trim() || undefined;
}

async function askBranchName(value: string | undefined): Promise<string | undefined> {
	const name = await vscode.window.showInputBox({
		title: vscode.l10n.t("New Branch"),
		value,
		validateInput: name => isValidBranchName(name.trim()) ? undefined : vscode.l10n.t("Enter a valid branch name."),
	});
	return name?.trim() || undefined;
}
