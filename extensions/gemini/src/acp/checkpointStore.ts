/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Each agent's checkpoints (checkpoints.ts), one JSON file per agent next to
// its saved chat, so Undo and Rewind still work after the window reloads or
// the agent sleeps. Written after a turn ends, never while a tool runs, and
// deleted with the agent.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { StoredCheckpoints } from './checkpoints';

const formatVersion = 1;

export class CheckpointStore {

	/** The last write per agent, so writes to one file never overlap. */
	private readonly writes = new Map<string, Promise<void>>();

	constructor(private readonly directory: string) { }

	/** The saved checkpoints; undefined when there are none or the file is unreadable. */
	async load(agentId: string): Promise<StoredCheckpoints | undefined> {
		await this.writes.get(agentId);
		try {
			const stored = JSON.parse(await readFile(this.file(agentId), 'utf8')) as StoredCheckpoints & { readonly version?: number };
			return stored?.version === formatVersion ? stored : undefined;
		} catch {
			return undefined;
		}
	}

	save(agentId: string, checkpoints: StoredCheckpoints): Promise<void> {
		return this.enqueue(agentId, async () => {
			const file = this.file(agentId);
			if (!checkpoints.turns.length) {
				await rm(file, { force: true });
				return;
			}
			await mkdir(this.directory, { recursive: true });
			// Write then rename, so a crash never leaves half a file.
			await writeFile(`${file}.tmp`, JSON.stringify({ version: formatVersion, ...checkpoints }));
			await rename(`${file}.tmp`, file);
		});
	}

	delete(agentId: string): Promise<void> {
		return this.enqueue(agentId, () => rm(this.file(agentId), { force: true }));
	}

	private enqueue(agentId: string, write: () => Promise<void>): Promise<void> {
		const next = (this.writes.get(agentId) ?? Promise.resolve()).then(write).catch(() => undefined);
		this.writes.set(agentId, next);
		void next.then(() => {
			if (this.writes.get(agentId) === next) {
				this.writes.delete(agentId);
			}
		});
		return next;
	}

	private file(agentId: string): string {
		return path.join(this.directory, `${agentId.replace(/[^\w-]/g, '_')}.json`);
	}
}
