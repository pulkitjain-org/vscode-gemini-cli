/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The evidence of one debug session (DEBUG_MODE.md, Evidence for the model):
// events in a ring buffer capped by count and by text size, counts per point
// that never drop (hits, drops, redactions, the first and last value, up to
// five distinct values), and runs, so evidence can be read per run and two
// runs compared. Values are redacted as they arrive, so the store never
// holds a credential. Nothing here is ever written to disk.

import { redact } from '../redact';

export type EventKind = 'values' | 'snapshot' | 'output' | 'exit';

export interface EvidenceEvent {
	/** Per point, from 1: the `12` of `p3#12`. */
	readonly id: number;
	readonly point: string;
	readonly run: number;
	/** Milliseconds since the run started. */
	readonly time: number;
	readonly kind: EventKind;
	/** The payload: a values JSON line, a snapshot's text, an output line. */
	readonly text: string;
	readonly redactions: number;
}

export interface PointStats {
	readonly hits: number;
	readonly drops: number;
	readonly redactions: number;
	readonly first?: string;
	readonly last?: string;
	/** Up to `maxDistinct` distinct values with their counts, in order of first appearance. */
	readonly distinct: ReadonlyMap<string, number>;
	/** Hits whose value was not among the kept distinct ones. */
	readonly otherValues: number;
}

export interface Run {
	readonly id: number;
	readonly label: string;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly exitCode?: number;
}

export const evidenceCaps = {
	maxEvents: 2000,
	maxBytes: 1024 * 1024,
	/** One event's text: the endpoint's whole body cap, so no single line fills the store. */
	maxEventChars: 16 * 1024,
	maxDistinct: 5,
	/** Events per point per second; excess is counted, never stored. */
	perPointPerSecond: 50,
	/** A breakpoint hit more often than this in a run only counts. */
	maxSnapshotsPerRun: 50,
} as const;

/** A token bucket: `rate` tokens a second, holding at most `burst`. */
export class TokenBucket {

	private tokens: number;
	private last: number;

	constructor(private readonly rate: number, private readonly burst: number, now: number) {
		this.tokens = burst;
		this.last = now;
	}

	/** Takes one token if there is one. */
	take(now: number): boolean {
		const elapsed = Math.max(0, now - this.last) / 1000;
		this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
		this.last = now;
		if (this.tokens < 1) {
			return false;
		}
		this.tokens -= 1;
		return true;
	}
}

interface MutableStats {
	hits: number;
	drops: number;
	redactions: number;
	first?: string;
	last?: string;
	distinct: Map<string, number>;
	otherValues: number;
	nextId: number;
	snapshotsThisRun: number;
	bucket?: TokenBucket;
}

export interface EvidenceQuery {
	readonly points?: readonly string[];
	/** Only this run and later. */
	readonly since?: number;
	readonly limit?: number;
}

export type RecordResult = { readonly ok: true; readonly event: EvidenceEvent } | { readonly ok: false; readonly reason: 'rate' | 'snapshots' };

export class EvidenceStore {

	private readonly events: EvidenceEvent[] = [];
	private bytes = 0;
	private readonly stats = new Map<string, MutableStats>();
	private readonly runList: Run[] = [];
	private evicted = 0;

	constructor(private readonly now: () => number = Date.now) { }

	/** Starts a run (a reproduction); returns its id, from 1. */
	startRun(label = ''): number {
		const id = this.runList.length + 1;
		this.runList.push({ id, label: label || `Run ${id}`, startedAt: this.now() });
		for (const stats of this.stats.values()) {
			stats.snapshotsThisRun = 0;
		}
		return id;
	}

	/** Ends the current run, with the program's exit code when it exited. */
	endRun(exitCode?: number): void {
		const run = this.runList[this.runList.length - 1];
		if (run && run.endedAt === undefined) {
			this.runList[this.runList.length - 1] = { ...run, endedAt: this.now(), ...exitCode === undefined ? {} : { exitCode } };
		}
	}

	/** The runs so far, a copy: `clear` empties the store's own list. */
	get runs(): readonly Run[] {
		return this.runList.slice();
	}

	get currentRun(): Run | undefined {
		return this.runList[this.runList.length - 1];
	}

	/** Records an event for `point`, unless its rate or snapshot cap drops it; drops are counted. */
	record(point: string, kind: EventKind, text: string): RecordResult {
		const now = this.now();
		const stats = this.statsFor(point);
		if (!this.currentRun) {
			this.startRun();
		}
		const run = this.currentRun as Run;
		stats.bucket ??= new TokenBucket(evidenceCaps.perPointPerSecond, evidenceCaps.perPointPerSecond, now);
		if (!stats.bucket.take(now)) {
			stats.drops++;
			return { ok: false, reason: 'rate' };
		}
		if (kind === 'snapshot') {
			if (stats.snapshotsThisRun >= evidenceCaps.maxSnapshotsPerRun) {
				stats.hits++;
				stats.drops++;
				return { ok: false, reason: 'snapshots' };
			}
			stats.snapshotsThisRun++;
		}
		const cut = text.length > evidenceCaps.maxEventChars ? text.slice(0, evidenceCaps.maxEventChars) : text;
		const clean = redact(cut);
		const redactions = countRedactions(clean) - countRedactions(cut);
		stats.hits++;
		stats.redactions += redactions;
		stats.first ??= clean;
		stats.last = clean;
		const seen = stats.distinct.get(clean);
		if (seen !== undefined) {
			stats.distinct.set(clean, seen + 1);
		} else if (stats.distinct.size < evidenceCaps.maxDistinct) {
			stats.distinct.set(clean, 1);
		} else {
			stats.otherValues++;
		}
		const event: EvidenceEvent = { id: stats.nextId++, point, run: run.id, time: Math.max(0, now - run.startedAt), kind, text: clean, redactions };
		this.events.push(event);
		this.bytes += clean.length;
		this.evict();
		return { ok: true, event };
	}

	/** Counts a drop that happened before the store (the endpoint's limits). */
	drop(point: string): void {
		this.statsFor(point).drops++;
	}

	/** Whether `p3#12` names an event this store has or had (an evicted event still counted as a hit). */
	has(point: string, id: number): boolean {
		const stats = this.stats.get(point);
		return !!stats && id >= 1 && id < stats.nextId;
	}

	get(point: string, id: number): EvidenceEvent | undefined {
		return this.events.find(e => e.point === point && e.id === id);
	}

	pointStats(point: string): PointStats | undefined {
		const stats = this.stats.get(point);
		return stats ? { hits: stats.hits, drops: stats.drops, redactions: stats.redactions, first: stats.first, last: stats.last, distinct: stats.distinct, otherValues: stats.otherValues } : undefined;
	}

	/** The points with any event or drop. */
	get points(): readonly string[] {
		return [...this.stats.keys()];
	}

	/** The events matching `query`, oldest first; `limit` keeps the newest. */
	query(query: EvidenceQuery = {}): readonly EvidenceEvent[] {
		let matched = this.events.filter(e => (!query.points || query.points.includes(e.point)) && (query.since === undefined || e.run >= query.since));
		if (query.limit !== undefined && matched.length > query.limit) {
			matched = matched.slice(matched.length - query.limit);
		}
		return matched;
	}

	/** Counts for the bar and the reproduce card. */
	get totals(): { readonly events: number; readonly evicted: number; readonly bytes: number; readonly drops: number; readonly redactions: number; readonly hits: number } {
		let drops = 0;
		let redactions = 0;
		let hits = 0;
		for (const stats of this.stats.values()) {
			drops += stats.drops;
			redactions += stats.redactions;
			hits += stats.hits;
		}
		return { events: this.events.length, evicted: this.evicted, bytes: this.bytes, drops, redactions, hits };
	}

	/** Hits per point, as the live count shows them. */
	counts(): ReadonlyMap<string, number> {
		return new Map([...this.stats].map(([point, stats]) => [point, stats.hits]));
	}

	/** Hits per point within one run. */
	countsInRun(run: number): ReadonlyMap<string, number> {
		const counts = new Map<string, number>();
		for (const event of this.events) {
			if (event.run === run) {
				counts.set(event.point, (counts.get(event.point) ?? 0) + 1);
			}
		}
		return counts;
	}

	/** Drops everything, at Clean up. */
	clear(): void {
		this.events.length = 0;
		this.bytes = 0;
		this.stats.clear();
		this.runList.length = 0;
		this.evicted = 0;
	}

	private statsFor(point: string): MutableStats {
		let stats = this.stats.get(point);
		if (!stats) {
			stats = { hits: 0, drops: 0, redactions: 0, distinct: new Map(), otherValues: 0, nextId: 1, snapshotsThisRun: 0 };
			this.stats.set(point, stats);
		}
		return stats;
	}

	private evict(): void {
		let removed = 0;
		while (this.events.length - removed > 0 && (this.events.length - removed > evidenceCaps.maxEvents || this.bytes > evidenceCaps.maxBytes)) {
			this.bytes -= this.events[removed].text.length;
			removed++;
		}
		if (removed) {
			this.events.splice(0, removed);
			this.evicted += removed;
		}
	}
}

function countRedactions(text: string): number {
	let count = 0;
	let index = -1;
	while ((index = text.indexOf('[redacted]', index + 1)) >= 0) {
		count++;
	}
	return count;
}
