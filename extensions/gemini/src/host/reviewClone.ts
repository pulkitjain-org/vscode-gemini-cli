/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The local clone a merge request's review or fix checks its branch out from:
// looked for among the user's folders (cloneSearch.ts), and when none is a
// clone, one question, where their copy is. Choose Folder... checks the
// folder; Clone It... clones with the user's own git credentials, over HTTPS
// or SSH, through VS Code's git extension (its progress and its credential
// prompts), or in a terminal where git can ask. An agent's shell is never
// used to sign in. In dist/onDemand.js: only a review or a fix needs it.

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { cloneUrlChoices, type CloneProbe, type CloneStage, findClone, type FoundClone, locateClone, recentFolders, RememberedClones } from '../acp/cloneSearch';
import type { GitLabClient } from '../acp/gitlab';
import { tildify } from './displayText';

/** What GeminiCode uses of the git extension's API (extensions/git/src/api/git.d.ts). */
interface GitCloneApi {
	clone?(uri: vscode.Uri, options: { readonly parentPath?: vscode.Uri; readonly postCloneAction?: 'none' }): Promise<vscode.Uri | null>;
}

/** The merge request a clone is wanted for, and what for: the question says so. */
export interface CloneAsk {
	readonly iid: number;
	readonly purpose: 'review' | 'fix';
}

/** The scheme last cloned with, by GitLab. */
const schemeKey = 'gemini.team.cloneScheme';

/**
 * A clone of `project`: the one remembered for it, else the first among the
 * window's folders, `agentFolders` and VS Code's recent folders, else, with
 * `ask`, the folder the user chooses or clones. What is found or chosen is
 * remembered. Undefined when there is none, or the user cancelled.
 */
export async function cloneFor(project: string, gitlab: GitLabClient, state: vscode.Memento | undefined, agentFolders: CloneStage, probe: CloneProbe, ask?: CloneAsk): Promise<FoundClone | undefined> {
	const memory = new RememberedClones(state, gitlab.url);
	const found = await locateClone(project, memory, [
		() => (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath),
		agentFolders,
		async () => recentFolders(await vscode.commands.executeCommand('_workbench.getRecentlyOpened')),
	], probe, path.join(os.homedir(), '.geminicode'));
	if (found || !ask) {
		return found;
	}
	const chosen = await askForClone(project, ask, gitlab, state, folder => findClone(project, [() => [folder]], probe));
	if (chosen) {
		await memory.set(project, chosen.folder);
	}
	return chosen;
}

/**
 * Asks where the user's clone of `project` is, for `ask`'s merge request: a
 * folder they choose, which `check` confirms is a clone, or a new clone.
 * Undefined when they cancel.
 */
async function askForClone(project: string, ask: CloneAsk, gitlab: GitLabClient, state: vscode.Memento | undefined, check: (folder: string) => Promise<FoundClone | undefined>): Promise<FoundClone | undefined> {
	const choose = vscode.l10n.t("Choose Folder...");
	const cloneIt = vscode.l10n.t("Clone It...");
	const detail = ask.purpose === 'review' ? [
		vscode.l10n.t("Reviewing !{0} checks its branch out from a local clone of the repository. GeminiCode didn't find one among your folders.", ask.iid),
		vscode.l10n.t("GeminiCode remembers the clone for this project. The review runs in a separate checkout that is never trusted, so nothing in the merge request runs on this Mac."),
	] : [
		vscode.l10n.t("Fixing !{0} checks its branch out from a local clone of the repository. GeminiCode didn't find one among your folders.", ask.iid),
		vscode.l10n.t("GeminiCode remembers the clone for this project. The fix works on the merge request's branch in a checkout of its own, and GeminiCode pushes it when the agent is done."),
	];
	const answer = await vscode.window.showInformationMessage(vscode.l10n.t("Where is your copy of {0}?", project), { modal: true, detail: detail.join('\n\n') }, choose, cloneIt);
	if (answer === choose) {
		return chooseClone(project, choose, check);
	}
	return answer === cloneIt ? cloneProject(project, gitlab, state, check) : undefined;
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

async function cloneProject(project: string, gitlab: GitLabClient, state: vscode.Memento | undefined, check: (folder: string) => Promise<FoundClone | undefined>): Promise<FoundClone | undefined> {
	const urls = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Reading {0}...", project) }, () => gitlab.cloneUrls(project));
	const schemes = state?.get<Record<string, string>>(schemeKey) ?? {};
	const choices = cloneUrlChoices(urls, schemes[gitlab.url]);
	if (!choices.length) {
		throw new Error(vscode.l10n.t("GitLab gave no clone URL for {0}.", project));
	}
	// Both: the user picks, the one used last on top; one alone needs no question.
	const picked = choices.length === 1 ? choices[0] : (await vscode.window.showQuickPick(choices.map(choice => ({
		label: choice.scheme === 'https' ? vscode.l10n.t("Clone over HTTPS") : vscode.l10n.t("Clone over SSH"),
		detail: choice.scheme === 'https' ? vscode.l10n.t("Signs in with your git credentials, as VS Code asks for them.") : vscode.l10n.t("Uses the SSH key you added to GitLab."),
		description: choice.url,
		choice,
	})), { title: vscode.l10n.t("Clone {0}", project), placeHolder: vscode.l10n.t("How should git reach GitLab?") }))?.choice;
	if (!picked) {
		return undefined;
	}
	const home = vscode.workspace.getConfiguration('git').get<string>('defaultCloneDirectory')?.replace(/^~(?=$|\/)/, os.homedir()) || os.homedir();
	const parent = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.Uri.file(home), openLabel: vscode.l10n.t("Clone Here"), title: vscode.l10n.t("Where Should {0} Be Cloned?", project) }))?.[0];
	if (!parent) {
		return undefined;
	}
	await state?.update(schemeKey, { ...schemes, [gitlab.url]: picked.scheme });
	const folder = await cloneWithGit(picked.url, parent, project);
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
