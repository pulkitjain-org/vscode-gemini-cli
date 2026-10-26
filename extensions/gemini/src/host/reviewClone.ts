/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// When no clone of a merge request's project was found among the user's
// folders: one question, where their copy is. Choose Folder... checks the
// folder; Clone It... clones with the user's own git credentials, through
// VS Code's git extension (its progress and its credential prompts), or in a
// terminal where git can ask. An agent's shell is never used to sign in.

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FoundClone } from '../acp/cloneSearch';
import type { GitLabClient } from '../acp/gitlab';
import { tildify } from './displayText';

/** What GeminiCode uses of the git extension's API (extensions/git/src/api/git.d.ts). */
interface GitCloneApi {
	clone?(uri: vscode.Uri, options: { readonly parentPath?: vscode.Uri; readonly postCloneAction?: 'none' }): Promise<vscode.Uri | null>;
}

/**
 * Asks where the user's clone of `project` is, for the review of merge
 * request `iid`: a folder they choose, which `check` confirms is a clone,
 * or a new clone. Undefined when they cancel.
 */
export async function askForClone(project: string, iid: number, gitlab: GitLabClient, check: (folder: string) => Promise<FoundClone | undefined>): Promise<FoundClone | undefined> {
	const choose = vscode.l10n.t("Choose Folder...");
	const cloneIt = vscode.l10n.t("Clone It...");
	const detail = [
		vscode.l10n.t("Reviewing !{0} checks its branch out from a local clone of the repository. GeminiCode didn't find one among your folders.", iid),
		vscode.l10n.t("GeminiCode remembers the clone for this project. The review runs in a separate checkout that is never trusted, so nothing in the merge request runs on this Mac."),
	].join('\n\n');
	const answer = await vscode.window.showInformationMessage(vscode.l10n.t("Where is your copy of {0}?", project), { modal: true, detail }, choose, cloneIt);
	if (answer === choose) {
		return chooseClone(project, choose, check);
	}
	return answer === cloneIt ? cloneProject(project, gitlab, check) : undefined;
}

async function chooseClone(project: string, choose: string, check: (folder: string) => Promise<FoundClone | undefined>): Promise<FoundClone | undefined> {
	for (; ;) {
		const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: vscode.l10n.t("Use This Clone"), title: vscode.l10n.t("Your Clone of {0}", project) });
		const folder = picked?.[0]?.fsPath;
		if (!folder) {
			return undefined;
		}
		const found = await check(folder);
		if (found) {
			return found;
		}
		if (await vscode.window.showWarningMessage(vscode.l10n.t("{0} isn't a clone of {1}.", tildify(folder), project), { modal: true }, choose) !== choose) {
			return undefined;
		}
	}
}

async function cloneProject(project: string, gitlab: GitLabClient, check: (folder: string) => Promise<FoundClone | undefined>): Promise<FoundClone | undefined> {
	const home = vscode.workspace.getConfiguration('git').get<string>('defaultCloneDirectory')?.replace(/^~(?=$|\/)/, os.homedir()) || os.homedir();
	const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.Uri.file(home), openLabel: vscode.l10n.t("Clone Here"), title: vscode.l10n.t("Where Should {0} Be Cloned?", project) });
	const parent = picked?.[0];
	if (!parent) {
		return undefined;
	}
	const urls = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Reading {0}...", project) }, () => gitlab.cloneUrls(project));
	// HTTPS first: git's credential helper or the git extension's prompt signs in; SSH needs a key set up beforehand.
	const url = urls.http ?? urls.ssh;
	if (!url) {
		throw new Error(vscode.l10n.t("GitLab gave no clone URL for {0}.", project));
	}
	const folder = await cloneWithGit(url, parent, project);
	if (!folder) {
		return undefined;
	}
	const found = await check(folder);
	if (!found) {
		throw new Error(vscode.l10n.t("{0} isn't a clone of {1}.", tildify(folder), project));
	}
	return found;
}

/** Clones `url` into `parent`; the new clone's folder, or undefined when cancelled. */
async function cloneWithGit(url: string, parent: vscode.Uri, project: string): Promise<string | undefined> {
	const extension = vscode.extensions.getExtension<{ readonly enabled: boolean; getAPI(version: 1): GitCloneApi }>('vscode.git');
	const exports = extension && (extension.isActive ? extension.exports : await extension.activate().then(e => e, () => undefined));
	const api = exports?.enabled ? exports.getAPI(1) : undefined;
	if (api?.clone) {
		return (await api.clone(vscode.Uri.parse(url), { parentPath: parent, postCloneAction: 'none' }))?.fsPath;
	}
	// Without the git extension: git in a terminal, where it can ask for a username, password or passphrase.
	const target = path.join(parent.fsPath, project.split('/').pop() || 'repository');
	const terminal = vscode.window.createTerminal({
		name: vscode.l10n.t("Clone {0}", project), cwd: parent.fsPath, shellPath: 'git', shellArgs: ['clone', '--progress', url, target],
		message: vscode.l10n.t("Cloning {0} into {1}. Answer git's questions here; close the terminal if it stops with an error.", project, tildify(target)),
	});
	terminal.show();
	const code = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Cloning {0}...", project) }, () => new Promise<number | undefined>(resolve => {
		const listener = vscode.window.onDidCloseTerminal(closed => {
			if (closed === terminal) {
				listener.dispose();
				resolve(closed.exitStatus?.code);
			}
		});
	}));
	return code === 0 ? target : undefined;
}
