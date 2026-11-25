/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DailyTokenReader, dayOf, shortCount, tokensIn } from '../../src/acp/dailyTokens';

const now = new Date(2026, 10, 25, 15, 0, 0);
const { from, to } = dayOf(now);
const at = (hour: number, day = 25) => new Date(2026, 10, day, hour).toISOString();
const reply = (id: string, timestamp: string, tokens: Record<string, number>) => JSON.stringify({ id, type: 'gemini', timestamp, content: 'ok', model: 'gemini-3.8-flash', tokens });

describe('the day\'s tokens in a chat file', () => {
	it('adds up what the API reported for each of the model\'s messages today', () => {
		const text = [
			JSON.stringify({ sessionId: 's', startTime: at(9), kind: 'main' }),
			JSON.stringify({ id: 'u1', type: 'user', timestamp: at(9), content: 'Fix the "tokens" count' }),
			reply('g1', at(9), { input: 12_000, output: 300, cached: 4_000, thoughts: 150, tool: 0, total: 12_450 }),
			reply('g2', at(10), { input: 13_000, output: 200, cached: 11_000, thoughts: 0, total: 13_200 }),
		].join('\n');
		expect(tokensIn(text, from, to)).toEqual({ requests: 2, input: 25_000, cached: 15_000, output: 650 });
	});

	it('leaves out other days, and counts a message written twice once, as last written', () => {
		const text = [
			reply('g0', at(23, 24), { input: 9_000, output: 100 }),
			reply('g1', at(9), { input: 1_000, output: 10 }),
			reply('g1', at(9), { input: 1_000, output: 80 }),
			reply('g2', at(0, 26), { input: 5_000, output: 50 }),
		].join('\n');
		expect(tokensIn(text, from, to)).toEqual({ requests: 1, input: 1_000, cached: 0, output: 80 });
	});

	it('skips what is not a message with counts and a time', () => {
		const text = ['not json "tokens"', reply('g1', 'yesterday', { input: 5 }), JSON.stringify({ type: 'gemini', timestamp: at(9), tokens: 'many' }), JSON.stringify({ type: 'user', timestamp: at(9), tokens: { input: 5 } }), reply('g2', at(9), { input: -4, output: Number.NaN })].join('\n');
		expect(tokensIn(text, from, to)).toEqual({ requests: 1, input: 0, cached: 0, output: 0 });
	});
});

describe('the day\'s tokens on this Mac', () => {
	let home: string;
	beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-tokens-')); });
	afterEach(() => fs.rm(home, { recursive: true, force: true }));

	const write = async (project: string, name: string, lines: string[], mtime = now) => {
		const file = path.join(home, 'tmp', project, 'chats', name);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, lines.join('\n'));
		await fs.utimes(file, mtime, mtime);
		return file;
	};

	it('sums every project\'s chats, the terminal\'s too, and is nothing with no chats', async () => {
		const empty = await new DailyTokenReader(home).read(now);
		await write('shop', 'session-1.jsonl', [reply('g1', at(9), { input: 1_000, output: 10, cached: 500 })]);
		await write('docs', 'session-2.jsonl', [reply('g1', at(11), { input: 2_000, output: 20 })]);
		await write('docs', 'notes.txt', [reply('g9', at(11), { input: 9_000, output: 90 })]);
		// Last written yesterday: not opened.
		await write('old', 'session-3.jsonl', [reply('g1', at(11), { input: 7_000, output: 70 })], new Date(2026, 10, 24, 12));
		expect([empty, await new DailyTokenReader(home).read(now)]).toEqual([{ requests: 0, input: 0, cached: 0, output: 0 }, { requests: 2, input: 3_000, cached: 500, output: 30 }]);
	});

	it('reads a file again only when it changed', async () => {
		const reader = new DailyTokenReader(home);
		const file = await write('shop', 'session-1.jsonl', [reply('g1', at(9), { input: 1_000, output: 10 })]);
		const first = await reader.read(now);
		// Same size and time, other content: the kept sum answers.
		await fs.writeFile(file, reply('g1', at(9), { input: 9_000, output: 10 }));
		await fs.utimes(file, now, now);
		const kept = await reader.read(now);
		await write('shop', 'session-1.jsonl', [reply('g1', at(9), { input: 1_000, output: 10 }), reply('g2', at(10), { input: 2_000, output: 20 })], new Date(now.getTime() + 1_000));
		expect([first.input, kept.input, (await reader.read(now)).input]).toEqual([1_000, 1_000, 3_000]);
	});
});

describe('a count as a person reads it', () => {
	it('is whole below a thousand, then in K and M', () => {
		expect([0, 950, 1_000, 12_440, 250_600, 999_499, 999_500, 3_140_000, 120_000_000].map(shortCount)).toEqual(['0', '950', '1K', '12.4K', '251K', '999K', '1M', '3.1M', '120M']);
	});
});
