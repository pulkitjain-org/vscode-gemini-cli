/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The file helpers every store shares: writes that never leave half a file,
// moving an unreadable file aside instead of writing over it, comparing
// folders the way the file system does, and removing a log's old day files.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** A plain object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `folder` resolved, in the case the file system compares in (none on macOS and Windows). */
export function comparablePath(folder: string): string {
	const resolved = path.resolve(folder);
	return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** Whether two paths name the same folder, as written (links are not followed). */
export function samePath(a: string, b: string): boolean {
	return comparablePath(a) === comparablePath(b);
}

export interface AtomicWriteOptions {
	/** The file's mode when it is created, such as 0o600 for a file only its owner reads. */
	readonly mode?: number;
	/** The mode of the folders created for the file, such as 0o700 for folders only their owner enters. */
	readonly dirMode?: number;
}

/**
 * The modes for what GeminiCode keeps about the user's work (transcripts,
 * checkpoints with file contents, records, the audit log): the user's alone,
 * as `~/.ssh` is, whatever the umask. Existing files keep their mode.
 */
export const privateWrite = { mode: 0o600, dirMode: 0o700 } as const satisfies AtomicWriteOptions;

/**
 * Writes `text` to a temporary file beside `file`, named for this process
 * with a random suffix (so the copies of this module in other bundles never pick the same name),
 * and renames it over `file`, so a crash never leaves half a file and two
 * windows never rename each other's half-written file into place.
 */
export async function writeFileAtomic(file: string, text: string | Iterable<string>, options: AtomicWriteOptions = {}): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: options.dirMode });
	const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	try {
		if (typeof text === 'string') {
			await fs.writeFile(temp, text, { encoding: 'utf8', mode: options.mode });
		} else {
			// Written in pieces of about 64 KB, so no one string holds it all and other work runs in between.
			const handle = await fs.open(temp, 'w', options.mode);
			try {
				let buffered: string[] = [];
				let size = 0;
				for (const piece of text) {
					buffered.push(piece);
					size += piece.length;
					if (size >= 64 * 1024) {
						await handle.write(buffered.join(''), null, 'utf8');
						buffered = [];
						size = 0;
					}
				}
				if (buffered.length) {
					await handle.write(buffered.join(''), null, 'utf8');
				}
			} finally {
				await handle.close();
			}
		}
		await fs.rename(temp, file);
	} catch (err) {
		await fs.rm(temp, { force: true });
		throw err;
	}
}

/** `value` as JSON, written atomically (`writeFileAtomic`); `indent` as `JSON.stringify` takes it, and a final newline unless `newline` is false. */
export function writeJsonAtomic(file: string, value: unknown, options: AtomicWriteOptions & { readonly indent?: string | number; readonly newline?: boolean } = {}): Promise<void> {
	return writeFileAtomic(file, `${JSON.stringify(value, undefined, options.indent)}${options.newline === false ? '' : '\n'}`, options);
}

/** Whether a temporary file is one `writeFileAtomic` left behind for `file`. */
export function isTempFileOf(name: string, file: string): boolean {
	return name.startsWith(`${path.basename(file)}.`) && name.endsWith('.tmp');
}

/**
 * Moves a file that could not be read aside, as `<file>.broken` (or
 * `<file>.broken-<time>` when one is there already), so nothing writes over
 * it; returns where it went, or undefined when it was gone.
 */
export async function quarantine(file: string, now: number = Date.now()): Promise<string | undefined> {
	let target = `${file}.broken`;
	if (await exists(target)) {
		target = `${file}.broken-${now}`;
	}
	try {
		await fs.rename(file, target);
		return target;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw err;
	}
}

/** Whether `name` is a file `quarantine` moved aside. */
export function isQuarantined(name: string): boolean {
	return /\.broken(-\d+)?$/.test(name);
}

export async function exists(file: string): Promise<boolean> {
	return fs.access(file).then(() => true, () => false);
}

const dayFile = /^(?<day>\d{4}-\d{2}-\d{2})\.jsonl$/;

/** The day files (`YYYY-MM-DD.jsonl`) in `dir` from before `keepDays` days ago; none when `keepDays` is 0 (keep everything). */
export async function oldDayFiles(dir: string, keepDays: number, now: Date): Promise<string[]> {
	if (!(keepDays > 0)) {
		return [];
	}
	const cutoff = new Date(now.getTime() - keepDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	const names = await fs.readdir(dir).catch(() => [] as string[]);
	return names.filter(name => {
		const day = dayFile.exec(name)?.groups?.day;
		return !!day && day < cutoff;
	}).map(name => path.join(dir, name));
}

/** Removes the day files `oldDayFiles` finds; returns how many went. */
export async function removeOldDayFiles(dir: string, keepDays: number, now: Date): Promise<number> {
	const files = await oldDayFiles(dir, keepDays, now);
	await Promise.all(files.map(file => fs.rm(file, { force: true })));
	return files.length;
}

/** Runs tasks one after another per key, such as the writes to one file; a task that fails doesn't stop the next. */
export class KeyedQueue {

	private readonly tails = new Map<string, Promise<unknown>>();

	run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const run = (this.tails.get(key) ?? Promise.resolve()).then(task);
		const tail = run.catch(() => undefined);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) {
				this.tails.delete(key);
			}
		});
		return run;
	}

	/** Resolves once the tasks queued so far for `key` are done. */
	async idle(key: string): Promise<void> {
		await this.tails.get(key);
	}

	/** Resolves once every task queued so far is done. */
	async flush(): Promise<void> {
		await Promise.all([...this.tails.values()]);
	}
}
