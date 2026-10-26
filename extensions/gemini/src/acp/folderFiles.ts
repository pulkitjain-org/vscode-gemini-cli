/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
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

/** A glob for files named `name` anywhere in a folder, as a reply names a file: leading ./ and ../ go, and glob characters match any one character. */
export function fileNamePattern(name: string): string {
	return `**/${name.replace(/^(\.\.?\/)+/, '').replace(/[[\]{}*?!]/g, '?')}`;
}

export interface FileMatch {
	readonly path: string;
	/** Folder-relative, for display. */
	readonly relative: string;
}

type IndexedFile = IndexedPath & { readonly path: string };

export class FolderFileIndex {

	private files: { readonly list: Promise<IndexedFile[]>; readonly builtAt: number } | undefined;

	/** `indexed` lists the folder's files from its index, when it has one built, saving a git process. */
	constructor(readonly folder: string, private readonly now: () => number = Date.now, private readonly indexed?: () => Promise<string[] | undefined>) { }

	/** Starts building the list ahead of the first search. */
	warm(): void {
		void this.load();
	}

	async search(query: string, limit: number): Promise<FileMatch[]> {
		return rankPaths(query, await this.load(), limit).map(f => ({ path: f.path, relative: f.relative }));
	}

	private async listing(): Promise<string[]> {
		return await this.indexed?.().catch(() => undefined) ?? listFiles(this.folder);
	}

	private load(): Promise<IndexedFile[]> {
		if (!this.files || this.now() - this.files.builtAt > maxAgeMs) {
			const list = this.listing().then(relatives => relatives.slice(0, maxFiles).map(relative => ({
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
	return (await listFolder(folder)).files;
}

/**
 * Folder-relative paths, and whether the list stopped short: the walk stops
 * at 50,000 files, and results from a cut list can't claim to be complete.
 */
export async function listFolder(folder: string, limit = maxFiles): Promise<{ readonly files: string[]; readonly truncated: boolean }> {
	try {
		return { files: await gitLsFiles(folder), truncated: false };
	} catch {
		return walk(folder, limit);
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

async function walk(folder: string, limit: number): Promise<{ files: string[]; truncated: boolean }> {
	const files: string[] = [];
	const pending = [''];
	// A read position rather than shift(), which moves every queued folder each time.
	let next = 0;
	while (next < pending.length && files.length < limit) {
		const relative = pending[next++];
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
	return { files: files.slice(0, limit), truncated: files.length > limit || next < pending.length };
}
