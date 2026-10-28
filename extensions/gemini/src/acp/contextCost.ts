/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What every model call carries before the user's prompt, and what each part
// of it costs: the CLI's own prompt and tools, the folder's context files
// (GEMINI.md and what it imports, the skills list), each MCP server's tool
// definitions and GeminiCode's own servers. On one team repository half of
// the 63,500 tokens of every call were two MCP servers' tools (FINDINGS.md).
//
// The CLI doesn't report this, so it is measured: one short prompt per
// variant, each in a fresh CLI with a different set of servers allowed, and
// each part is the difference between two of them. Only on request, since
// each variant is a model call.

export type ProbeVariant =
	| { readonly kind: 'empty' }
	| { readonly kind: 'context' }
	| { readonly kind: 'server'; readonly server: string }
	| { readonly kind: 'geminicode' }
	| { readonly kind: 'all'; readonly servers: readonly string[] };

/** The input tokens of one model call in the given setup. */
export type ContextProbe = (variant: ProbeVariant) => Promise<number>;

export interface ContextCost {
	/** Every model call, as agents get it. */
	readonly total: number;
	/** The CLI's own prompt and built-in tools. */
	readonly cli: number;
	/** The folder's context files and skills list. */
	readonly context: number;
	/** Each MCP server's tool definitions, largest first. */
	readonly servers: readonly { readonly name: string; readonly tokens: number }[];
	/** GeminiCode's own servers (browser, team tools, index, project). */
	readonly geminicode: number;
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
	/** When the parts were measured, in ms since the epoch. */
	readonly measuredAt?: number;
	/** Tokens of each part; `servers` is how many MCP servers, `serverTokens` what they cost together. */
	readonly parts?: { readonly cli: number; readonly rules: number; readonly geminicode: number; readonly servers: number; readonly serverTokens: number; readonly total: number };
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
		parts: {
			cli: cost.cli,
			rules: cost.context,
			geminicode: cost.geminicode,
			servers: cost.servers.length,
			serverTokens: cost.servers.reduce((sum, server) => sum + server.tokens, 0),
			total: cost.total,
		},
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
	const [total, context, empty, geminicode] = results;
	const difference = (value: number, base: number) => Math.max(0, value - base);
	return {
		total,
		cli: empty,
		context: difference(context, empty),
		geminicode: difference(geminicode, context),
		servers: servers.map((name, i) => ({ name, tokens: difference(results[4 + i], context) })).sort((a, b) => b.tokens - a.tokens),
		measuredAt: now(),
	};
}

/** How many model calls measuring a folder with `servers` MCP servers makes: one per variant of `measureContextCost`. */
export function measureCalls(servers: number): number {
	return 4 + servers;
}

/** About how many input tokens measuring again takes, from the last measure: each call carries the part it measures and the parts under it. */
export function measureTokens(cost: ContextCost): number {
	const context = cost.cli + cost.context;
	return cost.total + cost.cli + context + context + cost.geminicode + cost.servers.reduce((sum, server) => sum + context + server.tokens, 0);
}

/** The allowlist for a variant: server names, or a name no server has, so none load. */
export function allowedServersFor(variant: ProbeVariant): string[] {
	switch (variant.kind) {
		case 'all': return [...variant.servers];
		case 'server': return [variant.server];
		default: return ['__geminicode_none__'];
	}
}

/** About how many tokens a context file costs: four characters each, as a rule of thumb for English and code. */
export function estimateTokens(characters: number): number {
	return Math.round(characters / 4);
}

/** Advice for the heaviest parts, as keys the page words: a server over this many tokens, context files over that. */
export const heavyServerTokens = 5_000;
export const heavyContextTokens = 15_000;
