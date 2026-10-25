/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A list of records that every window shares, one JSON file per record:
// `{ "version": 1, "order": n, "record": { ... } }`. A save writes only the
// records that changed since the last one, each atomically, and a removed
// record leaves a tombstone, so a window that still has it never brings it
// back. Before a record is written, its file is read again: another window's
// newer copy, or its tombstone, wins. A watch on the folder tells this window
// of the others' changes. Records are kept as they are, fields this version
// doesn't know included; a file of a newer version is never written, and a
// file that can't be read is moved aside as `.broken`.

import { promises as fs, watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import { isQuarantined, isRecord, quarantine, writeFileAtomic } from './fsUtil';

/** What a record needs: an id that is unique in its list. */
export interface StoredRecord {
	readonly id: string;
}

/** Records another window added, changed or removed. */
export interface RecordChange<T extends StoredRecord> {
	readonly upserted: readonly T[];
	readonly removed: readonly string[];
}

export interface RecordStoreOptions<T extends StoredRecord> {
	/** Of the file format; a file with a higher one is left alone. */
	readonly version?: number;
	/** Whether another window's copy of a record is newer than this window's, so it wins; by default, this window's wins. */
	readonly newer?: (theirs: T, ours: T) => boolean;
	/** How long a tombstone is kept; long enough for every window to have seen it. */
	readonly tombstoneMs?: number;
	readonly now?: () => number;
	/** A file that could not be read and was moved aside, or a write that failed. */
	readonly onError?: (message: string) => void;
}

interface Envelope {
	readonly version: number;
	readonly order?: number;
	readonly record?: unknown;
	/** A tombstone: the record was removed at this time. */
	readonly deleted?: number;
	readonly id?: string;
}

const defaultTombstoneMs = 30 * 24 * 60 * 60 * 1000;
/** A watch event is read this long after the last one, so a burst of writes is read once. */
const watchDelayMs = 100;

export class RecordStore<T extends StoredRecord> {

	readonly version: number;
	/** Each record as last written or read, by id; a record whose object is still this one has not changed. */
	private readonly known = new Map<string, T>();
	/** Each record's file text as last written or read, so this window's own writes are not read back as changes. */
	private readonly texts = new Map<string, string>();
	/** Each record's place in the list: when it was first written. */
	private readonly orders = new Map<string, number>();
	/** Records removed here or in another window. */
	private readonly deleted = new Set<string>();
	/** Records in files of a newer version: never written or removed here. */
	private readonly foreign = new Set<string>();
	private queue: Promise<unknown> = Promise.resolve();
	private watcher: FSWatcher | undefined;
	private readonly pending = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly now: () => number;

	constructor(readonly dir: string, private readonly options: RecordStoreOptions<T> = {}) {
		this.version = options.version ?? 1;
		this.now = options.now ?? Date.now;
	}

	/** Whether the store has written or read any record yet. */
	get size(): number {
		return this.known.size;
	}

	/**
	 * Every record, in the order they were first written. A file that cannot
	 * be read is moved aside; tombstones past their time are removed, along
	 * with temporary files a crash left behind.
	 */
	async load(): Promise<T[]> {
		return this.enqueue(async () => {
			const names = await fs.readdir(this.dir).catch(() => [] as string[]);
			const loaded: { readonly record: T; readonly order: number }[] = [];
			await Promise.all(names.map(async name => {
				const file = path.join(this.dir, name);
				if (name.endsWith('.tmp')) {
					// Left by a window that quit mid-write; one a day old is not being written any more.
					const stat = await fs.stat(file).catch(() => undefined);
					if (stat && stat.mtimeMs < this.now() - 24 * 60 * 60 * 1000) {
						await fs.rm(file, { force: true });
					}
					return;
				}
				if (!name.endsWith('.json') || isQuarantined(name)) {
					return;
				}
				const text = await fs.readFile(file, 'utf8').catch(() => undefined);
				if (text === undefined) {
					return;
				}
				const read = await this.read(file, text, true);
				if (read?.kind === 'record') {
					loaded.push({ record: read.record, order: read.order });
				} else if (read?.kind === 'deleted' && read.at < this.now() - (this.options.tombstoneMs ?? defaultTombstoneMs)) {
					await fs.rm(file, { force: true });
				}
			}));
			return loaded.sort((a, b) => a.order - b.order || (a.record.id < b.record.id ? -1 : 1)).map(each => each.record);
		});
	}

	/** Whether `record` is the copy last written or read, so a save has nothing to write for it. */
	isSaved(record: T): boolean {
		return this.known.get(record.id) === record;
	}

	/**
	 * Saves `records`, the whole list: writes the ones whose object changed
	 * since the last save, and a tombstone for each one no longer in it.
	 * Returns what another window had changed in the meantime and won, which
	 * the caller takes into its list.
	 */
	save(records: readonly T[]): Promise<RecordChange<T>> {
		return this.enqueue(async () => {
			const ids = new Set(records.map(record => record.id));
			const changed = records.filter(record => this.known.get(record.id) !== record && !this.foreign.has(record.id));
			const removed = [...this.known.keys()].filter(id => !ids.has(id));
			const upserted: T[] = [];
			const gone: string[] = [];
			let order = this.now();
			await Promise.all([
				...changed.map(async record => {
					const result = await this.write(record, this.orders.get(record.id) ?? order++);
					if (result.kind === 'theirs') {
						upserted.push(result.record);
					} else if (result.kind === 'deleted') {
						gone.push(record.id);
					}
				}),
				...removed.map(id => this.remove(id)),
			]);
			return { upserted, removed: gone };
		});
	}

	/**
	 * Calls `onChange` with what other windows add, change and remove, read a
	 * moment after their files change. Watching may not be possible; saves
	 * still read a record's file before writing it.
	 */
	watch(onChange: (change: RecordChange<T>) => void): { dispose(): void } {
		this.stopWatching();
		void fs.mkdir(this.dir, { recursive: true }).then(() => {
			try {
				const watcher = watch(this.dir, (_event, name) => {
					if (name && (!name.endsWith('.json') || isQuarantined(name))) {
						return;
					}
					this.pending.add(name ? name.toString() : '');
					this.timer ??= setTimeout(() => {
						this.timer = undefined;
						void this.readChanges().then(change => (change.upserted.length || change.removed.length) && onChange(change));
					}, watchDelayMs);
				});
				watcher.on('error', () => this.stopWatching());
				this.watcher = watcher;
			} catch {
				// No watch: changes from other windows show at the next start.
			}
		}, () => undefined);
		return { dispose: () => this.stopWatching() };
	}

	/** Resolves once every write queued so far is done. */
	async flush(): Promise<void> {
		await this.queue;
	}

	dispose(): void {
		this.stopWatching();
	}

	/** Reads the files that changed, or every file when the watch could not say which. */
	private readChanges(): Promise<RecordChange<T>> {
		const names = [...this.pending];
		this.pending.clear();
		return this.enqueue(async () => {
			const all = names.includes('');
			const files = all ? (await fs.readdir(this.dir).catch(() => [] as string[])).filter(name => name.endsWith('.json') && !isQuarantined(name)) : names;
			const upserted: T[] = [];
			const removed: string[] = [];
			const seen = new Set<string>();
			await Promise.all(files.map(async name => {
				const file = path.join(this.dir, name);
				const text = await fs.readFile(file, 'utf8').catch(() => undefined);
				const id = this.idOf(name);
				if (text === undefined) {
					// Gone without a tombstone, such as by Clean Up.
					if (id !== undefined && this.known.has(id)) {
						this.forget(id);
						removed.push(id);
					}
					return;
				}
				if (id !== undefined && this.texts.get(id) === text) {
					seen.add(id);
					return; // This window's own write, or no change.
				}
				const read = await this.read(file, text, false);
				if (read?.kind === 'record') {
					seen.add(read.record.id);
					upserted.push(read.record);
				} else if (read?.kind === 'deleted') {
					removed.push(read.id);
				}
			}));
			if (all) {
				for (const id of [...this.known.keys()].filter(id => !seen.has(id) && !upserted.some(record => record.id === id))) {
					if (!await fs.access(this.file(id)).then(() => true, () => false)) {
						this.forget(id);
						removed.push(id);
					}
				}
			}
			return { upserted, removed };
		});
	}

	/**
	 * Reads one record's file and remembers it. A file that can't be parsed is
	 * moved aside when `fix` is set (at load), else left for the next load.
	 */
	private async read(file: string, text: string, fix: boolean): Promise<{ readonly kind: 'record'; readonly record: T; readonly order: number } | { readonly kind: 'deleted'; readonly id: string; readonly at: number } | undefined> {
		let envelope: Envelope;
		try {
			const parsed: unknown = JSON.parse(text);
			if (!isRecord(parsed) || typeof parsed.version !== 'number') {
				throw new Error('not a record file');
			}
			envelope = parsed as unknown as Envelope;
		} catch {
			if (fix) {
				const moved = await quarantine(file).catch(() => undefined);
				this.options.onError?.(`${path.basename(file)} could not be read; it was moved to ${moved ? path.basename(moved) : 'nowhere'}.`);
			}
			return undefined;
		}
		if (envelope.version > this.version) {
			const id = isRecord(envelope.record) && typeof envelope.record.id === 'string' ? envelope.record.id : envelope.id;
			if (typeof id === 'string') {
				this.foreign.add(id);
			}
			return undefined;
		}
		if (typeof envelope.deleted === 'number' && typeof envelope.id === 'string') {
			this.forget(envelope.id);
			this.deleted.add(envelope.id);
			this.texts.set(envelope.id, text);
			return { kind: 'deleted', id: envelope.id, at: envelope.deleted };
		}
		const record = envelope.record;
		if (!isRecord(record) || typeof record.id !== 'string') {
			if (fix) {
				await quarantine(file).catch(() => undefined);
				this.options.onError?.(`${path.basename(file)} holds no record; it was moved aside.`);
			}
			return undefined;
		}
		const typed = record as unknown as T;
		const order = typeof envelope.order === 'number' ? envelope.order : 0;
		this.known.set(typed.id, typed);
		this.texts.set(typed.id, text);
		this.orders.set(typed.id, order);
		this.deleted.delete(typed.id);
		return { kind: 'record', record: typed, order };
	}

	/** Writes one record, unless its file now holds another window's newer copy or its tombstone. */
	private async write(record: T, order: number): Promise<{ readonly kind: 'written' } | { readonly kind: 'theirs'; readonly record: T } | { readonly kind: 'deleted' } | { readonly kind: 'skipped' }> {
		const file = this.file(record.id);
		const current = await fs.readFile(file, 'utf8').catch(() => undefined);
		if (current !== undefined && current !== this.texts.get(record.id)) {
			// Changed since this window last saw it.
			const read = await this.read(file, current, true);
			if (read?.kind === 'deleted') {
				return { kind: 'deleted' };
			}
			if (this.foreign.has(record.id)) {
				return { kind: 'skipped' };
			}
			if (read?.kind === 'record' && this.options.newer?.(read.record, record)) {
				return { kind: 'theirs', record: read.record };
			}
		}
		if (this.deleted.has(record.id)) {
			// Removed here or in another window: it stays removed.
			return { kind: 'deleted' };
		}
		const text = JSON.stringify({ version: this.version, order, record });
		try {
			await writeFileAtomic(file, text);
		} catch (err) {
			this.options.onError?.(`${path.basename(file)} could not be saved: ${err instanceof Error ? err.message : String(err)}`);
			return { kind: 'skipped' };
		}
		this.known.set(record.id, record);
		this.texts.set(record.id, text);
		this.orders.set(record.id, order);
		return { kind: 'written' };
	}

	/** Replaces a record's file with its tombstone. */
	private async remove(id: string): Promise<void> {
		const text = JSON.stringify({ version: this.version, id, deleted: this.now() });
		try {
			await writeFileAtomic(this.file(id), text);
		} catch (err) {
			this.options.onError?.(`${path.basename(this.file(id))} could not be removed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		this.forget(id);
		this.deleted.add(id);
		this.texts.set(id, text);
	}

	private forget(id: string): void {
		this.known.delete(id);
		this.orders.delete(id);
	}

	private enqueue<R>(task: () => Promise<R>): Promise<R> {
		const run = this.queue.then(task);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private file(id: string): string {
		return path.join(this.dir, `${fileName(id)}.json`);
	}

	/** The id a file name stands for, when this window knows it. */
	private idOf(name: string): string | undefined {
		const stem = name.replace(/\.json$/, '');
		if (this.known.has(stem) || this.texts.has(stem)) {
			return stem;
		}
		for (const id of this.texts.keys()) {
			if (fileName(id) === stem) {
				return id;
			}
		}
		return undefined;
	}

	private stopWatching(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.watcher?.close();
		this.watcher = undefined;
	}
}

function fileName(id: string): string {
	return id.replace(/[^\w-]/g, '_');
}
