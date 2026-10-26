/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { allowedServersFor, contextBreakdown, measureContextCost, ProbeVariant } from '../../src/acp/contextCost';

describe('measureContextCost', () => {
	it('splits a call into the CLI, the context files, each server and GeminiCode\'s own', async () => {
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
		const asked: string[] = [];
		const cost = await measureContextCost(['jira', 'gitlab'], async variant => {
			asked.push(variant.kind === 'server' ? variant.server : variant.kind);
			return tokens(variant);
		}, () => 7);
		expect(cost).toEqual({
			total: 64_740,
			cli: 9_620,
			context: 22_589,
			geminicode: 1_191,
			servers: [{ name: 'gitlab', tokens: 20_534 }, { name: 'jira', tokens: 10_804 }],
			measuredAt: 7,
		});
		expect(asked.sort()).toEqual(['all', 'context', 'empty', 'geminicode', 'gitlab', 'jira']);
	});

	it('allows only the servers a variant measures', () => {
		expect([
			allowedServersFor({ kind: 'all', servers: ['a', 'b'] }),
			allowedServersFor({ kind: 'server', server: 'a' }),
			allowedServersFor({ kind: 'context' }),
		]).toEqual([['a', 'b'], ['a'], ['__geminicode_none__']]);
	});
});

describe('contextBreakdown', () => {
	it('gives the usage popover each part, the servers together, and the rule files largest first, by name', () => {
		const cost = {
			total: 64_740, cli: 9_620, context: 22_589, geminicode: 1_191,
			servers: [{ name: 'gitlab', tokens: 20_534 }, { name: 'jira', tokens: 10_804 }],
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
				parts: { cli: 9_620, rules: 22_589, geminicode: 1_191, servers: 2, serverTokens: 31_338, total: 64_740 },
				rules: [{ name: 'GEMINI.md', path: '/w/GEMINI.md', bytes: 70_656 }, { name: 'AGENTS.md', path: '/w/AGENTS.md', bytes: 4_000 }],
			},
			again: 'measuring',
		});
	});
});
