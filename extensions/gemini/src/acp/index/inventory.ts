/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The files a folder's index covers. Git lists them where there is a
// repository (so .gitignore applies), else a bounded walk does
// (folderFiles.ts); then `.geminiignore`, the user's excludes, secret files,
// binaries, lock files and anything too large are left out, each with the
// reason the Index page shows. What a file holds (a NUL byte, minified
// lines) is checked when it is read (`contentSkipReason`). The user can
// force files back in with `gemini.index.include` (`SkipRules`).

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { secretPathReason } from '../fileAccess';
import { listFiles } from '../folderFiles';
import { IgnoreRules } from './ignore';

export interface InventoryOptions {
	/** Extra patterns in .gitignore syntax, from `gemini.index.exclude`. */
	readonly exclude: readonly string[];
	/** Files to index whatever the rules say, from `gemini.index.include`. */
	readonly include?: readonly string[];
	readonly maxFileBytes: number;
}

export interface InventoryFile {
	/** Folder-relative, with `/` separators. */
	readonly path: string;
	readonly size: number;
	readonly mtime: number;
}

export interface SkippedFile {
	readonly path: string;
	readonly reason: string;
}

export interface Inventory {
	readonly files: readonly InventoryFile[];
	readonly skipped: readonly SkippedFile[];
}

/** Files that are never worth searching: media, archives, fonts, compiled code. */
const binaryExtensions = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'icns', 'webp', 'avif', 'tif', 'tiff', 'psd', 'sketch', 'fig',
	'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'jar', 'war', 'ear', 'whl', 'egg',
	'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'm4a', 'mov', 'avi', 'mkv', 'webm', 'wav', 'ogg', 'flac',
	'exe', 'dll', 'so', 'dylib', 'a', 'o', 'obj', 'lib', 'class', 'pyc', 'pyo', 'wasm', 'node', 'bin', 'dat',
	'db', 'sqlite', 'sqlite3', 'dmg', 'iso', 'pkg', 'deb', 'rpm', 'apk', 'ipa', 'keystore', 'jks', 'p12', 'pfx',
]);
const lockFiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'cargo.lock', 'poetry.lock', 'pipfile.lock', 'composer.lock', 'gemfile.lock', 'go.sum', 'podfile.lock', 'packages.lock.json', 'uv.lock']);
/** Stat calls in flight at once. */
const statConcurrency = 64;

/** Even a file the user includes is left out above this size. */
export const hardMaxFileBytes = 16 * 1024 * 1024;
/** The reason for binary content: never indexed, whatever the user includes. */
export const binaryContentReason = 'binary content';

/**
 * What is left out of a folder's index, and why: the folder's ignore rules
 * and the user's excludes, secret files, binaries, lock files, generated
 * code and large files. A file matching `gemini.index.include` is indexed
 * anyway, unless it is a secret file or holds binary content.
 */
export class SkipRules {

	private readonly ignore: IgnoreRules;
	private readonly include: IgnoreRules;

	constructor(ignorePatterns: readonly string[], include: readonly string[], private readonly maxFileBytes: number) {
		this.ignore = new IgnoreRules(ignorePatterns);
		this.include = new IgnoreRules(include);
	}

	/** The folder's `.geminiignore` with the user's settings. */
	static async forFolder(root: string, options: InventoryOptions): Promise<SkipRules> {
		return new SkipRules([...await readIgnoreFile(root), ...options.exclude], options.include ?? [], options.maxFileBytes);
	}

	/** Whether the user asked for `relative` to be indexed whatever the rules say. */
	forced(relative: string): boolean {
		return !this.include.empty && this.include.ignores(relative);
	}

	/** Why `relative` is left out by its path alone, or undefined. */
	pathReason(relative: string): string | undefined {
		const secret = secretPathReason(relative);
		if (secret) {
			return secret;
		}
		return this.forced(relative) ? undefined : pathSkipReason(relative, this.ignore);
	}

	sizeReason(relative: string, size: number): string | undefined {
		const limit = this.forced(relative) ? hardMaxFileBytes : this.maxFileBytes;
		return size > limit ? `larger than ${Math.round(limit / 1024)} KB` : undefined;
	}

	contentReason(relative: string, text: string): string | undefined {
		const reason = contentSkipReason(text);
		return reason === binaryContentReason || !this.forced(relative) ? reason : undefined;
	}
}

/** Whether a file left out for `reason` can be indexed by including it: anything but secrets and binary content. */
export function canInclude(relative: string, reason: string): boolean {
	return !secretPathReason(relative) && reason !== binaryContentReason;
}

export async function takeInventory(root: string, options: InventoryOptions): Promise<Inventory> {
	const rules = await SkipRules.forFolder(root, options);
	const files: InventoryFile[] = [];
	const skipped: SkippedFile[] = [];
	const candidates: string[] = [];
	for (const relative of await listFiles(root)) {
		const reason = rules.pathReason(relative);
		if (reason) {
			skipped.push({ path: relative, reason });
		} else {
			candidates.push(relative);
		}
	}
	let next = 0;
	const worker = async () => {
		while (next < candidates.length) {
			const relative = candidates[next++];
			let stat;
			try {
				stat = await fs.stat(path.join(root, relative));
			} catch {
				continue;
			}
			if (!stat.isFile()) {
				continue;
			}
			const tooLarge = rules.sizeReason(relative, stat.size);
			if (tooLarge) {
				skipped.push({ path: relative, reason: tooLarge });
			} else {
				files.push({ path: relative, size: stat.size, mtime: Math.floor(stat.mtimeMs) });
			}
		}
	};
	await Promise.all(Array.from({ length: statConcurrency }, worker));
	files.sort((a, b) => a.path < b.path ? -1 : 1);
	return { files, skipped };
}

/** Why `relative` is left out by its path alone, or undefined; `SkipRules.pathReason` also honours includes. */
export function pathSkipReason(relative: string, rules: IgnoreRules): string | undefined {
	const secret = secretPathReason(relative);
	if (secret) {
		return secret;
	}
	if (rules.ignores(relative)) {
		return 'excluded by .geminiignore or gemini.index.exclude';
	}
	const base = relative.slice(relative.lastIndexOf('/') + 1).toLowerCase();
	if (lockFiles.has(base)) {
		return 'a lock file';
	}
	const dot = base.lastIndexOf('.');
	if (dot > 0 && binaryExtensions.has(base.slice(dot + 1))) {
		return 'a binary file type';
	}
	if (/\.min\.(?:js|css)$|\.map$|\.bundle\.js$/.test(base)) {
		return 'generated';
	}
	return undefined;
}

/** Why a file is left out for what it holds: binary, or minified or generated. */
export function contentSkipReason(text: string): string | undefined {
	if (text.slice(0, 8192).includes('\0')) {
		return binaryContentReason;
	}
	const lines = text.length ? text.split('\n').length : 0;
	if (lines && text.length / lines > 300) {
		return 'generated (very long lines)';
	}
	return undefined;
}

export async function readIgnoreFile(root: string): Promise<string[]> {
	try {
		return (await fs.readFile(path.join(root, '.geminiignore'), 'utf8')).split(/\r?\n/);
	} catch {
		return [];
	}
}
