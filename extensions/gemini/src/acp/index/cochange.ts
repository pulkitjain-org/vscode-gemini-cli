/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Files that change together, from recent history: a strong hint of what
// else a change to one file needs (its test, its schema, its docs), which
// imports alone miss.

import { execFile } from 'node:child_process';

const commits = 500;
/** A commit touching more files than this (a rename, a reformat) says nothing about any pair. */
const maxFilesPerCommit = 30;

/** Pairs of folder-relative paths (joined by NUL, in order) to how many commits changed both, for pairs seen at least twice. */
export async function cochangePairs(root: string): Promise<Map<string, number>> {
	const log = await new Promise<string>(resolve => {
		execFile('git', ['log', `-n${commits}`, '--no-merges', '--name-only', '--relative', '--format=%x00'], { cwd: root, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout));
	});
	return pairsFromLog(log);
}

export function pairsFromLog(log: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const commit of log.split('\0')) {
		const files = [...new Set(commit.split('\n').map(line => line.trim()).filter(Boolean))].sort();
		if (files.length < 2 || files.length > maxFilesPerCommit) {
			continue;
		}
		for (let i = 0; i < files.length; i++) {
			for (let j = i + 1; j < files.length; j++) {
				const key = `${files[i]}\0${files[j]}`;
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		}
	}
	for (const [key, count] of counts) {
		if (count < 2) {
			counts.delete(key);
		}
	}
	return counts;
}
