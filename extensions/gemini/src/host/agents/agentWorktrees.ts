/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agents' own branches: making a worktree (asking for its branch, or naming
// it free), running the repository's setup script in it, adding worktrees one
// at a time per repository (the one git lock, `inRepository`), and putting
// back folders Clean Up removed. A repository's own setup script runs only
// once the user allowed its content (`setupCommandFor`).

import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRecord, AgentsModel } from '../../acp/agents';
import { isValidBranchName } from '../../acp/branchNames';
import { errorMessage } from '../../acp/errors';
import { rememberSetupScript, scriptPreview, setupScriptConsent } from '../../acp/setupConsent';
import { AgentWorktree, branchExists, createWorktree, createWorktreeFrom, folderInRepository, freeBranchName, inRepository, mainRepository, pathExists, repositoryRoot, restoreWorktree, runWorktreeSetup, setupScriptFile, TurnQueue, worktreeSetup } from '../../acp/worktrees';
import { configSection } from '../configuration';
import { showError } from '../errorNotice';

/** The hashes of the repository setup scripts the user chose to run without asking again; this machine's only. */
const allowedScriptsKey = 'gemini.setupScripts.allowed';

/** The consent dialogs open now, by script hash, so threads started together ask once. */
const askingConsent = new Map<string, Promise<boolean>>();

/** What the setup is for, which the dialog says. */
export type SetupPurpose = 'agent' | 'checks';

/**
 * The setup command for a new worktree of `repository`: the
 * `gemini.agents.worktreeSetup` command as set, or the repository's
 * `.gemini/worktree-setup.sh` once the user allowed its content (asked the
 * first time, and again whenever it changes). None in an untrusted
 * workspace, or when the user chose Don't Run.
 */
export async function setupCommandFor(repository: string, state: vscode.Memento | undefined, purpose: SetupPurpose = 'agent'): Promise<string | undefined> {
	if (!vscode.workspace.isTrusted) {
		return undefined;
	}
	const setup = await worktreeSetup(repository, vscode.workspace.getConfiguration(configSection).get<string>('agents.worktreeSetup'));
	if (!setup?.script) {
		return setup?.command;
	}
	const allowed = state?.get<string[]>(allowedScriptsKey) ?? [];
	const consent = setupScriptConsent(setup.script.content, allowed);
	if (!consent.needed) {
		return setup.command;
	}
	let asking = askingConsent.get(consent.hash);
	if (!asking) {
		asking = askSetupConsent(repository, setup.script.content, purpose).then(async answer => {
			if (answer === 'remember') {
				await state?.update(allowedScriptsKey, rememberSetupScript(state.get<string[]>(allowedScriptsKey) ?? [], consent.hash));
			}
			return answer !== 'no';
		}).finally(() => askingConsent.delete(consent.hash));
		askingConsent.set(consent.hash, asking);
	}
	return await asking ? setup.command : undefined;
}

/** The dialog before a repository's setup script runs, with the script in it. */
async function askSetupConsent(repository: string, content: string, purpose: SetupPurpose): Promise<'no' | 'once' | 'remember'> {
	const name = path.basename(repository);
	const script = setupScriptFile.split(path.sep).join('/');
	const preview = scriptPreview(content);
	const detail = [
		purpose === 'checks'
			? vscode.l10n.t("Run Checks runs {0} from {1} in the branch's new checkout. It runs in your shell, with your permissions.", script, name)
			: vscode.l10n.t("New agents on their own branch run {0} from {1}. It runs in your shell, with your permissions.", script, name),
		preview.moreLines ? `${preview.text}
${vscode.l10n.t("({0} more lines)", preview.moreLines)}` : preview.text,
		vscode.l10n.t("GeminiCode asks again only if the script changes."),
	].join('\n\n');
	const no: vscode.MessageItem = { title: vscode.l10n.t("Don't Run"), isCloseAffordance: true };
	const once: vscode.MessageItem = { title: vscode.l10n.t("Run Once") };
	const remember: vscode.MessageItem = { title: vscode.l10n.t("Run and Remember") };
	const choice = await vscode.window.showWarningMessage(vscode.l10n.t("Run this repository's setup script?"), { modal: true, detail }, no, once, remember);
	return choice === remember ? 'remember' : choice === once ? 'once' : 'no';
}

export class AgentWorktrees implements vscode.Disposable {

	/** Work that takes turns under a key of its own, such as a project's multi-repository thread folders. */
	private readonly queue = new TurnQueue();
	/** Threads whose cleaned-up folders are being put back, so two callers share one `git worktree add`. */
	private readonly restoringFolders = new Map<string, Promise<boolean>>();
	/** Output of worktree setup scripts, made the first time one runs. */
	private setupOutput: vscode.OutputChannel | undefined;

	/** `state` keeps the setup scripts the user allowed (`setupCommandFor`). */
	constructor(private readonly model: AgentsModel, private readonly state?: vscode.Memento) { }

	/** Asks for a branch name and makes the agent's worktree; undefined when dismissed or failed (the failure is shown). */
	async ask(repository: string, folder: string): Promise<AgentWorktree | undefined> {
		const suggestion = `gemini/agent-${Math.random().toString(16).slice(2, 6)}`;
		const branch = await vscode.window.showInputBox({
			title: vscode.l10n.t("New Agent on Its Own Branch"),
			prompt: vscode.l10n.t("The agent works on this new branch, in its own copy of {0}. Merge Back brings its work into your branch.", path.basename(repository)),
			value: suggestion,
			valueSelection: [suggestion.indexOf('/') + 1, suggestion.length],
			validateInput: async value => {
				const name = value.trim();
				if (!isValidBranchName(name)) {
					return vscode.l10n.t("Enter a valid branch name.");
				}
				return await branchExists(repository, name) ? vscode.l10n.t("A branch named {0} already exists.", name) : undefined;
			},
		});
		if (!branch?.trim()) {
			return undefined;
		}
		try {
			return await this.make(repository, branch.trim(), folder);
		} catch (err) {
			void showError(vscode.l10n.t("Could not create the agent's branch: {0}", errorMessage(err)));
			return undefined;
		}
	}

	/**
	 * Makes the agent's worktree on a new branch named `named`, or a free name
	 * like it; undefined when `folder` is not in a Git repository or the
	 * worktree could not be made (the user has been told).
	 */
	async makeFree(folder: string, named: string): Promise<AgentWorktree | undefined> {
		const repository = await repositoryRoot(folder);
		if (!repository) {
			void showError(vscode.l10n.t("{0} is not in a Git repository, so the agent can't have its own branch.", path.basename(folder)));
			return undefined;
		}
		try {
			return await this.make(repository, named, folder, true);
		} catch (err) {
			void showError(vscode.l10n.t("Could not create the agent's branch: {0}", errorMessage(err)));
			return undefined;
		}
	}

	/**
	 * Makes the agent's worktree, then runs the repository's setup in it (`gemini.agents.worktreeSetup`,
	 * else `.gemini/worktree-setup.sh`), such as installing packages or copying .env. A failed setup is
	 * reported with its output, but the agent still starts: the branch is there either way.
	 * With `free`, `branch` is a name to start from: a free one like it is picked, in the same turn of
	 * the repository's git lock as the worktree is added, so two starts can't pick the same name.
	 */
	make(repository: string, branch: string, folder: string, free = false): Thenable<AgentWorktree> {
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Creating the agent's branch..."), cancellable: true }, async (progress, token) => {
			const subfolder = await folderInRepository(folder);
			const worktree = await inRepository(repository, async () => createWorktree(repository, free ? await freeBranchName([repository], branch) : branch, subfolder));
			const command = await this.setupCommand(repository);
			if (!command || token.isCancellationRequested) {
				return worktree;
			}
			progress.report({ message: vscode.l10n.t("Running the setup script...") });
			await this.runSetup(command, worktree, repository, worktree.branch, token);
			return worktree;
		});
	}

	/**
	 * Makes a fork's worktree on branch `branch` from what `parent` (its
	 * parent's folder) has checked out, with the parent's uncommitted changes,
	 * then runs the repository's setup in it, as {@link make} does. Rejects
	 * when it can't be made; nothing is left behind then.
	 */
	makeFrom(parent: string, branch: string): Thenable<AgentWorktree> {
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Creating the fork's branch {0}...", branch), cancellable: true }, async (progress, token) => {
			const repository = await mainRepository(parent);
			const subfolder = await folderInRepository(parent);
			const worktree = await inRepository(repository, () => createWorktreeFrom(parent, branch, subfolder));
			const command = await this.setupCommand(repository);
			if (!command || token.isCancellationRequested) {
				return worktree;
			}
			progress.report({ message: vscode.l10n.t("Running the setup script...") });
			await this.runSetup(command, worktree, repository, branch, token);
			return worktree;
		});
	}

	/** The repository's setup command for a new worktree, asking first for a repository's own script; none in an untrusted workspace. */
	setupCommand(repository: string): Promise<string | undefined> {
		return setupCommandFor(repository, this.state);
	}

	/**
	 * Runs the repository's setup in a thread's new worktree, behind a
	 * notification; resolves when it ends, however it ends. `command` is the
	 * one the caller already has, so the user isn't asked twice.
	 */
	async setUpThread(repository: string, worktree: AgentWorktree, command?: string): Promise<void> {
		command ??= await this.setupCommand(repository).catch(() => undefined);
		if (!command) {
			return;
		}
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Setting up the thread's branch {0}...", worktree.branch), cancellable: true },
			(_progress, token) => this.runSetup(command, worktree, repository, worktree.branch, token)).then(undefined, () => undefined);
	}

	/**
	 * Picks a free branch name and adds its worktree, in one turn of the
	 * repository's git lock: threads started together could otherwise pick the same name.
	 */
	async addThreadWorktree(repository: string, named: string, folder: string): Promise<AgentWorktree> {
		const subfolder = await folderInRepository(folder);
		return inRepository(repository, async () => createWorktree(repository, await freeBranchName([repository], named), subfolder));
	}

	/** Runs `task` once the last one queued under `key` has ended; for git work in a repository, use `inRepository`. */
	inTurn<T>(key: string, task: () => Promise<T>): Promise<T> {
		return this.queue.run(key, task);
	}

	/**
	 * Puts back the worktree folders Clean Up removed from a merged thread,
	 * from its branches; resolves whether the thread has a folder to run in.
	 */
	restoreFolder(id: string): Promise<boolean> {
		const pending = this.restoringFolders.get(id);
		if (pending) {
			return pending;
		}
		const restoring = (async () => {
			const record = this.model.agent(id);
			const workspace = record && this.model.workspace(record.workspaceId);
			if (!record || !workspace) {
				return false;
			}
			if (!record.worktree) {
				return true;
			}
			const trees = await this.threadWorktrees(record);
			const back = await Promise.all(trees.map(({ repository, worktree }) => restoreWorktree(repository, worktree).catch(() => false)));
			// A thread in several repositories runs in its own folder, which Clean Up keeps; any repository that came back is enough to work in.
			return record.repos?.length ? back.some(Boolean) && await pathExists(record.worktree.folder) : back.every(Boolean);
		})().finally(() => this.restoringFolders.delete(id));
		this.restoringFolders.set(id, restoring);
		return restoring;
	}

	/** Each Git worktree an agent works in, with the repository it belongs to. */
	async threadWorktrees(record: AgentRecord): Promise<{ readonly repository: string; readonly worktree: AgentWorktree }[]> {
		if (record.repos?.length) {
			return record.repos.map(repo => ({ repository: repo.repository, worktree: repo }));
		}
		const workspace = this.model.workspace(record.workspaceId);
		if (!record.worktree || !workspace) {
			return [];
		}
		return [{ repository: await repositoryRoot(workspace.folder) ?? workspace.folder, worktree: record.worktree }];
	}

	dispose(): void {
		this.setupOutput?.dispose();
	}

	/** Runs `command` in a new worktree, with its output in an output channel; a failure is reported, never thrown. */
	private async runSetup(command: string, worktree: AgentWorktree, repository: string, branch: string, token: vscode.CancellationToken): Promise<void> {
		this.setupOutput ??= vscode.window.createOutputChannel(vscode.l10n.t("Gemini Worktree Setup"));
		const output = this.setupOutput;
		output.appendLine(`$ ${command}    (${worktree.folder})`);
		const abort = new AbortController();
		const cancel = token.onCancellationRequested(() => abort.abort());
		const code = await runWorktreeSetup(command, worktree, repository, text => output.append(text), abort.signal).finally(() => cancel.dispose());
		output.appendLine(code === 0 ? '' : vscode.l10n.t("Exited with {0}.", code));
		if (code !== 0 && !token.isCancellationRequested) {
			const show = vscode.l10n.t("Show Output");
			void vscode.window.showWarningMessage(vscode.l10n.t("The setup script for {0} failed. The agent starts anyway.", branch), show).then(choice => choice === show && output.show());
		}
	}
}
