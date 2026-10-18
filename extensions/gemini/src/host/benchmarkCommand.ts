/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BenchSummary } from '../acp/benchmark';
import { errorMessage } from '../acp/errors';
import type { AgentService } from './agentService';
import { getAgentCommand, productInfo, workspaceFolderPaths } from './configuration';
import { knownModelList } from './modelPreference';

/** About how many model calls one task takes (gemini/bench/README.md), for the quota note. */
const requestsPerTask = 15;

/**
 * Gemini: Run Benchmark. Runs the benchmark's tasks (gemini/bench/tasks) on one model with the
 * CLI this app runs, as the release-day run asks for (gemini/bench/README.md),
 * and writes the results file into `results/` beside the tasks folder, to add by pull request.
 */
export class BenchmarkCommand implements vscode.Disposable {

	private running: AbortController | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly service: AgentService, private readonly log: vscode.LogOutputChannel) {
		this.disposables.push(vscode.commands.registerCommand('gemini.runBenchmark', () => this.run()));
	}

	dispose(): void {
		this.running?.abort();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private async run(): Promise<void> {
		if (this.running) {
			void vscode.window.showInformationMessage(vscode.l10n.t("A benchmark is already running. Cancel it from its notification first."));
			return;
		}
		const tasksDir = await pickTasksFolder();
		if (!tasksDir) {
			return;
		}
		// The runner and the ACP SDK it uses load now, not when the extension activates.
		const bench = await import('../acp/benchmark');
		let tasks;
		try {
			tasks = await bench.readBenchTasks(tasksDir);
		} catch (err) {
			void vscode.window.showErrorMessage(vscode.l10n.t("Couldn't read the benchmark tasks in {0}: {1}", tasksDir, errorMessage(err)));
			return;
		}
		if (!tasks.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t("There are no task files in {0}. gemini/bench/README.md says how to make them from closed tickets.", tasksDir));
			return;
		}
		const model = await pickModel();
		if (!model) {
			return;
		}
		const confirm = vscode.l10n.t("Run Benchmark");
		const answer = await vscode.window.showWarningMessage(
			vscode.l10n.t("Run {0} benchmark tasks on {1}?", tasks.length, model),
			{ modal: true, detail: vscode.l10n.t("Each task clones its repository into a temporary folder, lets the agent edit files and run commands there without asking, then runs the task's test command. Expect about {0} requests from your daily quota.", tasks.length * requestsPerTask) },
			confirm);
		if (answer !== confirm) {
			return;
		}

		const controller = new AbortController();
		this.running = controller;
		const resultsDir = path.join(path.dirname(tasksDir), 'results');
		this.log.info(`Running ${tasks.length} benchmark tasks from ${tasksDir} on ${model}`);
		try {
			const summary = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Benchmark on {0}", model), cancellable: true }, async (progress, token) => {
				token.onCancellationRequested(() => controller.abort());
				return bench.runBenchmark({
					tasks,
					agent: await getAgentCommand({ ownFolderOnly: true }),
					model,
					geminiCodeVersion: productInfo.version,
					cliVersion: this.service.cli?.version ?? this.service.status.agentVersion,
					signal: controller.signal,
					log: line => this.log.info(`[benchmark] ${line}`),
					onTask: (task, index) => progress.report({ message: vscode.l10n.t("{0}, task {1} of {2}", task.key, index + 1, tasks.length), increment: index ? 100 / tasks.length : 0 }),
				});
			});
			if (controller.signal.aborted) {
				void vscode.window.showInformationMessage(vscode.l10n.t("Benchmark cancelled after {0} of {1} tasks. No results file was written.", summary.tasks, tasks.length));
				return;
			}
			const file = path.join(resultsDir, bench.benchResultsFileName(summary));
			await fs.mkdir(resultsDir, { recursive: true });
			await fs.writeFile(file, `${JSON.stringify(summary, null, '\t')}\n`);
			this.log.info(`Benchmark results written to ${file}`);
			const open = vscode.l10n.t("Open Results");
			if (await vscode.window.showInformationMessage(describe(summary), open) === open) {
				await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
			}
		} catch (err) {
			this.log.error(`The benchmark stopped: ${errorMessage(err)}`);
			void vscode.window.showErrorMessage(vscode.l10n.t("The benchmark stopped: {0}", errorMessage(err)));
		} finally {
			this.running = undefined;
		}
	}
}

/** `gemini/bench/tasks` in the window's folder when there is exactly one, otherwise the folder the user picks. */
async function pickTasksFolder(): Promise<string | undefined> {
	const candidates = workspaceFolderPaths().map(folder => path.join(folder, 'gemini', 'bench', 'tasks'));
	const present = await Promise.all(candidates.map(dir => fs.access(dir).then(() => true, () => false)));
	const found = candidates.filter((_, i) => present[i]);
	if (found.length === 1) {
		return found[0];
	}
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		defaultUri: found[0] ? vscode.Uri.file(found[0]) : undefined,
		title: vscode.l10n.t("Choose the Benchmark's Tasks Folder"),
		openLabel: vscode.l10n.t("Use These Tasks"),
	});
	return picked?.[0]?.fsPath;
}

/** One model per run, so a Flash run and a Pro run are two results files. */
async function pickModel(): Promise<string | undefined> {
	const models = knownModelList();
	if (!models.length) {
		const typed = await vscode.window.showInputBox({
			title: vscode.l10n.t("Benchmark Model"),
			prompt: vscode.l10n.t("The model ID to run every task on. Start an agent once to pick from your account's list instead."),
			placeHolder: 'gemini-3.8-flash',
		});
		return typed?.trim() || undefined;
	}
	const picked = await vscode.window.showQuickPick(models.map(m => ({ label: m.name, description: m.name === m.id ? undefined : m.id, id: m.id })), {
		title: vscode.l10n.t("Benchmark Model"),
		placeHolder: vscode.l10n.t("Every task runs on this model; run again for another"),
	});
	return picked?.id;
}

function describe(summary: BenchSummary): string {
	return summary.requestsPerCompletedTask === null
		? vscode.l10n.t("Benchmark done: {0} of {1} tasks completed.", summary.completed, summary.tasks)
		: vscode.l10n.t("Benchmark done: {0} of {1} tasks completed, {2} requests per completed task.", summary.completed, summary.tasks, summary.requestsPerCompletedTask);
}
