/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Whether files are ignored by git, for the agent's file reads. Starting
// `git check-ignore` for every file costs a process start (5 to 15 ms on a
// Mac, more on Windows) on the path of each read, so one long-lived
// `git check-ignore --stdin` per folder answers them all. A path it can't
// answer (outside the repository, inside a submodule) ends that process; the
// paths it had are then checked one by one, as before.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

/** A checker process with nothing to do ends after this long. */
const idleMs = 30_000;

interface Pending {
	readonly filePath: string;
	readonly resolve: (ignored: boolean) => void;
}

/** One `git check-ignore --stdin` process for one folder. */
class Checker {

	private readonly process: ChildProcessWithoutNullStreams;
	private readonly pending: Pending[] = [];
	private fields: string[] = [];
	private partial = '';
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	ended = false;
	/** Whether git answered anything, so a folder that is no repository can be told apart. */
	answered = false;

	constructor(folder: string, private readonly onEnd: (unanswered: readonly Pending[]) => void) {
		// GIT_FLUSH makes git answer each path as it comes rather than at the end.
		this.process = spawn('git', ['check-ignore', '--stdin', '-z', '--non-matching', '--verbose'], { cwd: folder, env: { ...process.env, GIT_FLUSH: '1' }, windowsHide: true });
		this.process.stdout.setEncoding('utf8');
		this.process.stdout.on('data', (chunk: string) => this.read(chunk));
		this.process.stderr.resume();
		this.process.stdin.on('error', () => this.end());
		this.process.once('error', () => this.end());
		this.process.once('exit', () => this.end());
		this.armIdle();
	}

	check(filePath: string): Promise<boolean> {
		return new Promise(resolve => {
			this.pending.push({ filePath, resolve });
			clearTimeout(this.idleTimer);
			this.process.stdin.write(`${filePath}\0`);
		});
	}

	dispose(): void {
		clearTimeout(this.idleTimer);
		this.process.kill();
	}

	/** Each answer is four fields: source, line, pattern and path; an empty source means no pattern matched. */
	private read(chunk: string): void {
		const parts = (this.partial + chunk).split('\0');
		this.partial = parts.pop() ?? '';
		this.fields.push(...parts);
		while (this.fields.length >= 4) {
			const [source, , pattern] = this.fields.splice(0, 4);
			this.answered = true;
			// A matching `!pattern` re-includes the file.
			this.pending.shift()?.resolve(!!source && !pattern.startsWith('!'));
		}
		if (!this.pending.length) {
			this.armIdle();
		}
	}

	private armIdle(): void {
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => this.dispose(), idleMs);
		this.idleTimer.unref?.();
	}

	private end(): void {
		if (this.ended) {
			return;
		}
		this.ended = true;
		clearTimeout(this.idleTimer);
		this.onEnd(this.pending.splice(0));
	}
}

/** How long a folder whose checker answered nothing (no git, or no repository) is checked file by file. */
const fallbackMs = 60_000;

/** Answers "is this file ignored by git?" for files under a few folders, with one git process per folder. */
export class GitIgnoreChecker {

	private readonly checkers = new Map<string, Checker>();
	private readonly fallbackUntil = new Map<string, number>();

	/**
	 * Whether git ignores `filePath`. `folder` is where to run git: the
	 * workspace folder the file is in. No git, or no repository, means not ignored.
	 */
	isIgnored(filePath: string, folder = path.dirname(filePath)): Promise<boolean> {
		if ((this.fallbackUntil.get(folder) ?? 0) > Date.now()) {
			return checkOne(filePath);
		}
		let checker = this.checkers.get(folder);
		if (!checker || checker.ended) {
			const created: Checker = checker = new Checker(folder, unanswered => {
				if (this.checkers.get(folder) === created) {
					this.checkers.delete(folder);
				}
				if (!created.answered && unanswered.length) {
					this.fallbackUntil.set(folder, Date.now() + fallbackMs);
				}
				for (const { filePath: file, resolve } of unanswered) {
					void checkOne(file).then(resolve);
				}
			});
			this.checkers.set(folder, checker);
		}
		return checker.check(filePath);
	}

	/** Forgets what git answered so far: an ignore file changed, and a running `check-ignore` keeps the rules it read. */
	reset(): void {
		this.dispose();
		this.fallbackUntil.clear();
	}

	dispose(): void {
		for (const checker of this.checkers.values()) {
			checker.dispose();
		}
		this.checkers.clear();
	}
}

/** One `git check-ignore` run for one file: exit 0 means ignored. */
export function checkOne(filePath: string): Promise<boolean> {
	return new Promise(resolve => {
		execFile('git', ['check-ignore', '--quiet', '--', filePath], { cwd: path.dirname(filePath), timeout: 5_000, windowsHide: true }, err => resolve(!err));
	});
}
