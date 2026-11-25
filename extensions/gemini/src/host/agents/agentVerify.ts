/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Verify, for the agents in this window: runs a repository's checks on an
// agent's work, shows the result in the Changes panel (through
// agentVerifyState.ts), sends failures back to the agent, and keeps doing so
// while "Keep going until checks pass" is on. The decisions are verify.ts's;
// this asks, runs and sends. Loaded from dist/onDemand.js the first time
// checks run.
//
// Nothing here blocks a chat or refuses anything: a run starts after a turn
// ends, a new turn stops it, and Try, Merge Back and Open Merge Request go
// ahead whatever the result.

import * as vscode from 'vscode';
import { defaultProtected } from '../../acp/checksConfig';
import { rememberSetupScript, setupScriptConsent } from '../../acp/setupConsent';
import { teamDefaultsFile } from '../../acp/teamDefaults';
import { failedRun, failurePrompt, nextRound, roundLimit, type VerifyResult } from '../../acp/verify';
import { verifyFolder } from '../../acp/verifyRun';
import { startOf } from '../../acp/worktreeApply';
import type { VerifyAction } from '../panelProtocol';
import type { AgentVerifyState, VerifyEntry } from './agentVerifyState';

/** The command sets the user allowed, by hash, as a repository's setup script is remembered. */
const allowedKey = 'gemini.verify.allowed';

export interface VerifyPlace {
	/** Where the agent works. */
	readonly folder: string;
	readonly title: string;
	/** Its own branch, with the repository it was made from and what it was made from. */
	readonly worktree?: { readonly repository: string; readonly branch: string; readonly base: string };
}

export interface AgentVerifyHost {
	readonly state: AgentVerifyState;
	readonly globalState: vscode.Memento;
	place(id: string): VerifyPlace | undefined;
	busy(id: string): boolean;
	/** Sends `text` to the agent as a turn of its own, after a running one; false when it has no chat here. */
	send(id: string, text: string): boolean;
	/** The editor's errors in the files changed in `folder`, in a few lines, when it has any. */
	errors(folder: string): Promise<string | undefined>;
	/** Agent `id`'s row in the Changes panel changed. */
	changed(id: string): void;
	/** Whether Run would ask before running `command` in `folder` (riskyCommand.ts, which the extension's own bundle has). */
	risky(command: string, folder: string): boolean;
	/** `gemini.verify.maxRounds`. */
	maxRounds(): number;
	/** A result for a project's thread, in a line for its coordinator. */
	report(id: string, text: string): void;
	log(message: string): void;
}

export class AgentVerify implements vscode.Disposable {

	private output: vscode.OutputChannel | undefined;

	constructor(private readonly host: AgentVerifyHost) { }

	dispose(): void {
		this.output?.dispose();
	}

	private get channel(): vscode.OutputChannel {
		return this.output ??= vscode.window.createOutputChannel(vscode.l10n.t("Gemini Checks"));
	}

	/** A button of the Changes panel's Verify row. */
	async act(id: string, action: VerifyAction): Promise<void> {
		const entry = this.host.state.of(id);
		switch (action) {
			case 'run':
				return this.run(id, false);
			case 'stop':
				entry.stop?.();
				return;
			case 'output':
				this.channel.show(true);
				return;
			case 'send':
				if (entry.result && !await this.sendFailures(id, entry.result)) {
					void vscode.window.showInformationMessage(vscode.l10n.t("Open the agent's chat to send it the failures."));
				}
				return;
			case 'goal':
				entry.goal = entry.goal ? undefined : { rounds: 0 };
				entry.note = undefined;
				this.host.changed(id);
				if (entry.goal && !this.host.busy(id)) {
					await this.run(id, false);
				}
		}
	}

	/** From the composer: keep going until a command the user names passes. */
	async askGoal(id: string): Promise<void> {
		const entry = this.host.state.of(id);
		const place = this.host.place(id);
		if (!place) {
			return;
		}
		if (entry.goal) {
			const off = vscode.l10n.t("Turn Off");
			const change = vscode.l10n.t("Change the Command");
			const pick = await vscode.window.showInformationMessage(vscode.l10n.t("\"{0}\" keeps going until its checks pass: {1}", place.title, entry.config?.commands.join(' && ') ?? ''), off, change);
			if (pick === off) {
				entry.goal = undefined;
				entry.note = undefined;
				this.host.changed(id);
			}
			if (pick !== change) {
				return;
			}
		}
		const repository = entry.own ? '' : entry.config?.commands.join(' && ') ?? '';
		const typed = (await vscode.window.showInputBox({
			title: vscode.l10n.t("Keep Going Until a Command Passes"),
			prompt: vscode.l10n.t("After each turn, GeminiCode runs this in the agent's folder and sends its failures back to the agent, at most {0} times.", this.maxRounds()),
			value: entry.config?.commands.join(' && ') ?? '',
			placeHolder: 'npm test',
			ignoreFocusOut: true,
		}))?.trim();
		if (!typed) {
			return;
		}
		if (typed !== repository) {
			// The user's own command: it runs as typed, after the same question a risky Run asks.
			if (this.host.risky(typed, place.folder)) {
				const run = vscode.l10n.t("Run After Each Turn");
				if (await vscode.window.showWarningMessage(vscode.l10n.t("This command may delete or overwrite files, or reach outside the agent's folder."), { modal: true, detail: typed }, run) !== run) {
					return;
				}
			}
			entry.config = { commands: [typed], protected: entry.config?.protected ?? defaultProtected(), afterTurn: 'never' };
			entry.own = true;
			entry.result = undefined;
		}
		entry.goal = { rounds: 0 };
		entry.note = undefined;
		this.host.changed(id);
		if (!this.host.busy(id)) {
			await this.run(id, false);
		}
	}

	/** A turn started: a run in progress describes files about to change, and the user's own prompt starts the goal's rounds over. */
	turnStarted(id: string): void {
		const entry = this.host.state.peek(id);
		if (!entry) {
			return;
		}
		entry.stop?.();
		if (!entry.sent && entry.goal) {
			entry.goal = { rounds: 0 };
			entry.note = undefined;
		}
		entry.sent = false;
	}

	/** A turn ended, having edited files or not. */
	async turnEnded(id: string, edited: boolean): Promise<void> {
		const entry = this.host.state.peek(id);
		if (!entry?.config || entry.stop) {
			return;
		}
		if (entry.goal) {
			if (edited || !entry.result || entry.stale) {
				await this.run(id, true);
			} else if (entry.result.status !== 'passed') {
				entry.note = vscode.l10n.t("Stopped: the last round changed no file.");
				this.host.changed(id);
			}
		} else if (edited && entry.config.afterTurn === 'always') {
			await this.run(id, true);
		}
	}

	private maxRounds(): number {
		return roundLimit(this.host.maxRounds());
	}

	private async run(id: string, automatic: boolean): Promise<void> {
		const entry = this.host.state.of(id);
		const place = this.host.place(id);
		const config = entry.config;
		if (!config || !place || entry.stop) {
			return;
		}
		if (!vscode.workspace.isTrusted) {
			entry.note = vscode.l10n.t("Checks run only in a trusted workspace.");
			this.host.changed(id);
			return;
		}
		if (!entry.own && !await this.allowed(entry, automatic)) {
			return;
		}
		const abort = new AbortController();
		entry.stop = () => abort.abort();
		entry.note = undefined;
		this.host.changed(id);
		const channel = this.channel;
		channel.appendLine(`\n# ${place.title}: ${place.folder}`);
		let result: VerifyResult | undefined;
		try {
			// The second pass compares with where the agent's branch started; an agent in the workspace folder, with what is committed.
			const base = place.worktree ? await startOf(place.worktree.repository, place.worktree.branch, place.worktree.base) : 'HEAD';
			result = await verifyFolder({ folder: place.folder, commands: config.commands, protected: config.protected, base, signal: abort.signal, onOutput: text => channel.append(text) });
		} catch (err) {
			entry.note = vscode.l10n.t("The checks could not run: {0}", err instanceof Error ? err.message : String(err));
			this.host.log(`Verify: ${entry.note}`);
		} finally {
			entry.stop = undefined;
		}
		if (result) {
			entry.result = result;
			entry.stale = false;
			channel.appendLine(`# ${result.status}`);
		}
		this.host.changed(id);
		if (!result || result.status === 'stopped') {
			return;
		}
		const failed = failedRun(result);
		this.host.report(id, result.status === 'passed'
			? `Checks passed: ${config.commands.join(' && ')}.`
			: result.status === 'weakened'
				? `Checks pass only with its changes to the tests, and fail with the original ${result.protectedChanged.join(', ')}.`
				: `Checks failed: ${failed?.command ?? ''} exited with ${failed?.exitCode ?? -1}.`);
		if (entry.goal) {
			await this.followGoal(id, entry, result);
		}
	}

	private async followGoal(id: string, entry: VerifyEntry, result: VerifyResult): Promise<void> {
		const goal = entry.goal ?? { rounds: 0 };
		switch (nextRound(result, goal, this.maxRounds())) {
			case 'send':
				if (await this.sendFailures(id, result)) {
					entry.goal = { rounds: goal.rounds + 1, sentTree: result.tree };
				}
				break;
			case 'passed':
				entry.goal = { rounds: 0 };
				break;
			case 'limit':
				entry.note = goal.rounds === 1 ? vscode.l10n.t("Stopped after 1 round: the checks still fail.") : vscode.l10n.t("Stopped after {0} rounds: the checks still fail.", goal.rounds);
				break;
			case 'unchanged':
				entry.note = vscode.l10n.t("Stopped: the last round changed no file.");
				break;
		}
		this.host.changed(id);
	}

	private async sendFailures(id: string, result: VerifyResult): Promise<boolean> {
		const place = this.host.place(id);
		const text = place && failurePrompt(result, place.folder, await this.host.errors(place.folder).catch(() => undefined));
		if (!text) {
			return false;
		}
		const entry = this.host.state.of(id);
		entry.sent = true;
		const sent = this.host.send(id, text);
		if (!sent) {
			entry.sent = false;
		}
		return sent;
	}

	/** Whether the repository's commands may run: once the user allowed this exact list, as its setup script is allowed. */
	private async allowed(entry: VerifyEntry, automatic: boolean): Promise<boolean> {
		const commands = entry.config?.commands ?? [];
		const allowed = this.host.globalState.get<string[]>(allowedKey, []);
		const consent = setupScriptConsent(commands.join('\n'), allowed);
		// Run Once lasts for this agent in this window, until the commands change: the goal runs them again after each turn.
		if (!consent.needed || entry.allowedOnce === consent.hash) {
			return true;
		}
		if (automatic && entry.declined) {
			return false;
		}
		const once = vscode.l10n.t("Run Once");
		const remember = vscode.l10n.t("Run and Remember");
		const pick = await vscode.window.showWarningMessage(vscode.l10n.t("Run this repository's checks?"), {
			modal: true,
			detail: vscode.l10n.t("{0} names these commands. They run in your shell, in the agent's folder, with your permissions.\n\n{1}", teamDefaultsFile, commands.join('\n')),
		}, { title: vscode.l10n.t("Don't Run"), isCloseAffordance: true }, { title: once }, { title: remember });
		if (pick?.title === remember) {
			await this.host.globalState.update(allowedKey, rememberSetupScript(allowed, consent.hash));
		}
		const run = pick?.title === once || pick?.title === remember;
		entry.allowedOnce = run ? consent.hash : undefined;
		entry.declined = !run;
		return run;
	}
}
