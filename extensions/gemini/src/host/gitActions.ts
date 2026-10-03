/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Branch switching and Create Branch & Commit for the chat, through the
// built-in git extension's API. The extension is only activated when the user
// picks one of these actions; showing the branch reads `.git/HEAD` instead
// (gitHead.ts).

import * as vscode from 'vscode';
import { isValidBranchName } from '../acp/branchNames';
import { errorMessage } from '../acp/errors';

/** The parts of the git extension's API (extensions/git/src/api/git.d.ts) used here. */
interface GitRef {
	readonly name?: string;
	readonly remote?: string;
}

interface GitRepository {
	readonly rootUri: vscode.Uri;
	readonly state: { readonly HEAD: GitRef | undefined };
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

/** Lets the user switch `folder`'s repository to another local branch or a new one. Resolves once done or dismissed. */
export async function pickBranch(folder: string): Promise<void> {
	const repository = await repositoryFor(folder);
	if (!repository) {
		return;
	}
	const current = repository.state.HEAD?.name;
	const create: vscode.QuickPickItem = { label: `$(add) ${vscode.l10n.t("Create New Branch...")}`, alwaysShow: true };
	const branches = (await repository.getBranches({ remote: false, sort: 'committerdate' })).flatMap(ref => ref.name ? [ref.name] : []);
	const items: vscode.QuickPickItem[] = [
		create,
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		...branches.map(name => ({ label: name, description: name === current ? vscode.l10n.t("current") : undefined })),
	];
	const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t("Switch branch") });
	try {
		if (picked === create) {
			const name = await askBranchName(undefined);
			if (name) {
				await repository.createBranch(name, true);
			}
		} else if (picked && picked.label !== current) {
			await repository.checkout(picked.label);
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
	readonly suggestedMessage: string;
}

/** Creates a branch from the current one, then commits `files` on it. Resolves `true` once committed. */
export async function createBranchAndCommit(request: CommitRequest): Promise<boolean> {
	const repository = await repositoryFor(request.folder);
	if (!repository) {
		return false;
	}
	const branch = await askBranchName(request.suggestedBranch);
	if (!branch) {
		return false;
	}
	const message = await vscode.window.showInputBox({
		title: vscode.l10n.t("Commit Message"),
		prompt: vscode.l10n.t("Commits {0} files the agent changed to {1}.", request.files.length, branch),
		value: request.suggestedMessage,
		validateInput: value => value.trim() ? undefined : vscode.l10n.t("Enter a commit message."),
	});
	if (!message?.trim()) {
		return false;
	}
	try {
		await repository.createBranch(branch, true);
		await repository.add([...request.files]);
		await repository.commit(message.trim());
		return true;
	} catch (err) {
		void vscode.window.showErrorMessage(errorMessage(err));
		return false;
	}
}

async function askBranchName(value: string | undefined): Promise<string | undefined> {
	const name = await vscode.window.showInputBox({
		title: vscode.l10n.t("New Branch"),
		value,
		validateInput: name => isValidBranchName(name.trim()) ? undefined : vscode.l10n.t("Enter a valid branch name."),
	});
	return name?.trim() || undefined;
}
