/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Verify: what a run of a repository's checks on an agent's work means, and
// what happens next. The decisions only; verifyRun.ts runs the commands.
//
// A run is one or two passes. First the commands run on the agent's work as
// it is. When they pass and the agent changed a protected file (a test, a
// lockfile, test configuration: checksConfig.ts), they run again in a scratch
// copy with those files as they were before the agent. Passing only with the
// agent's own test changes is its own result, "weakened": the code was not
// shown to work, the tests were shown to have changed.
//
// A result is bound to the git tree it ran on, so anything that shows it can
// say when the agent's files have changed since.

import { external } from './externalText';
import { commandReport } from './runCommands';

/** One command of a run: how it ended and the end of what it printed. */
export interface CheckRun {
	readonly command: string;
	/** -1 when it could not start or was stopped. */
	readonly exitCode: number;
	readonly ms: number;
	readonly lines: readonly string[];
	/** Earlier lines of output that were not kept. */
	readonly dropped: number;
}

/**
 * - `passed`: every command exited 0, with the original protected files too when the agent changed any.
 * - `failed`: a command failed on the agent's work as it is.
 * - `weakened`: passes with the agent's changes to protected files, fails with the originals.
 * - `stopped`: ended before it finished (a new turn, the user, the app closing); says nothing about the work.
 */
export type VerifyStatus = 'passed' | 'failed' | 'weakened' | 'stopped';

export interface VerifyResult {
	readonly status: VerifyStatus;
	/** The git tree of the agent's folder the checks ran on. */
	readonly tree: string;
	readonly at: number;
	/** The pass on the agent's work as it is. */
	readonly runs: readonly CheckRun[];
	/** The protected files the agent changed, relative to the repository's top folder. */
	readonly protectedChanged: readonly string[];
	/** The pass with the protected files put back, when there was one. */
	readonly originalRuns?: readonly CheckRun[];
	/** Why there was no second pass although protected files changed: the scratch copy could not be made. */
	readonly overlaySkipped?: string;
}

export function allPassed(runs: readonly CheckRun[]): boolean {
	return runs.length > 0 && runs.every(run => run.exitCode === 0);
}

/** What the two passes add up to. `originalRuns` is undefined when the second pass did not run. */
export function verifyStatus(runs: readonly CheckRun[], originalRuns: readonly CheckRun[] | undefined, stopped: boolean): VerifyStatus {
	if (stopped) {
		return 'stopped';
	}
	if (!allPassed(runs)) {
		return 'failed';
	}
	return originalRuns && !allPassed(originalRuns) ? 'weakened' : 'passed';
}

/** The command that failed, in the pass that decided the result. */
export function failedRun(result: VerifyResult): CheckRun | undefined {
	return (result.status === 'weakened' ? result.originalRuns : result.runs)?.find(run => run.exitCode !== 0);
}

/**
 * What a failed run sends the agent: the command, its exit code and the end of
 * its output, framed as text to read, not as instructions (the output is the
 * repository's and its dependencies', not the user's). `errors` is the
 * editor's errors in the files the agent changed (`errorsNotice`), when it
 * has any. Undefined for a result that has nothing to fix.
 */
export function failurePrompt(result: VerifyResult, folder: string, errors?: string): string | undefined {
	const failed = failedRun(result);
	if (!failed || result.status === 'passed' || result.status === 'stopped') {
		return undefined;
	}
	const report = external('checks', failed.command, fenced(commandReport({ commandLine: failed.command, cwd: folder, exitCode: failed.exitCode, lines: failed.lines, dropped: failed.dropped })));
	const head = result.status === 'weakened'
		? [
			'The repository\'s checks pass with your changes to its tests, but fail once these files are put back as they were before you changed them:',
			...result.protectedChanged.map(file => `- ${file}`),
			'Fix the code so the original tests pass. Change a test only where the task itself changes what the code should do, and say so when you do.',
		]
		: ['The repository\'s checks failed on your changes. Fix the code, not the tests: never weaken or delete a test to make it pass.'];
	return [
		...head,
		'',
		report,
		...errors ? ['', external('checks', 'editor errors', fenced(errors))] : [],
	].join('\n');
}

/**
 * `text` as a code block, so the chat shows a command's output as it was
 * printed: its `#` lines are not headings and its `*` not emphasis. The fence
 * is longer than any run of backticks in the text, so the text cannot end it.
 */
function fenced(text: string): string {
	const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
	const fence = '`'.repeat(longest + 1);
	return `${fence}text\n${text}\n${fence}`;
}

/** Where "Keep going until checks pass" stands for one agent. */
export interface GoalState {
	/** How many times failures were sent to the agent since the goal was set or last passed. */
	readonly rounds: number;
	/** The tree the failures were last sent for. */
	readonly sentTree?: string;
}

/**
 * - `send`: send the failures and let the agent try again.
 * - `passed`: the goal is met.
 * - `limit`: the rounds are spent.
 * - `unchanged`: the last round changed no file, so another would not either.
 * - `wait`: the run says nothing (stopped); do nothing.
 */
export type RoundDecision = 'send' | 'passed' | 'limit' | 'unchanged' | 'wait';

/** What to do with `result` while the goal is on. Each round is an ordinary turn, so `maxRounds` bounds what the goal can spend. */
export function nextRound(result: VerifyResult, state: GoalState, maxRounds: number): RoundDecision {
	if (result.status === 'stopped') {
		return 'wait';
	}
	if (result.status === 'passed') {
		return 'passed';
	}
	if (state.sentTree === result.tree) {
		return 'unchanged';
	}
	return state.rounds >= maxRounds ? 'limit' : 'send';
}

/** `gemini.verify.maxRounds` as a whole number from 0 to 10; 0 never sends by itself. */
export function roundLimit(value: unknown, fallback = 2): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.min(10, Math.max(0, Math.floor(value))) : fallback;
}

/** A run's length as a person reads it: "8 s", "2 min 5 s". */
export function runSeconds(runs: readonly CheckRun[]): number {
	return Math.round(runs.reduce((sum, run) => sum + run.ms, 0) / 1000);
}
