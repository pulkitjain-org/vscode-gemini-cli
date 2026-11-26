/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What Verify knows about each agent in this window: the repository's checks,
// the last result and the tree it ran on, whether the agent's files changed
// since, and where "Keep going until checks pass" stands. It is state, so it
// lives in the bundle every window loads; what runs the checks
// (agentVerify.ts) loads the first time checks run, and writes here.
//
// A result lasts until the window reloads: it is seconds or minutes to make
// again, and what changed in a folder while the app was closed is unknown.

import * as vscode from 'vscode';
import type { ChecksConfig } from '../../acp/checksConfig';
import { failedRun, runSeconds, type GoalState, type VerifyResult } from '../../acp/verify';
import type { VerifyView } from '../panelProtocol';

export interface VerifyEntry {
	/** The checks that run: the repository's, or the command the user gave as a goal. */
	config?: ChecksConfig;
	/** The user typed the commands (a goal from the composer): nothing to ask consent for. */
	own?: boolean;
	/** The folder `config` was read for. */
	folder?: string;
	result?: VerifyResult;
	/** The agent's files changed after `result`. */
	stale?: boolean;
	/** Stops the run in progress. */
	stop?: () => void;
	/** "Keep going until checks pass" is on. */
	goal?: GoalState;
	/** Why the goal stopped sending, or why nothing ran. */
	note?: string;
	/** The next turn is one Verify started, so it does not start the goal's rounds over. */
	sent?: boolean;
	/** The turn in progress edited files. */
	editedThisTurn?: boolean;
	/** The hash of the repository's commands the user allowed with Run Once. */
	allowedOnce?: string;
	/** The user said Don't Run for the repository's commands: not asked again by a turn's end in this window. */
	declined?: boolean;
}

export class AgentVerifyState {

	private readonly entries = new Map<string, VerifyEntry>();

	/** The entry for agent `id`, made on first use. */
	of(id: string): VerifyEntry {
		let entry = this.entries.get(id);
		if (!entry) {
			entry = {};
			this.entries.set(id, entry);
		}
		return entry;
	}

	peek(id: string): VerifyEntry | undefined {
		return this.entries.get(id);
	}

	forget(id: string): void {
		this.entries.get(id)?.stop?.();
		this.entries.delete(id);
	}

	/** The agent edited files: a result no longer describes what is on disk. */
	edited(id: string): boolean {
		const entry = this.entries.get(id);
		if (entry?.result && !entry.stale) {
			entry.stale = true;
			return true;
		}
		return false;
	}

	/** The row the Changes panel shows, or undefined when the agent has no checks to run. */
	view(id: string): VerifyView | undefined {
		const entry = this.entries.get(id);
		if (!entry?.config) {
			return undefined;
		}
		const commands = entry.config.commands.join(' && ');
		const goal = {
			label: vscode.l10n.t("Keep going until checks pass"),
			tip: vscode.l10n.t("After each turn, runs the checks and sends their failures back to the agent, until they pass or the rounds in gemini.verify.maxRounds are spent."),
			on: !!entry.goal,
		};
		const output = { id: 'output' as const, label: vscode.l10n.t("Show Output") };
		if (entry.stop) {
			return { state: 'running', text: vscode.l10n.t("Running checks: {0}", commands), actions: [{ id: 'stop', label: vscode.l10n.t("Stop") }, output], goal };
		}
		const result = entry.result;
		if (!result || result.status === 'stopped') {
			return {
				state: 'none', text: vscode.l10n.t("Checks not run: {0}", commands), ...entry.note ? { detail: entry.note } : {},
				actions: [{ id: 'run', label: vscode.l10n.t("Run Checks"), tip: vscode.l10n.t("Runs the repository's checks in the agent's folder") }], goal,
			};
		}
		const seconds = runSeconds([...result.runs, ...result.originalRuns ?? []]);
		const failed = failedRun(result);
		const text = result.status === 'passed'
			// Under a second is not worth a number.
			? seconds ? vscode.l10n.t("Checks passed: {0} ({1} s)", commands, seconds) : vscode.l10n.t("Checks passed: {0}", commands)
			: result.status === 'weakened'
				? vscode.l10n.t("Passes with the agent's test changes, fails with the original tests")
				: vscode.l10n.t("Checks failed: {0} (exit code {1})", failed?.command ?? commands, failed?.exitCode ?? -1);
		const details = [
			...entry.stale ? [result.status === 'passed' ? vscode.l10n.t("Checks passed on an earlier version: the agent changed files since.") : vscode.l10n.t("This is an earlier version: the agent changed files since.")] : [],
			...result.status === 'weakened' ? [vscode.l10n.t("It changed: {0}", result.protectedChanged.join(', '))] : [],
			...result.status === 'passed' && result.protectedChanged.length && result.originalRuns ? [vscode.l10n.t("Also passes with the original version of the {0} test files it changed.", result.protectedChanged.length)] : [],
			...result.overlaySkipped ? [vscode.l10n.t("Not run with the original tests: the copy could not be made ({0}).", result.overlaySkipped)] : [],
			...entry.note ? [entry.note] : [],
		];
		return {
			state: result.status, text, ...details.length ? { detail: details.join(' ') } : {},
			actions: [
				...result.status !== 'passed' ? [{ id: 'send' as const, label: vscode.l10n.t("Send Failures to Agent"), tip: vscode.l10n.t("Sends the failing command, its exit code and the end of its output to the agent") }] : [],
				{ id: 'run', label: vscode.l10n.t("Run Again") }, output,
			],
			goal,
		};
	}
}
