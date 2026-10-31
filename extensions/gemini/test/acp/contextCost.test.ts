/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { allowedServersFor, contextBreakdown, heavyReadings, measureCalls, measureContextCost, ProbeVariant } from '../../src/acp/contextCost';

// The numbers measured on cms-vca2 with gemini-3.8-flash.
const tokens = (variant: ProbeVariant) => {
	switch (variant.kind) {
		case 'empty': return 9_620;
		case 'context': return 32_209;
		case 'geminicode': return 33_400;
		case 'server': return variant.server === 'gitlab' ? 52_743 : 43_013;
		case 'all': return 64_740;
	}
};

describe('measureContextCost', () => {
	it('keeps each test prompt\'s reading as the CLI reported it, one row per prompt, without working out any part', async () => {
		const asked: string[] = [];
		const cost = await measureContextCost(['jira', 'gitlab'], async variant => {
			asked.push(variant.kind === 'server' ? variant.server : variant.kind);
			return tokens(variant);
		}, () => 7);
		expect({ cost, asked: asked.sort(), calls: measureCalls(2) }).toEqual({
			cost: {
				total: 64_740,
				readings: [
					{ kind: 'empty', tokens: 9_620 },
					{ kind: 'folder', tokens: 32_209 },
					{ kind: 'server', server: 'jira', tokens: 43_013 },
					{ kind: 'server', server: 'gitlab', tokens: 52_743 },
					{ kind: 'geminicode', tokens: 33_400 },
					{ kind: 'all', tokens: 64_740 },
				],
				measuredAt: 7,
			},
			asked: ['all', 'context', 'empty', 'geminicode', 'gitlab', 'jira'],
			calls: 6,
		});
	});

	it('allows only the servers a variant measures', () => {
		expect([
			allowedServersFor({ kind: 'all', servers: ['a', 'b'] }),
			allowedServersFor({ kind: 'server', server: 'a' }),
			allowedServersFor({ kind: 'context' }),
		]).toEqual([['a', 'b'], ['a'], ['__geminicode_none__']]);
	});
});

describe('heavyReadings', () => {
	it('names a server whose reading is one and a half times the folder\'s, and the context files when the folder\'s is that much more than an empty one\'s', () => {
		const readings = [
			{ kind: 'empty' as const, tokens: 9_620 },
			{ kind: 'folder' as const, tokens: 32_209 },
			{ kind: 'server' as const, server: 'jira', tokens: 43_013 },
			{ kind: 'server' as const, server: 'gitlab', tokens: 52_743 },
			{ kind: 'geminicode' as const, tokens: 33_400 },
			{ kind: 'all' as const, tokens: 64_740 },
		];
		expect({
			measured: heavyReadings({ readings }),
			light: heavyReadings({ readings: readings.map(reading => reading.kind === 'folder' ? { ...reading, tokens: 12_000 } : reading.kind === 'server' ? { ...reading, tokens: 15_000 } : reading) }),
			none: heavyReadings({ readings: [] }),
		}).toEqual({
			measured: { servers: ['gitlab'], context: true },
			light: { servers: [], context: false },
			none: { servers: [], context: false },
		});
	});
});

describe('contextBreakdown', () => {
	it('gives the usage popover the readings, the total, and the rule files largest first, by name', () => {
		const cost = {
			total: 64_740,
			readings: [{ kind: 'empty' as const, tokens: 9_620 }, { kind: 'folder' as const, tokens: 32_209 }, { kind: 'all' as const, tokens: 64_740 }],
			measuredAt: 7,
			rules: [{ path: '/w/AGENTS.md', bytes: 4_000 }, { path: '/w/GEMINI.md', bytes: 70_656 }],
		};
		expect({
			none: contextBreakdown(undefined, false),
			measuring: contextBreakdown(undefined, true).state,
			failed: contextBreakdown(undefined, false, 'No quota'),
			ready: contextBreakdown(cost, false),
			again: contextBreakdown(cost, true).state,
		}).toEqual({
			none: { state: 'none' },
			measuring: 'measuring',
			failed: { state: 'failed', error: 'No quota' },
			ready: {
				state: 'ready',
				measuredAt: 7,
				readings: cost.readings,
				total: 64_740,
				rules: [{ name: 'GEMINI.md', path: '/w/GEMINI.md', bytes: 70_656 }, { name: 'AGENTS.md', path: '/w/AGENTS.md', bytes: 4_000 }],
			},
			again: 'measuring',
		});
	});
});
