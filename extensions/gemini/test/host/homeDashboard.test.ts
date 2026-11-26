/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => import('./vscodeStub'));
import type { DailyTokens } from '../../src/acp/dailyTokens';
import { buildDashboard, type DashboardInput } from '../../src/host/homeDashboard';

/** Home's Gemini card for a window with no team tools, with the day's tokens as given. */
function geminiRows(tokens?: DailyTokens, usage?: DashboardInput['usage']): string[] {
	const dashboard = buildDashboard({
		now: new Date(2026, 10, 25, 15), connected: new Set(), state: () => ({ kind: 'off' }), data: {}, agents: [],
		versions: { app: '1.9.0', cli: '0.71.1' }, signedIn: true, projectsOn: false, refreshing: false, hideUnconnected: false,
		...tokens ? { tokens } : {}, ...usage ? { usage } : {},
	});
	return dashboard.cards.find(card => card.id === 'gemini')!.rows.map(row => row.title);
}

describe('Home\'s Gemini card', () => {
	it('shows what the CLI\'s chat files say it used today, under the day\'s share of requests', () => {
		expect(geminiRows({ requests: 1_240, input: 3_140_000, cached: 2_400_000, output: 45_600 }, [{ model: 'gemini-3.8-flash', used: 0.42 }])).toEqual([
			'Today: 42% of daily requests',
			'Today on this Mac: 1,240 requests, 3.1M tokens in (2.4M from cache), 45.6K out',
			'GeminiCode 1.9.0 · CLI 0.71.1',
		]);
	});

	it('leaves the cache out when nothing came from it, and the row out before the first request or reading', () => {
		expect([geminiRows({ requests: 3, input: 9_000, cached: 0, output: 120 }), geminiRows({ requests: 0, input: 0, cached: 0, output: 0 }), geminiRows()]).toEqual([
			['Today on this Mac: 3 requests, 9K tokens in, 120 out', 'GeminiCode 1.9.0 · CLI 0.71.1'],
			['GeminiCode 1.9.0 · CLI 0.71.1'],
			['GeminiCode 1.9.0 · CLI 0.71.1'],
		]);
	});
});
