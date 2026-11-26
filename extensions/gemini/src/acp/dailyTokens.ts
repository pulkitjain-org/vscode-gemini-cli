/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The tokens the Gemini CLI used today, from the chat files it writes
// (~/.gemini/tmp/<project>/chats/session-*.jsonl): each of the model's
// messages carries the counts the API reported for its request. They are the
// CLI's own numbers, so they may be shown; nothing here estimates. Every
// project's chats count, the terminal's too: the day's use is the account's
// on this Mac, not one agent's.
//
// Read only: a file changed today is read whole and summed, and its sum is
// kept until the file changes again.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface DailyTokens {
	/** Requests to the model: one message with token counts each. */
	readonly requests: number;
	/** Tokens sent, cached ones included. */
	readonly input: number;
	/** Of `input`, the tokens the API served from its cache. */
	readonly cached: number;
	/** Tokens of the replies, with the model's thinking. */
	readonly output: number;
}

/** A chat file larger than this is not read: 64 MB is hundreds of long sessions in one file, and reading it would stall the extension host. */
const maxFileBytes = 64 * 1024 * 1024;

const none = (): DailyTokens => ({ requests: 0, input: 0, cached: 0, output: 0 });

function add(a: DailyTokens, b: DailyTokens): DailyTokens {
	return { requests: a.requests + b.requests, input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output };
}

/** The first and last moments of `now`'s day, on this Mac's clock. */
export function dayOf(now: Date): { readonly from: number; readonly to: number } {
	const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	return { from, to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() };
}

/**
 * What the model's messages in one chat file add up to between `from` and
 * `to`. A message written twice (the CLI rewrites one as its reply grows)
 * counts once, as it was last written. Lines that are not a message with
 * token counts and a time are skipped.
 */
export function tokensIn(text: string, from: number, to: number): DailyTokens {
	const byId = new Map<string, DailyTokens>();
	let unnamed = 0;
	for (const line of text.split('\n')) {
		if (!line.includes('"tokens"')) {
			continue;
		}
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		const message = record as { type?: unknown; id?: unknown; timestamp?: unknown; tokens?: Record<string, unknown> };
		const at = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
		if (message.type !== 'gemini' || !message.tokens || typeof message.tokens !== 'object' || !(at >= from && at < to)) {
			continue;
		}
		const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
		const tokens = message.tokens;
		byId.set(typeof message.id === 'string' ? message.id : `#${unnamed++}`, {
			requests: 1, input: count(tokens.input), cached: count(tokens.cached), output: count(tokens.output) + count(tokens.thoughts),
		});
	}
	return [...byId.values()].reduce(add, none());
}

/** Reads the day's tokens, keeping each file's sum while the file does not change. */
export class DailyTokenReader {

	/** Each file's sum for the day it was read on, with the size and time it had. */
	private readonly files = new Map<string, { readonly from: number; readonly size: number; readonly mtime: number; readonly tokens: DailyTokens }>();

	constructor(private readonly home = path.join(os.homedir(), '.gemini')) { }

	async read(now = new Date()): Promise<DailyTokens> {
		const { from, to } = dayOf(now);
		const tmp = path.join(this.home, 'tmp');
		const projects = await fs.readdir(tmp).catch(() => [] as string[]);
		let total = none();
		const seen = new Set<string>();
		for (const project of projects) {
			const chats = path.join(tmp, project, 'chats');
			for (const name of await fs.readdir(chats).catch(() => [] as string[])) {
				if (!/^session-.*\.jsonl$/.test(name)) {
					continue;
				}
				const file = path.join(chats, name);
				const stat = await fs.stat(file).catch(() => undefined);
				// A file last written before today has nothing of today in it.
				if (!stat || stat.mtimeMs < from || stat.size > maxFileBytes) {
					continue;
				}
				seen.add(file);
				const kept = this.files.get(file);
				if (kept && kept.from === from && kept.size === stat.size && kept.mtime === stat.mtimeMs) {
					total = add(total, kept.tokens);
					continue;
				}
				const text = await fs.readFile(file, 'utf8').catch(() => '');
				const tokens = tokensIn(text, from, to);
				this.files.set(file, { from, size: stat.size, mtime: stat.mtimeMs, tokens });
				total = add(total, tokens);
			}
		}
		for (const file of [...this.files.keys()]) {
			if (!seen.has(file)) {
				this.files.delete(file);
			}
		}
		return total;
	}
}

/** A count as a person reads it: 950, 12.4K, 3.1M. */
export function shortCount(value: number): string {
	if (value < 1_000) {
		return String(Math.round(value));
	}
	const [scaled, unit] = value < 999_500 ? [value / 1_000, 'K'] : [value / 1_000_000, 'M'];
	return `${scaled < 100 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.round(scaled)}${unit}`;
}
