/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { describePoint, LineOwnership, logpointMessage, matchOutputLine, pointLimits, PointSet } from '../../../src/acp/debug/points';

describe('points', () => {
	it('gives ids in order, never reuses one, and frees a removed point\'s line', () => {
		const set = new PointSet('agent-1', 'gc7f3a');
		const first = set.add({ kind: 'logpoint', file: 'cart.ts', line: 42, hypothesis: 'h1', expressions: ['cart.total'] });
		const same = set.add({ kind: 'breakpoint', file: 'cart.ts', line: 42, hypothesis: 'h1' });
		const removed = set.remove('p1');
		const again = set.add({ kind: 'breakpoint', file: 'cart.ts', line: 42, hypothesis: 'h2', hold: true });
		expect({ first: first.ok && first.point.id, same: same.ok ? 'ok' : same.error, removed, again: again.ok && again.point.id, removedTwice: set.remove('p1'), counts: set.counts() }).toEqual({
			first: 'p1',
			same: 'This session already has a point at cart.ts:42 (p1).',
			removed: true,
			again: 'p2',
			removedTwice: false,
			counts: { logpoints: 0, breakpoints: 1, marked: 0, files: 1 },
		});
	});

	it('refuses a line another agent holds, and frees every line at Clean up', () => {
		const lines = new LineOwnership();
		const a = new PointSet('agent-a', 'aaaa1111', lines);
		const b = new PointSet('agent-b', 'bbbb2222', lines);
		a.add({ kind: 'logpoint', file: 'cart.ts', line: 10, hypothesis: 'h1', expressions: ['x'] });
		const refused = b.add({ kind: 'logpoint', file: 'cart.ts', line: 10, hypothesis: 'h1', expressions: ['x'] });
		lines.releaseAll('agent-a');
		const allowed = b.add({ kind: 'logpoint', file: 'cart.ts', line: 10, hypothesis: 'h1', expressions: ['x'] });
		expect([refused.ok ? 'ok' : refused.error, allowed.ok]).toEqual(['Another agent\'s point is on cart.ts:10: choose another line.', true]);
	});

	it('holds the limits: 20 debugger points, 12 marked lines, 8 files, 8 expressions', () => {
		const set = new PointSet('agent-1', 'gc7f3a');
		const errors: string[] = [];
		for (let i = 1; i <= pointLimits.debuggerPoints + 1; i++) {
			const r = set.add({ kind: 'logpoint', file: 'a.ts', line: i, hypothesis: 'h1', expressions: ['x'] });
			if (!r.ok) {
				errors.push(r.error);
			}
		}
		for (let i = 1; i <= pointLimits.markedLines + 1; i++) {
			const r = set.add({ kind: 'marked', file: 'b.ts', line: i, hypothesis: 'h1', expressions: ['x'] });
			if (!r.ok) {
				errors.push(r.error);
			}
		}
		set.removeAll();
		for (let i = 1; i <= pointLimits.files + 1; i++) {
			const r = set.add({ kind: 'logpoint', file: `f${i}.ts`, line: 1, hypothesis: 'h1', expressions: ['x'] });
			if (!r.ok) {
				errors.push(r.error);
			}
		}
		const many = set.add({ kind: 'logpoint', file: 'f1.ts', line: 2, hypothesis: 'h1', expressions: Array.from({ length: 9 }, (_, i) => `e${i}`) });
		errors.push(many.ok ? 'ok' : many.error);
		expect(errors).toEqual([
			'This debug session already has 20 debugger points, the most it can hold: remove one (debug_remove) first.',
			'This debug session already has 12 marked lines, the most it can hold: remove one (debug_remove) first.',
			'Points are already in 8 files, the most a debug session observes at once: remove some first.',
			'At most 8 expressions per point.',
		]);
	});

	it('builds the logpoint message and matches output lines back to their point', () => {
		const set = new PointSet('agent-1', 'gc7f3a');
		set.add({ kind: 'logpoint', file: 'cart.ts', line: 42, hypothesis: 'h1', expressions: ['cart.total', 'n'] });
		expect({
			message: logpointMessage('gc7f3a', 'p1', ['cart.total', 'n']),
			matched: matchOutputLine('@@gc:gc7f3a:p1@@ {"cart.total":9,"n":2}'),
			mine: set.match('@@gc:gc7f3a:p1@@ {"cart.total":9}')?.point.id,
			other: set.match('@@gc:other1:p1@@ {}'),
			plain: matchOutputLine('server listening on 3001'),
			unknownPoint: set.match('@@gc:gc7f3a:p9@@ {}'),
		}).toEqual({
			message: '@@gc:gc7f3a:p1@@ {"cart.total":{cart.total},"n":{n}}',
			matched: { nonce: 'gc7f3a', point: 'p1', payload: '{"cart.total":9,"n":2}' },
			mine: 'p1',
			other: undefined,
			plain: undefined,
			unknownPoint: undefined,
		});
	});

	it('describes points for the bar and the prompt, and marks the user\'s and unbound ones', () => {
		const set = new PointSet('agent-1', 'gc7f3a');
		set.add({ kind: 'breakpoint', file: 'cart.ts', line: 88, hypothesis: 'h2', condition: 'n > 1', hitCount: 3, hold: true });
		set.add({ kind: 'marked', file: 'checkout.js', line: 17, hypothesis: 'h2', expressions: ['total'], channel: 'http' });
		set.add({ kind: 'logpoint', file: 'cart.ts', line: 42, hypothesis: 'h1', expressions: ['cart.total'] });
		set.disown('p1');
		set.setBound('p3', false);
		expect(set.all.map(p => describePoint(p, p.id === 'p2' ? 4 : undefined))).toEqual([
			'p1 cart.ts:88 h2 breakpoint if n > 1, hit count 3, hold (edited by the user)',
			'p2 checkout.js:17 h2 marked line (http) total - 4 hits',
			'p3 cart.ts:42 h1 logpoint cart.total (not bound)',
		]);
	});
});
