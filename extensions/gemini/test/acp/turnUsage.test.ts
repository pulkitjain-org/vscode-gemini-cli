/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../../src/acp/chatTranscript';
import { chatUsage, readTurnUsage } from '../../src/acp/turnUsage';

/** `_meta` as gemini-cli 0.62 sends it with a `session/prompt` answer. */
function meta(models: unknown): unknown {
	return { quota: { token_count: { input_tokens: 0, output_tokens: 0 }, model_usage: models } };
}

describe('readTurnUsage', () => {
	it('reads the tokens per model', () => {
		expect(readTurnUsage(meta([
			{ model: 'gemini-3.5-flash-lite', token_count: { input_tokens: 900, output_tokens: 20 } },
			{ model: 'gemini-3.8-flash', token_count: { input_tokens: 41_000, output_tokens: 1_200 } },
		]))).toEqual([
			{ model: 'gemini-3.8-flash', input: 41_000, output: 1_200 },
			{ model: 'gemini-3.5-flash-lite', input: 900, output: 20 },
		]);
	});

	it('leaves out empty and malformed entries', () => {
		expect(readTurnUsage(meta([]))).toBeUndefined();
		expect(readTurnUsage(meta([{ model: 'm', token_count: { input_tokens: 0, output_tokens: 0 } }]))).toBeUndefined();
		expect(readTurnUsage(meta([{ token_count: { input_tokens: 5 } }, { model: 'm', token_count: { input_tokens: 'x', output_tokens: -1 } }, null]))).toBeUndefined();
		expect(readTurnUsage(meta([{ model: 'm', token_count: { input_tokens: 7.4 } }]))).toEqual([{ model: 'm', input: 7, output: 0 }]);
	});

	it('is undefined without gemini-cli\'s counts', () => {
		expect(readTurnUsage(undefined)).toBeUndefined();
		expect(readTurnUsage({})).toBeUndefined();
		expect(readTurnUsage({ quota: {} })).toBeUndefined();
	});
});

describe('chatUsage', () => {
	it('sums the turns per model', () => {
		const items: TranscriptItem[] = [
			{ id: '1', kind: 'user', text: 'a' },
			{ id: '2', kind: 'turnEnd', durationMs: 1, usage: [{ model: 'flash', input: 100, output: 10 }] },
			{ id: '3', kind: 'user', text: 'b' },
			{ id: '4', kind: 'turnEnd', durationMs: 1, usage: [{ model: 'flash', input: 300, output: 30 }, { model: 'pro', input: 50, output: 5 }] },
			{ id: '5', kind: 'turnEnd', durationMs: 1 },
		];
		expect(chatUsage(items)).toEqual({
			turns: 3,
			countedTurns: 2,
			input: 450,
			output: 45,
			models: [{ model: 'flash', input: 400, output: 40 }, { model: 'pro', input: 50, output: 5 }],
		});
	});

	it('is empty for a chat without turns', () => {
		expect(chatUsage([])).toEqual({ turns: 0, countedTurns: 0, input: 0, output: 0, models: [] });
	});
});
