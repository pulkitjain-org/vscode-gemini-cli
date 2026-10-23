/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agents' own branches: making a worktree (asking for its branch, or naming
// it free), running the repository's setup script in it, adding worktrees one
// at a time per repository, and putting back folders Clean Up removed.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRecord, AgentsModel } from '../../acp/agents';
import { isValidBranchName } from '../../acp/branchNames';
import { errorMessage } from '../../acp/errors';
import { AgentWorktree, branchExists, createWorktree, folderInRepository, freeBranchName, pathExists, repositoryRoot, restoreWorktree, runWorktreeSetup, TurnQueue, worktreeSetupCommand } from '../../acp/worktrees';
import { configSection } from '../configuration';

export class AgentWorktrees implements vscode.Disposable {

	/** The last worktree being added in each repository, so threads started together take turns. */
	private readonly queue = new TurnQueue();
	/** Threads whose cleaned-up folders are being put back, so two callers share one `git worktree add`. */
	private readonly restoringFolders = new Map<string, Promise<boolean>>();
	/** Output of worktree setup scripts, made the first time one runs. */
	private setupOutput: vscode.OutputChannel | undefined;

	constructor(private readonly model: AgentsModel) { }

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
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not create the agent's branch: {0}", errorMessage(err)));
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
			void vscode.window.showErrorMessage(vscode.l10n.t("{0} is not in a Git repository, so the agent can't have its own branch.", path.basename(folder)));
			return undefined;
		}
		try {
			return await this.make(repository, await freeBranchName([repository], named), folder);
		} catch (err) {
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not create the agent's branch: {0}", errorMessage(err)));
			return undefined;
		}
	}

	/**
	 * Makes the agent's worktree, then runs the repository's setup in it (`gemini.agents.worktreeSetup`,
	 * else `.gemini/worktree-setup.sh`), such as installing packages or copying .env. A failed setup is
	 * reported with its output, but the agent still starts: the branch is there either way.
	 */
	make(repository: string, branch: string, folder: string): Thenable<AgentWorktree> {
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Creating the agent's branch..."), cancellable: true }, async (progress, token) => {
			const worktree = await createWorktree(repository, branch, await folderInRepository(folder));
			const command = await this.setupCommand(repository);
			if (!command || token.isCancellationRequested) {
				return worktree;
			}
			progress.report({ message: vscode.l10n.t("Running the setup script...") });
			await this.runSetup(command, worktree, repository, branch, token);
			return worktree;
		});
	}

	/** The repository's setup command for a new worktree; none in an untrusted workspace. */
	async setupCommand(repository: string): Promise<string | undefined> {
		return vscode.workspace.isTrusted
			? worktreeSetupCommand(repository, vscode.workspace.getConfiguration(configSection).get<string>('agents.worktreeSetup'))
			: undefined;
	}

	/** Runs the repository's setup in a thread's new worktree, behind a notification; resolves when it ends, however it ends. */
	async setUpThread(repository: string, worktree: AgentWorktree): Promise<void> {
		const command = await this.setupCommand(repository).catch(() => undefined);
		if (!command) {
			return;
		}
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Setting up the thread's branch {0}...", worktree.branch), cancellable: true },
			(_progress, token) => this.runSetup(command, worktree, repository, worktree.branch, token)).then(undefined, () => undefined);
	}

	/**
	 * Picks a free branch name and adds its worktree, one at a time per
	 * repository: threads started together could otherwise pick the same name.
	 */
	addThreadWorktree(repository: string, named: string, folder: string): Promise<AgentWorktree> {
		return this.inTurn(repository, async () => createWorktree(repository, await freeBranchName([repository], named), await folderInRepository(folder)));
	}

	/** Runs `task` once the last one queued under `key` has ended. */
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
