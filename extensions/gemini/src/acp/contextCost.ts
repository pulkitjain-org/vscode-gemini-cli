/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What every model call carries before the user's prompt: the CLI's own
// prompt and tools, the folder's context files (GEMINI.md and what it
// imports, the skills list), each MCP server's tool definitions and
// GeminiCode's own servers. On one team repository half of the 63,500 tokens
// of every call were two MCP servers' tools (FINDINGS.md).
//
// The CLI doesn't report this as such, so it is measured: one short test
// prompt per variant, each in a fresh CLI with a different set of servers
// allowed, and the app shows each prompt's input tokens as the CLI reported
// them (design rule 10: only numbers the CLI reports, never a difference the
// app worked out). Only on request, since each prompt is a model call.

export type ProbeVariant =
	| { readonly kind: 'empty' }
	| { readonly kind: 'context' }
	| { readonly kind: 'server'; readonly server: string }
	| { readonly kind: 'geminicode' }
	| { readonly kind: 'all'; readonly servers: readonly string[] };

/** The input tokens of one model call in the given setup. */
export type ContextProbe = (variant: ProbeVariant) => Promise<number>;

/** One test prompt's input tokens, as the CLI reported them. */
export interface ContextReading {
	/** `empty`: an empty folder; `folder`: the folder alone; `server`: the folder with one MCP server; `geminicode`: with GeminiCode's tools; `all`: everything agents get. */
	readonly kind: 'empty' | 'folder' | 'server' | 'geminicode' | 'all';
	/** The MCP server, for a `server` reading. */
	readonly server?: string;
	readonly tokens: number;
}

export interface ContextCost {
	/** Every model call, as agents get it: the `all` reading. */
	readonly total: number;
	/** One reading per test prompt, in the order shown: empty, folder, each server, geminicode, all. */
	readonly readings: readonly ContextReading[];
	readonly measuredAt: number;
	/** The model that counted, since tokens differ a little between models. */
	readonly model?: string;
	/** The context files the CLI loaded (its `/memory list`), with their sizes; unset in measures made before they were kept. */
	readonly rules?: readonly RuleFile[];
}

export interface RuleFile {
	readonly path: string;
	readonly bytes: number;
}

/** A rule file larger than this is worth trimming: every model call carries it. */
export const largeRuleFileBytes = 20 * 1024;

/** The chat's usage popover's breakdown of a folder's context (`/context`). */
export interface ContextBreakdown {
	readonly state: 'none' | 'measuring' | 'ready' | 'failed';
	/** When the readings were taken, in ms since the epoch. */
	readonly measuredAt?: number;
	/** Each test prompt's input tokens as the CLI reported them; `total` is the `all` reading, what every call carries. */
	readonly readings?: readonly ContextReading[];
	readonly total?: number;
	/** The rule files, by name, largest first. */
	readonly rules?: readonly { readonly name: string; readonly path: string; readonly bytes: number }[];
	readonly error?: string;
}

/** The breakdown of `cost`, the folder's last measure; `measuring` while a new one runs, `error` when the last one failed. */
export function contextBreakdown(cost: ContextCost | undefined, measuring: boolean, error?: string): ContextBreakdown {
	const state = measuring ? 'measuring' : error ? 'failed' : cost ? 'ready' : 'none';
	if (!cost) {
		return { state, ...error ? { error } : {} };
	}
	return {
		state,
		measuredAt: cost.measuredAt,
		readings: cost.readings,
		total: cost.total,
		...cost.rules ? { rules: [...cost.rules].sort((a, b) => b.bytes - a.bytes).map(rule => ({ name: ruleFileName(rule.path), path: rule.path, bytes: rule.bytes })) } : {},
		...error ? { error } : {},
	};
}

/** A rule file's name as the popover lists it, without its folder; the full path is its tooltip. */
function ruleFileName(file: string): string {
	const parts = file.split(/[\\/]/).filter(Boolean);
	return parts.slice(-1)[0] ?? file;
}

/** Variants measured at once. */
const concurrency = 3;

export async function measureContextCost(servers: readonly string[], probe: ContextProbe, now: () => number = Date.now): Promise<Omit<ContextCost, 'model'>> {
	// The heaviest variants first, so the longest calls start at once.
	const variants: ProbeVariant[] = [
		{ kind: 'all', servers },
		{ kind: 'context' },
		{ kind: 'empty' },
		{ kind: 'geminicode' },
		...servers.map(server => ({ kind: 'server' as const, server })),
	];
	const results = new Array<number>(variants.length);
	let next = 0;
	const worker = async () => {
		while (next < variants.length) {
			const index = next++;
			results[index] = await probe(variants[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, variants.length) }, worker));
	const [all, folder, empty, geminicode] = results;
	return {
		total: all,
		readings: [
			{ kind: 'empty', tokens: empty },
			{ kind: 'folder', tokens: folder },
			...servers.map((server, i) => ({ kind: 'server' as const, server, tokens: results[4 + i] })),
			{ kind: 'geminicode', tokens: geminicode },
			{ kind: 'all', tokens: all },
		],
		measuredAt: now(),
	};
}

/** How many test prompts measuring a folder with `servers` MCP servers runs: one per variant of `measureContextCost`. */
export function measureCalls(servers: number): number {
	return 4 + servers;
}

/** The allowlist for a variant: server names, or a name no server has, so none load. */
export function allowedServersFor(variant: ProbeVariant): string[] {
	switch (variant.kind) {
		case 'all': return [...variant.servers];
		case 'server': return [variant.server];
		default: return ['__geminicode_none__'];
	}
}

/** A reading at least this many times the one it builds on accounts for much of what every call carries. */
export const heavyReadingRatio = 1.5;

/**
 * What to point out in words, without a number: the MCP servers whose reading
 * is `heavyReadingRatio` times the folder's, and whether the folder's own
 * context files make its reading that much more than an empty folder's.
 */
export function heavyReadings(cost: Pick<ContextCost, 'readings'>): { readonly servers: readonly string[]; readonly context: boolean } {
	const tokens = (kind: ContextReading['kind']) => cost.readings.find(reading => reading.kind === kind)?.tokens ?? 0;
	const empty = tokens('empty');
	const folder = tokens('folder');
	return {
		servers: cost.readings.filter(reading => reading.kind === 'server' && reading.server && folder > 0 && reading.tokens >= folder * heavyReadingRatio).map(reading => reading.server!),
		context: empty > 0 && folder >= empty * heavyReadingRatio,
	};
}
