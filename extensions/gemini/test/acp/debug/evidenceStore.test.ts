/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { evidenceCaps, EvidenceStore, TokenBucket } from '../../../src/acp/debug/evidenceStore';

function clock(start = 1000) {
	let now = start;
	return { now: () => now, tick: (ms: number) => { now += ms; } };
}

describe('evidence store', () => {
	it('numbers events per point, keeps first, last and distinct values, and times them from the run', () => {
		const c = clock();
		const store = new EvidenceStore(c.now);
		store.startRun('test');
		c.tick(12);
		store.record('p1', 'values', '{"total":9}');
		c.tick(3);
		store.record('p2', 'snapshot', 'applyDiscount (3 frames)');
		for (const value of ['a', 'b', 'a', 'c', 'd', 'e', 'f', 'g']) {
			c.tick(100);
			store.record('p1', 'values', value);
		}
		const stats = store.pointStats('p1')!;
		expect({
			p1: { hits: stats.hits, first: stats.first, last: stats.last, distinct: [...stats.distinct], other: stats.otherValues },
			ids: store.query({ points: ['p1'] }).map(e => e.id),
			p2: store.get('p2', 1),
			has: [store.has('p1', 9), store.has('p1', 10), store.has('p3', 1)],
			runs: store.runs.map(r => r.label),
		}).toEqual({
			p1: { hits: 9, first: '{"total":9}', last: 'g', distinct: [['{"total":9}', 1], ['a', 2], ['b', 1], ['c', 1], ['d', 1]], other: 3 },
			ids: [1, 2, 3, 4, 5, 6, 7, 8, 9],
			p2: { id: 1, point: 'p2', run: 1, time: 15, kind: 'snapshot', text: 'applyDiscount (3 frames)', redactions: 0 },
			has: [true, false, false],
			runs: ['test'],
		});
	});

	it('drops the oldest events past the count cap and the byte cap, but never the counts', () => {
		const c = clock();
		const store = new EvidenceStore(c.now);
		store.startRun();
		for (let i = 0; i < evidenceCaps.maxEvents + 10; i++) {
			c.tick(100);
			store.record('p1', 'values', `v${i}`);
		}
		const afterCount = { events: store.totals.events, evicted: store.totals.evicted, hits: store.pointStats('p1')!.hits, oldest: store.query({ limit: 1 }).at(-1)?.id, hasOld: store.has('p1', 1) };
		const big = new EvidenceStore(c.now);
		big.startRun();
		for (let i = 0; i < 70; i++) {
			c.tick(100);
			// 20,000 characters, cut to one event's cap of 16 KB on arrival.
			big.record('p1', 'output', 'word '.repeat(4000));
		}
		expect({ afterCount, bigEvents: big.totals.events, bigBytes: big.totals.bytes <= evidenceCaps.maxBytes, bigHits: big.pointStats('p1')!.hits, cut: big.query({ limit: 1 })[0].text.length }).toEqual({
			afterCount: { events: evidenceCaps.maxEvents, evicted: 10, hits: evidenceCaps.maxEvents + 10, oldest: evidenceCaps.maxEvents + 10, hasOld: true },
			bigEvents: 64,
			bigBytes: true,
			bigHits: 70,
			cut: evidenceCaps.maxEventChars,
		});
	});

	it('limits each point to 50 events a second and 50 snapshots a run, counting the excess as drops', () => {
		const c = clock();
		const store = new EvidenceStore(c.now);
		store.startRun();
		const results: string[] = [];
		for (let i = 0; i < 60; i++) {
			const r = store.record('p1', 'values', 'v');
			results.push(r.ok ? 'ok' : r.reason);
		}
		c.tick(1000);
		const later = store.record('p1', 'values', 'v');
		for (let i = 0; i < 60; i++) {
			c.tick(100);
			store.record('p2', 'snapshot', 's');
		}
		store.startRun();
		c.tick(100);
		const nextRun = store.record('p2', 'snapshot', 's');
		expect({
			firstSecond: results.filter(r => r === 'ok').length,
			rateDrops: results.filter(r => r === 'rate').length,
			later: later.ok,
			p1: store.pointStats('p1')!.drops,
			p2: { hits: store.pointStats('p2')!.hits, drops: store.pointStats('p2')!.drops, kept: store.query({ points: ['p2'] }).length },
			nextRun: nextRun.ok,
		}).toEqual({ firstSecond: 50, rateDrops: 10, later: true, p1: 10, p2: { hits: 61, drops: 10, kept: 51 }, nextRun: true });
	});

	it('redacts values as they arrive and counts the redactions', () => {
		const store = new EvidenceStore(() => 1);
		store.startRun();
		const r = store.record('p1', 'values', '{"headers":{"authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"},"n":1}');
		expect({ text: r.ok && r.event.text, redactions: store.pointStats('p1')!.redactions, totals: store.totals.redactions }).toEqual({
			text: '{"headers":{"authorization":"Bearer [redacted]"},"n":1}',
			redactions: 1,
			totals: 1,
		});
	});

	it('keeps runs apart, with their end and exit code, and clears everything at Clean up', () => {
		const c = clock();
		const store = new EvidenceStore(c.now);
		store.startRun('first');
		store.record('p1', 'values', '1');
		c.tick(10);
		store.endRun(1);
		store.startRun('second');
		c.tick(10);
		store.record('p1', 'values', '2');
		store.record('p3', 'values', '3');
		const before = { runs: store.runs, second: store.query({ since: 2 }).map(e => `${e.point}#${e.id}`), counts: [...store.countsInRun(2)], points: store.points };
		store.clear();
		expect({ before, after: { events: store.totals.events, runs: store.runs.length, points: store.points } }).toEqual({
			before: {
				runs: [{ id: 1, label: 'first', startedAt: 1000, endedAt: 1010, exitCode: 1 }, { id: 2, label: 'second', startedAt: 1010 }],
				second: ['p1#2', 'p3#1'],
				counts: [['p1', 1], ['p3', 1]],
				points: ['p1', 'p3'],
			},
			after: { events: 0, runs: 0, points: [] },
		});
	});

	it('refills a token bucket at its rate up to its burst', () => {
		const bucket = new TokenBucket(10, 20, 0);
		const burst = Array.from({ length: 21 }, () => bucket.take(0));
		const afterHalfSecond = [bucket.take(500), bucket.take(500), bucket.take(500), bucket.take(500), bucket.take(500), bucket.take(500)];
		expect({ burst: burst.filter(Boolean).length, afterHalfSecond: afterHalfSecond.filter(Boolean).length, afterLong: bucket.take(100_000) }).toEqual({ burst: 20, afterHalfSecond: 5, afterLong: true });
	});
});
