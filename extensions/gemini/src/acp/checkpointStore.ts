/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Each agent's checkpoints (checkpoints.ts), one JSON file per agent next to
// its saved chat, so Undo and Rewind still work after the window reloads or
// the agent sleeps. Saved a moment after a turn ends, never while a tool
// runs, so quick turns write once; written a turn at a time, so up to 20 MB
// of file text never goes through one `JSON.stringify`. Deleted with the
// agent, and when its thread is merged back.

import { readdir, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import type { StoredCheckpoints } from './checkpoints';
import { KeyedQueue, privateWrite, quarantine, writeFileAtomic } from './fsUtil';

const formatVersion = 1;
/** How long a save waits for the next one, so a burst of turns writes once. */
export const checkpointSaveDelayMs = 2_000;

export class CheckpointStore {

	/** Reads and writes per agent, one after another, so they never overlap. */
	private readonly queue = new KeyedQueue();
	/** Saves waiting for their delay, by agent: the latest checkpoints, and the timer. */
	private readonly pending = new Map<string, { checkpoints: StoredCheckpoints; readonly timer: ReturnType<typeof setTimeout>; readonly done: Promise<void>; readonly resolve: () => void }>();

	/** `onError` hears of every write that fails, such as on a full disk. */
	constructor(private readonly directory: string, private readonly onError: (err: unknown) => void = () => undefined, private readonly delayMs = checkpointSaveDelayMs) { }

	/**
	 * The saved checkpoints; undefined when there are none, or when the file
	 * can't be read or is of another version, which is then moved aside as
	 * `.broken` rather than written over.
	 */
	async load(agentId: string): Promise<StoredCheckpoints | undefined> {
		const pending = this.pending.get(agentId);
		if (pending) {
			const stored: StoredCheckpoints & { readonly version: number } = { version: formatVersion, ...pending.checkpoints };
			return stored.turns.length ? stored : undefined;
		}
		return this.queue.run(agentId, async () => {
			const file = this.file(agentId);
			let text: string;
			try {
				text = await readFile(file, 'utf8');
			} catch {
				return undefined;
			}
			try {
				const stored = JSON.parse(text) as StoredCheckpoints & { readonly version?: number };
				if (stored?.version === formatVersion) {
					return stored;
				}
			} catch {
				// Moved aside below.
			}
			await quarantine(file).catch(err => this.onError(err));
			return undefined;
		});
	}

	/** Saves an agent's checkpoints a moment from now (`flush` saves at once); a later save replaces one still waiting. */
	save(agentId: string, checkpoints: StoredCheckpoints): Promise<void> {
		const waiting = this.pending.get(agentId);
		if (waiting) {
			waiting.checkpoints = checkpoints;
			return waiting.done;
		}
		let resolve!: () => void;
		const done = new Promise<void>(r => resolve = r);
		const timer = setTimeout(() => void this.writeNow(agentId), this.delayMs);
		this.pending.set(agentId, { checkpoints, timer, done, resolve });
		return done;
	}

	/** Writes every save still waiting, and resolves once all writes are done. */
	async flush(): Promise<void> {
		await Promise.all([...this.pending.keys()].map(id => this.writeNow(id)));
		await this.queue.flush();
	}

	delete(agentId: string): Promise<void> {
		const waiting = this.pending.get(agentId);
		if (waiting) {
			clearTimeout(waiting.timer);
			this.pending.delete(agentId);
			waiting.resolve();
		}
		return this.queue.run(agentId, () => rm(this.file(agentId), { force: true })).catch(err => this.onError(err));
	}

	/** Which of `agentIds` have saved checkpoints. */
	async savedOf(agentIds: readonly string[]): Promise<string[]> {
		const names = new Set(await readdir(this.directory).catch(() => [] as string[]));
		return agentIds.filter(id => names.has(path.basename(this.file(id))));
	}

	private writeNow(agentId: string): Promise<void> {
		const waiting = this.pending.get(agentId);
		if (!waiting) {
			return this.queue.idle(agentId);
		}
		clearTimeout(waiting.timer);
		this.pending.delete(agentId);
		const { checkpoints } = waiting;
		const write = this.queue.run(agentId, async () => {
			const file = this.file(agentId);
			if (!checkpoints.turns.length) {
				await rm(file, { force: true });
				return;
			}
			await writeFileAtomic(file, serialize(checkpoints), privateWrite);
		}).catch(err => this.onError(err));
		void write.then(waiting.resolve);
		return write;
	}

	private file(agentId: string): string {
		return path.join(this.directory, `${agentId.replace(/[^\w-]/g, '_')}.json`);
	}
}

/**
 * The file's JSON in pieces, a file's text at a time: the same text as
 * `JSON.stringify({ version, ...checkpoints })`, without one 20 MB string.
 */
export function* serialize(checkpoints: StoredCheckpoints): Generator<string> {
	yield `{"version":${formatVersion},"turns":[`;
	for (const [i, turn] of checkpoints.turns.entries()) {
		yield `${i ? ',' : ''}{"id":${JSON.stringify(turn.id)},"before":[`;
		for (const [j, entry] of turn.before.entries()) {
			yield `${j ? ',' : ''}${JSON.stringify(entry)}`;
		}
		yield `],"undoable":${turn.undoable}}`;
	}
	yield '],"agentText":[';
	for (const [i, entry] of checkpoints.agentText.entries()) {
		yield `${i ? ',' : ''}${JSON.stringify(entry)}`;
	}
	yield ']}';
}
