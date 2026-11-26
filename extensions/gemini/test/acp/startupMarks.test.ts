/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { formatStartupLine, parseStartupLine, StartupMarks, summarizeStartupTimes } from '../../src/acp/startupMarks';

describe('startup marks', () => {
	it('records each mark once, in ms after activation, and writes them in launch order', () => {
		let now = 1_000;
		const marks = new StartupMarks(1_000, () => now);
		now = 1_012;
		marks.mark('product loaded');
		marks.mark('services up', 1_090);
		now = 1_050;
		marks.mark('records loaded');
		// A restart's spawn doesn't move the first one.
		expect(marks.mark('agent spawned', 4_000)).toBe(true);
		expect(marks.mark('agent spawned', 9_000)).toBe(false);
		expect(marks.times()).toEqual({ 'product loaded': 12, 'records loaded': 50, 'services up': 90, 'agent spawned': 3000 });
		expect(marks.at('home shown')).toBeUndefined();
		expect(marks.has('services up')).toBe(true);
		expect(marks.line()).toBe('Startup: product loaded 12 ms, records loaded 50 ms, services up 90 ms, agent spawned 3000 ms after activation');
	});

	it('reads its own line back, with the log prefix in front', () => {
		const times = { 'services up': 90, 'home shown': 140, 'agent spawned': 3000, 'first text': 12_345 };
		expect(parseStartupLine(`2026-10-30 09:34:38.045 [info] ${formatStartupLine(times)}`)).toEqual(times);
		expect(parseStartupLine('2026-10-30 09:34:38.045 [info] Agent ready')).toBeUndefined();
		expect(parseStartupLine('Startup: nothing known after activation')).toBeUndefined();
	});

	it('reads the line of releases before 1.8 as the marks it amounts to', () => {
		const line = '2026-10-29 22:14:48.842 [info] Startup: services up 1658 ms after activation; agent spawned 4868 ms after activation, process ready 6802 ms after spawn, first session ready 18970 ms after spawn';
		expect(parseStartupLine(line)).toEqual({ 'services up': 1658, 'agent spawned': 4868, 'agent ready': 11_670, 'first session': 23_838 });
	});

	it('summarizes launches by mark, leaving out marks no launch reached', () => {
		const summary = summarizeStartupTimes([
			{ 'services up': 300, 'agent spawned': 4000 },
			{ 'services up': 100 },
			{ 'services up': 200, 'agent spawned': 5000, 'first text': 20_000 },
		]);
		expect(summary).toEqual([
			{ name: 'services up', count: 3, median: 200, min: 100, max: 300 },
			{ name: 'agent spawned', count: 2, median: 5000, min: 4000, max: 5000 },
			{ name: 'first text', count: 1, median: 20_000, min: 20_000, max: 20_000 },
		]);
	});
});
