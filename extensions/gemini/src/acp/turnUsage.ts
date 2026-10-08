/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TranscriptItem } from './chatTranscript';

/** Tokens one model used, summed over the model calls of a turn or a chat. */
export interface ModelTokens {
	readonly model: string;
	readonly input: number;
	readonly output: number;
}

/**
 * The token counts gemini-cli puts in a `session/prompt` answer's `_meta`:
 * `quota.model_usage`, one entry per model with `token_count.input_tokens`
 * and `output_tokens`. Input counts every call's whole prompt, so a turn
 * with tool calls counts the conversation once per call, as `/stats` does.
 * Undefined when the agent sent none, as for a slash command it ran itself.
 */
export function readTurnUsage(meta: unknown): ModelTokens[] | undefined {
	const models = (meta as { quota?: { model_usage?: unknown } } | undefined)?.quota?.model_usage;
	if (!Array.isArray(models)) {
		return undefined;
	}
	const usage = sumByModel(models.flatMap(entry => {
		const model = entry?.model;
		const count = entry?.token_count;
		const input = tokenCount(count?.input_tokens);
		const output = tokenCount(count?.output_tokens);
		return typeof model === 'string' && model && (input || output) ? [{ model, input, output }] : [];
	}));
	return usage.length ? usage : undefined;
}

function tokenCount(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** One entry per model, most tokens first. */
export function sumByModel(entries: Iterable<ModelTokens>): ModelTokens[] {
	const byModel = new Map<string, ModelTokens>();
	for (const { model, input, output } of entries) {
		const sum = byModel.get(model);
		byModel.set(model, { model, input: (sum?.input ?? 0) + input, output: (sum?.output ?? 0) + output });
	}
	return [...byModel.values()].sort((a, b) => b.input + b.output - a.input - a.output || a.model.localeCompare(b.model));
}

export interface ChatUsage {
	/** Turns that ended, counted or not. */
	readonly turns: number;
	/** Turns whose token counts are known; turns saved before GeminiCode kept them have none. */
	readonly countedTurns: number;
	readonly input: number;
	readonly output: number;
	readonly models: readonly ModelTokens[];
}

/** What a chat's turns used, from the token counts on its turn ends. */
export function chatUsage(items: readonly TranscriptItem[]): ChatUsage {
	let turns = 0;
	let countedTurns = 0;
	const entries: ModelTokens[] = [];
	for (const item of items) {
		if (item.kind !== 'turnEnd') {
			continue;
		}
		turns++;
		if (item.usage?.length) {
			countedTurns++;
			entries.push(...item.usage);
		}
	}
	const models = sumByModel(entries);
	return {
		turns,
		countedTurns,
		input: models.reduce((sum, m) => sum + m.input, 0),
		output: models.reduce((sum, m) => sum + m.output, 0),
		models,
	};
}
