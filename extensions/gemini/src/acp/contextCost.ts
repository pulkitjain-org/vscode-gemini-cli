/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
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
