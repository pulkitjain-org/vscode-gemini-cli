/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The record of what a debug session put into the world (DEBUG_MODE.md,
// Records and crash recovery): its points, marked regions, the debug
// sessions it started, the log file grant and the route, so the next start
// after a crash or a reload can remove the breakpoints and offer the regions
// for Clean up. It holds no evidence, no token and no value. Writes are
// batched to one per 500 ms and never leave half a file.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isRecord, privateWrite, writeJsonAtomic } from '../fsUtil';
import type { PointKind } from './points';
import type { RegionRecord } from './regions';

export interface RecordedPoint {
	readonly id: string;
	readonly kind: PointKind;
	readonly file: string;
	readonly line: number;
	readonly condition?: string;
	readonly message?: string;
}

export interface DebugRecord {
	readonly version: 1;
	readonly agent: string;
	readonly nonce: string;
	readonly folder: string;
	/** The bug, in a few words, for Home's Unfinished list. */
	readonly title: string;
	readonly startedAt: number;
	readonly points: readonly RecordedPoint[];
	readonly regions: readonly RegionRecord[];
	/** The marker (`__geminiDebug`) of each debug session it started. */
	readonly sessions: readonly string[];
	readonly logFile?: string;
	/** The endpoint's port while a route is open; never the token. */
	readonly routePort?: number;
}

export const recordWriteDelayMs = 500;

/** `<globalStorage>/debug/<agent>.json`. */
export function recordPath(globalStorage: string, agent: string): string {
	return path.join(globalStorage, 'debug', `${agent.replace(/[^\w-]/g, '_')}.json`);
}

/** Whether the record lists anything still in the world: what blocks Keep Changes and commits. */
export function recordIsEmpty(record: DebugRecord): boolean {
	return !record.points.length && !record.regions.length && !record.sessions.length && !record.logFile && record.routePort === undefined;
}

export function writeDebugRecord(file: string, record: DebugRecord): Promise<void> {
	return writeJsonAtomic(file, record, { ...privateWrite, indent: '\t' });
}

/** The record in `file`, or undefined when there is none or it cannot be read as one. */
export async function readDebugRecord(file: string): Promise<DebugRecord | undefined> {
	let text: string;
	try {
		text = await fs.readFile(file, 'utf8');
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	return asRecord(parsed);
}

function asRecord(value: unknown): DebugRecord | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.agent !== 'string' || typeof value.nonce !== 'string' || typeof value.folder !== 'string') {
		return undefined;
	}
	const list = <T>(items: unknown, check: (item: Record<string, unknown>) => T | undefined): T[] =>
		Array.isArray(items) ? items.map(item => isRecord(item) ? check(item) : undefined).filter((item): item is T => item !== undefined) : [];
	return {
		version: 1,
		agent: value.agent,
		nonce: value.nonce,
		folder: value.folder,
		title: typeof value.title === 'string' ? value.title : '',
		startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0,
		points: list<RecordedPoint>(value.points, p => typeof p.id === 'string' && typeof p.file === 'string' && typeof p.line === 'number' && (p.kind === 'logpoint' || p.kind === 'breakpoint' || p.kind === 'marked')
			? { id: p.id, kind: p.kind, file: p.file, line: p.line, ...typeof p.condition === 'string' ? { condition: p.condition } : {}, ...typeof p.message === 'string' ? { message: p.message } : {} }
			: undefined),
		regions: list<RegionRecord>(value.regions, r => typeof r.file === 'string' && typeof r.point === 'string' && typeof r.nonce === 'string' && typeof r.text === 'string' && typeof r.normalized === 'string' && typeof r.line === 'number'
			? { file: r.file, point: r.point, nonce: r.nonce, text: r.text, normalized: r.normalized, line: r.line }
			: undefined),
		sessions: Array.isArray(value.sessions) ? value.sessions.filter((s): s is string => typeof s === 'string') : [],
		...typeof value.logFile === 'string' ? { logFile: value.logFile } : {},
		...typeof value.routePort === 'number' ? { routePort: value.routePort } : {},
	};
}

export async function deleteDebugRecord(file: string): Promise<void> {
	await fs.rm(file, { force: true });
}

/** Every record under `<globalStorage>/debug`: the Debug modes that did not end. */
export async function listDebugRecords(globalStorage: string): Promise<readonly { readonly file: string; readonly record: DebugRecord }[]> {
	const dir = path.join(globalStorage, 'debug');
	const names = await fs.readdir(dir).catch(() => [] as string[]);
	const found: { file: string; record: DebugRecord }[] = [];
	for (const name of names.filter(n => n.endsWith('.json')).sort()) {
		const file = path.join(dir, name);
		const record = await readDebugRecord(file);
		if (record) {
			found.push({ file, record });
		}
	}
	return found;
}

/** Writes a record at most once per `delayMs`, the latest version, and never on the caller's path. */
export class DebugRecordWriter {

	private pending: DebugRecord | undefined;
	private timer: NodeJS.Timeout | undefined;
	private writing: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(readonly file: string, private readonly delayMs: number = recordWriteDelayMs, private readonly write: (file: string, record: DebugRecord) => Promise<void> = writeDebugRecord) { }

	/** Queues `record` as the next write. */
	update(record: DebugRecord): void {
		if (this.disposed) {
			return;
		}
		this.pending = record;
		this.timer ??= setTimeout(() => void this.flush(), this.delayMs);
	}

	/** Writes the queued record now; resolves when it is on disk. */
	flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const record = this.pending;
		this.pending = undefined;
		if (record) {
			this.writing = this.writing.then(() => this.write(this.file, record)).catch(() => undefined);
		}
		return this.writing;
	}

	/** Drops any queued write and deletes the record, at Clean up. */
	async delete(): Promise<void> {
		this.dispose();
		await this.writing;
		await deleteDebugRecord(this.file);
	}

	dispose(): void {
		this.disposed = true;
		this.pending = undefined;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
