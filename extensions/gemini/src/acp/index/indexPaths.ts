/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Where a folder's index lives. Small on purpose: the extension host uses it
// to tell whether a folder has an index without starting the indexer.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** The id of a folder's index: a hash of its real path, so two spellings of one folder share it. */
export async function workspaceId(root: string): Promise<string> {
	const real = await fs.realpath(root).catch(() => root);
	return createHash('sha256').update(real).digest('hex').slice(0, 24);
}

/** The index file of `root` under `baseDir` (~/.geminicode/index). */
export async function indexFile(baseDir: string, root: string): Promise<string> {
	return path.join(baseDir, 'code', await workspaceId(root), 'index.db');
}

/** Whether `root` has an index on disk, built by any window. */
export async function hasIndex(baseDir: string, root: string): Promise<boolean> {
	return fs.access(await indexFile(baseDir, root)).then(() => true, () => false);
}
