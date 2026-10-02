/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The @-mention file list for an agent whose folder is not open in this
// window, so VS Code's file search cannot see it. A git repository is listed
// with `git ls-files` (fast, and it honours .gitignore); anything else with a
// bounded directory walk that skips the usual dependency and build folders.

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { indexPath, IndexedPath, rankPaths } from './fuzzy';

const maxFiles = 50_000;
/** A list older than this is rebuilt on the next search. */
const maxAgeMs = 30_000;
const skippedDirectories = new Set(['.git', 'node_modules', 'out', 'dist', 'build', '.next', 'target', '__pycache__', '.venv', 'venv']);

export interface FileMatch {
	readonly path: string;
	/** Folder-relative, for display. */
	readonly relative: string;
}

type IndexedFile = IndexedPath & { readonly path: string };

export class FolderFileIndex {

	private files: { readonly list: Promise<IndexedFile[]>; readonly builtAt: number } | undefined;

	constructor(readonly folder: string, private readonly now: () => number = Date.now) { }

	/** Starts building the list ahead of the first search. */
	warm(): void {
		void this.load();
	}

	async search(query: string, limit: number): Promise<FileMatch[]> {
		return rankPaths(query, await this.load(), limit).map(f => ({ path: f.path, relative: f.relative }));
	}

	private load(): Promise<IndexedFile[]> {
		if (!this.files || this.now() - this.files.builtAt > maxAgeMs) {
			const list = listFiles(this.folder).then(relatives => relatives.slice(0, maxFiles).map(relative => ({
				...indexPath(relative),
				path: path.join(this.folder, relative),
			})));
			this.files = { list: list.catch(() => []), builtAt: this.now() };
		}
		return this.files.list;
	}
}

/** Folder-relative paths, with `/` separators. */
export async function listFiles(folder: string): Promise<string[]> {
	try {
		return await gitLsFiles(folder);
	} catch {
		return walk(folder);
	}
}

function gitLsFiles(folder: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: folder, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
			if (err) {
				reject(err);
			} else {
				resolve(stdout.split('\0').filter(Boolean));
			}
		});
	});
}

async function walk(folder: string): Promise<string[]> {
	const files: string[] = [];
	const pending = [''];
	while (pending.length && files.length < maxFiles) {
		const relative = pending.shift()!;
		let entries;
		try {
			entries = await readdir(path.join(folder, relative), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!skippedDirectories.has(entry.name)) {
					pending.push(child);
				}
			} else if (entry.isFile()) {
				files.push(child);
			}
		}
	}
	return files.slice(0, maxFiles);
}
