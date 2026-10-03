/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The branch a folder is on, for the Agents pane. Reading `.git/HEAD`
// directly costs one or two small file reads; asking the git extension would
// open the repository in Source Control, and spawning git costs a process.

import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

/** The checked-out branch, a short commit id when detached, or `undefined` outside a repository. */
export async function readGitHead(folder: string): Promise<string | undefined> {
	const gitDir = await findGitDir(folder);
	if (!gitDir) {
		return undefined;
	}
	let head: string;
	try {
		head = (await readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
	} catch {
		return undefined;
	}
	const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
	if (ref) {
		return ref[1];
	}
	return /^[0-9a-f]{40,64}$/i.test(head) ? head.slice(0, 7) : undefined;
}

/** The repository's git directory: `.git`, or where a worktree's `.git` file points. */
async function findGitDir(folder: string): Promise<string | undefined> {
	for (let dir = path.resolve(folder); ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, '.git');
		try {
			if ((await stat(candidate)).isDirectory()) {
				return candidate;
			}
			const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(candidate, 'utf8'));
			if (pointer) {
				return path.resolve(dir, pointer[1].trim());
			}
		} catch {
			// Not here; try the parent.
		}
		if (path.dirname(dir) === dir) {
			return undefined;
		}
	}
}
