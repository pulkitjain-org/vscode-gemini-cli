/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs a repository's checks on an agent's folder (verify.ts says what the
// result means). The commands run through the shell in the repository's top
// folder, with the user's permissions, as the agent's own commands do; the
// host asks before it runs commands a repository names (setupConsent.ts).
//
// The second pass, with the protected files put back, runs in a scratch copy
// of the whole folder, ignored files included: checks need what git does not
// carry (node_modules, a build folder, .env). On macOS the copy is a clone
// (`cp -c`), which takes no space until a file is written. The agent's own
// folder is never changed by a run.

import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { protectedAmong } from './checksConfig';
import { stopProcessGroup } from './processStop';
import { OutputTail } from './runCommands';
import { allPassed, verifyStatus, type CheckRun, type VerifyResult } from './verify';
import { changedFiles, snapshotTree } from './worktreeApply';

/** How long one command may run before it is stopped: a hung test run must not hold an agent's result forever. */
export const checkTimeoutMs = 30 * 60_000;

/** Runs one command through the shell in `cwd`. Never rejects: a command that cannot start, or is stopped, ends with -1. */
export function runCheck(command: string, cwd: string, signal: AbortSignal | undefined, onOutput?: (text: string) => void, timeoutMs = checkTimeoutMs): Promise<CheckRun> {
	return new Promise(resolve => {
		const started = Date.now();
		const tail = new OutputTail();
		const take = (data: unknown) => {
			const text = String(data);
			tail.push(text);
			onOutput?.(text);
		};
		// Not a terminal: test runners print plainly and don't wait for a key.
		const child = spawn(command, { cwd, shell: process.env.SHELL || true, env: { ...process.env, CI: process.env.CI ?? '1', FORCE_COLOR: '0' }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
		let stopped = false;
		const stop = () => {
			stopped = true;
			stopProcessGroup(child);
		};
		if (signal?.aborted) {
			stop();
		}
		signal?.addEventListener('abort', stop, { once: true });
		const timer = setTimeout(() => {
			take(`\nStopped after ${Math.round(timeoutMs / 60_000)} minutes.\n`);
			stop();
		}, timeoutMs);
		timer.unref?.();
		const done = (exitCode: number) => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', stop);
			resolve({ command, exitCode: stopped ? -1 : exitCode, ms: Date.now() - started, ...tail.finish() });
		};
		child.stdout?.on('data', take);
		child.stderr?.on('data', take);
		child.on('error', err => {
			take(`${err.message}\n`);
			done(-1);
		});
		child.on('close', code => done(code ?? -1));
	});
}

/** Runs `commands` in order in `cwd`; the first that fails ends the pass. */
export async function runChecks(commands: readonly string[], cwd: string, signal: AbortSignal | undefined, onOutput?: (text: string) => void, timeoutMs?: number): Promise<CheckRun[]> {
	const runs: CheckRun[] = [];
	for (const command of commands) {
		if (signal?.aborted) {
			break;
		}
		onOutput?.(`$ ${command}\n`);
		const run = await runCheck(command, cwd, signal, onOutput, timeoutMs);
		runs.push(run);
		if (run.exitCode !== 0) {
			break;
		}
	}
	return runs;
}

function git(cwd: string, args: readonly string[]): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		execFile('git', [...args], { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (err, stdout) => err ? reject(err) : resolve(stdout));
	});
}

function copy(args: readonly string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile('cp', [...args], { maxBuffer: 16 * 1024 * 1024 }, err => err ? reject(err) : resolve());
	});
}

/**
 * A copy of `top` with `files` as `base` has them (removed when `base` has no
 * such file): the agent's work with the original tests. It is no checkout of
 * its own, so nothing a check does there can reach the agent's branch.
 * Returns the folder; the caller removes it.
 */
export async function scratchWithOriginals(top: string, base: string, files: readonly string[]): Promise<string> {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'geminicode-verify-'));
	const scratch = path.join(parent, path.basename(top));
	try {
		// A clone where the file system has them (APFS); a plain copy elsewhere.
		await copy(['-cR', top, scratch]).catch(async () => {
			await fs.rm(scratch, { recursive: true, force: true });
			await copy(['-R', top, scratch]);
		});
		await fs.rm(path.join(scratch, '.git'), { recursive: true, force: true });
		for (const file of files) {
			const target = path.join(scratch, file);
			const original = await git(top, ['show', `${base}:${file}`]).catch(() => undefined);
			if (original === undefined) {
				await fs.rm(target, { force: true });
			} else {
				await fs.mkdir(path.dirname(target), { recursive: true });
				await fs.writeFile(target, original);
			}
		}
		return scratch;
	} catch (err) {
		await fs.rm(parent, { recursive: true, force: true });
		throw err;
	}
}

export interface VerifyOptions {
	/** The agent's folder, or any folder inside its checkout. */
	readonly folder: string;
	readonly commands: readonly string[];
	/** Globs of the files whose original version counts. */
	readonly protected: readonly string[];
	/** The commit the agent started from; without one there is no second pass. */
	readonly base?: string;
	readonly signal?: AbortSignal;
	readonly onOutput?: (text: string) => void;
	readonly timeoutMs?: number;
	readonly now?: () => number;
}

/** Runs the checks on the folder as it is and, when they pass and the agent changed protected files, again with those files put back. */
export async function verifyFolder(options: VerifyOptions): Promise<VerifyResult> {
	const { folder, commands, signal, onOutput } = options;
	const top = String(await git(folder, ['rev-parse', '--show-toplevel'])).trim();
	const tree = await snapshotTree(top);
	const runs = await runChecks(commands, top, signal, onOutput, options.timeoutMs);
	let protectedChanged: string[] = [];
	let originalRuns: CheckRun[] | undefined;
	let overlaySkipped: string | undefined;
	if (allPassed(runs) && options.base && !signal?.aborted) {
		const baseTree = String(await git(top, ['rev-parse', `${options.base}^{tree}`])).trim();
		protectedChanged = protectedAmong(await changedFiles(top, baseTree, tree), options.protected);
		if (protectedChanged.length) {
			let scratch: string | undefined;
			try {
				onOutput?.(`\n# Again with the original version of ${protectedChanged.length} protected file${protectedChanged.length === 1 ? '' : 's'}\n`);
				scratch = await scratchWithOriginals(top, options.base, protectedChanged);
				originalRuns = await runChecks(commands, scratch, signal, onOutput, options.timeoutMs);
			} catch (err) {
				overlaySkipped = err instanceof Error ? err.message : String(err);
			} finally {
				if (scratch) {
					await fs.rm(path.dirname(scratch), { recursive: true, force: true }).catch(() => undefined);
				}
			}
		}
	}
	const stopped = Boolean(signal?.aborted) || runs.length === 0;
	return {
		status: verifyStatus(runs, originalRuns, stopped), tree, at: (options.now ?? Date.now)(), runs, protectedChanged,
		...originalRuns ? { originalRuns } : {}, ...overlaySkipped ? { overlaySkipped } : {},
	};
}
