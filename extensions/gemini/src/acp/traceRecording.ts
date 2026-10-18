/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Record Performance Trace: the Gemini CLI's own OpenTelemetry export, written
// to a file on this Mac for one run of the agent, and read back into a table
// of where each turn's time went. The CLI's file holds its log records and
// spans as JSON objects one after another (not one per line), which is what
// `parseTraceFile` reads. Prompts and replies are not logged; the CLI's own
// system prompt and tool declarations are, as span attributes.
//
// Names come from docs/cli/telemetry.md of the pinned CLI, checked against a
// file 0.64.0 wrote on 18 Oct 2026 (test/fixtures/trace-sample.txt).

/** The environment that turns the export on for one agent process. */
export function traceEnv(file: string): NodeJS.ProcessEnv {
	return {
		GEMINI_TELEMETRY_ENABLED: 'true',
		GEMINI_TELEMETRY_TARGET: 'local',
		GEMINI_TELEMETRY_OUTFILE: file,
		GEMINI_TELEMETRY_LOG_PROMPTS: 'false',
		GEMINI_TELEMETRY_TRACES_ENABLED: 'true',
		GEMINI_TELEMETRY_USE_COLLECTOR: 'false',
	};
}

export interface TraceEvent {
	readonly name: string;
	/** Milliseconds since the epoch. */
	readonly time: number;
	readonly attributes: Record<string, unknown>;
}

/** The records of a trace file: log records by their event name; spans are not needed, the log records carry the durations. */
export function parseTraceFile(text: string): TraceEvent[] {
	const events: TraceEvent[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === '\\') {
				i++;
			} else if (c === '"') {
				inString = false;
			}
			continue;
		}
		if (c === '"') {
			inString = true;
		} else if (c === '{') {
			if (depth === 0) {
				start = i;
			}
			depth++;
		} else if (c === '}') {
			depth--;
			if (depth === 0 && start >= 0) {
				const event = eventOf(text.slice(start, i + 1));
				if (event) {
					events.push(event);
				}
				start = -1;
			}
		}
	}
	return events;
}

function eventOf(json: string): TraceEvent | undefined {
	let record: { hrTime?: unknown; attributes?: Record<string, unknown> };
	try {
		record = JSON.parse(json);
	} catch {
		return undefined;
	}
	const attributes = record.attributes ?? {};
	const name = attributes['event.name'];
	if (typeof name !== 'string') {
		return undefined;
	}
	const stamp = attributes['event.timestamp'];
	const hr = record.hrTime;
	const time = typeof stamp === 'string' ? Date.parse(stamp) : Array.isArray(hr) && hr.length === 2 ? Number(hr[0]) * 1000 + Number(hr[1]) / 1e6 : NaN;
	return { name, time, attributes };
}

export interface ModelCall {
	readonly model: string;
	/** `main`, or `utility_router` for Auto's routing call. */
	readonly role: string;
	readonly ms: number;
	readonly input: number;
	readonly cached: number;
	readonly output: number;
	readonly thoughts: number;
	readonly status?: number;
}

export interface ToolCall {
	readonly name: string;
	readonly ms: number;
	readonly ok: boolean;
}

export interface TurnSummary {
	readonly session: string;
	readonly promptId: string;
	readonly routing?: { readonly ms: number; readonly model: string; readonly source: string };
	readonly calls: readonly ModelCall[];
	readonly tools: readonly ToolCall[];
}

export interface StartupSummary {
	readonly session: string;
	readonly phases: readonly { readonly name: string; readonly ms: number }[];
}

export interface TraceSummary {
	readonly startups: readonly StartupSummary[];
	readonly turns: readonly TurnSummary[];
}

function num(value: unknown): number {
	return typeof value === 'number' ? value : Number(value) || 0;
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** Turns, in order, from the events: a turn is one `prompt_id`, with its routing call, model calls and tool calls. */
export function summarizeTrace(events: readonly TraceEvent[]): TraceSummary {
	const startups: StartupSummary[] = [];
	const turns = new Map<string, { session: string; promptId: string; routing?: TurnSummary['routing']; calls: ModelCall[]; tools: ToolCall[] }>();
	const turn = (session: string, promptId: string) => {
		const key = `${session}/${promptId}`;
		let t = turns.get(key);
		if (!t) {
			t = { session, promptId, calls: [], tools: [] };
			turns.set(key, t);
		}
		return t;
	};
	let lastRouting: { session: string; routing: NonNullable<TurnSummary['routing']> } | undefined;
	for (const event of [...events].sort((a, b) => a.time - b.time)) {
		const a = event.attributes;
		const session = str(a['session.id']);
		switch (event.name) {
			case 'gemini_cli.startup_stats': {
				let phases: { name?: string; duration_ms?: number }[] = [];
				try {
					phases = JSON.parse(str(a.phases)) as typeof phases;
				} catch {
					// No phases, nothing to show.
				}
				startups.push({ session, phases: phases.map(p => ({ name: str(p.name), ms: num(p.duration_ms) })) });
				break;
			}
			case 'gemini_cli.model_routing':
				lastRouting = { session, routing: { ms: num(a.routing_latency_ms), model: str(a.decision_model), source: str(a.decision_source) } };
				break;
			case 'gemini_cli.api_response': {
				const promptId = str(a.prompt_id);
				const role = str(a.role) || 'main';
				// The routing call has a prompt id of its own; it belongs to the turn whose main call follows it.
				if (role === 'utility_router') {
					break;
				}
				const t = turn(session, promptId);
				if (lastRouting && lastRouting.session === session && !t.routing) {
					t.routing = lastRouting.routing;
					lastRouting = undefined;
				}
				t.calls.push({
					model: str(a.model), role, ms: num(a.duration_ms),
					input: num(a.input_token_count), cached: num(a.cached_content_token_count), output: num(a.output_token_count), thoughts: num(a.thoughts_token_count),
					...a.status_code !== undefined ? { status: num(a.status_code) } : {},
				});
				break;
			}
			case 'gemini_cli.tool_call': {
				const t = turn(session, str(a.prompt_id));
				t.tools.push({ name: str(a.function_name), ms: num(a.duration_ms), ok: a.success === true || a.success === 'true' });
				break;
			}
		}
	}
	return { startups, turns: [...turns.values()] };
}

function ms(value: number): string {
	return value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

/** The summary as Markdown: one row per turn, then the totals the latency budget asks for. */
export function renderTrace(summary: TraceSummary, file: string): string {
	const lines = ['# Performance trace', '', `From \`${file}\`, written by the Gemini CLI's own telemetry. Prompts and replies are not in it.`, ''];
	if (summary.startups.length) {
		const first = summary.startups[0];
		const total = first.phases.reduce((n, p) => n + p.ms, 0);
		lines.push(`**Agent start:** ${ms(total)} over ${first.phases.length} phases${first.phases.length ? ` (${first.phases.map(p => `${p.name} ${ms(p.ms)}`).join(', ')})` : ''}.`, '');
	}
	if (!summary.turns.length) {
		lines.push('No turns recorded. Send a prompt while the trace is on, then stop it.', '');
		return lines.join('\n');
	}
	lines.push('| Turn | Routing call | First model reply | Model calls | Model time | Tools | Tool time | Input tokens | Cached | Output |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	let input = 0;
	let cached = 0;
	let output = 0;
	let modelMs = 0;
	let toolMs = 0;
	summary.turns.forEach((t, i) => {
		const tIn = t.calls.reduce((n, c) => n + c.input, 0);
		const tCached = t.calls.reduce((n, c) => n + c.cached, 0);
		const tOut = t.calls.reduce((n, c) => n + c.output, 0);
		const tModel = t.calls.reduce((n, c) => n + c.ms, 0);
		const tTools = t.tools.reduce((n, c) => n + c.ms, 0);
		input += tIn;
		cached += tCached;
		output += tOut;
		modelMs += tModel;
		toolMs += tTools;
		const models = [...new Set(t.calls.map(c => c.model))].join(', ');
		lines.push(`| ${i + 1} | ${t.routing ? `${ms(t.routing.ms)} → ${t.routing.model}` : 'none (model picked)'} | ${t.calls.length ? ms(t.calls[0].ms) : ''} | ${t.calls.length} (${models}) | ${ms(tModel)} | ${t.tools.length}${t.tools.length ? ` (${t.tools.map(x => x.name).join(', ')})` : ''} | ${ms(tTools)} | ${tIn.toLocaleString('en-US')} | ${tCached.toLocaleString('en-US')} | ${tOut.toLocaleString('en-US')} |`);
	});
	lines.push('', '## Totals', '', `- Turns: ${summary.turns.length}`, `- Model time: ${ms(modelMs)} over ${summary.turns.reduce((n, t) => n + t.calls.length, 0)} calls`, `- Tool time: ${ms(toolMs)}`,
		`- Input tokens: ${input.toLocaleString('en-US')}, of which cached ${cached.toLocaleString('en-US')} (${input ? Math.round(cached / input * 100) : 0}%)`, `- Output tokens: ${output.toLocaleString('en-US')}`, '',
		'The cached share matters most: a low share on a long conversation means the service is not reusing the CLI\'s prefix.', '');
	return lines.join('\n');
}

/** One hop of a turn's time, for the chat's readout: where the time went against the hop's budget. */
export interface TraceHop {
	readonly name: string;
	/** This turn's time, or a word such as "skipped". */
	readonly value: string;
	/** Share of the turn, 0 to 1, for the bar. */
	readonly share: number;
	/** The hop's p50 budget, or whose time it is ("model", "your repo"). */
	readonly budget: string;
	/** What the bar says: the fork's own hop, the model's, or a tool's. */
	readonly tone: 'fork' | 'model' | 'tool';
}

export interface TurnReadout {
	readonly hops: readonly TraceHop[];
	readonly totalMs: number;
	readonly input: number;
	readonly cached: number;
	readonly output: number;
	readonly requests: number;
}

/** What the fork measured around a turn, in ms: the session wait, the prompt's build, and the time to the first reply. */
export interface MeasuredTurn {
	readonly sessionMs?: number;
	readonly sendMs?: number;
	readonly firstTokenMs?: number;
	readonly totalMs: number;
}

function hopMs(value: number): string {
	return value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : value >= 1000 ? `${(value / 1000).toFixed(2).replace(/0$/, '')} s` : `${Math.round(value)} ms`;
}

/**
 * Where a turn's time went, hop by hop: the fork's hops from what it measured,
 * the model's and the tools' from the CLI's trace of the same turn.
 */
export function turnReadout(turn: TurnSummary | undefined, measured: MeasuredTurn): TurnReadout {
	const total = Math.max(1, measured.totalMs);
	const share = (ms: number) => Math.min(1, Math.max(0, ms / total));
	const hops: TraceHop[] = [];
	hops.push({ name: 'Enter → prompt sent', value: measured.sendMs === undefined ? '—' : hopMs(measured.sendMs), share: share(measured.sendMs ?? 0), budget: '30 ms', tone: 'fork' });
	hops.push({ name: measured.sessionMs ? 'Session (started for this turn)' : 'Session (spare taken)', value: hopMs(measured.sessionMs ?? 0), share: share(measured.sessionMs ?? 0), budget: '0 ms', tone: 'fork' });
	hops.push({ name: 'Routing call (Auto)', value: turn?.routing ? hopMs(turn.routing.ms) : 'skipped', share: share(turn?.routing?.ms ?? 0), budget: '0 ms', tone: 'model' });
	hops.push({ name: 'Model, first token', value: measured.firstTokenMs === undefined ? '—' : hopMs(measured.firstTokenMs), share: share(measured.firstTokenMs ?? 0), budget: 'fill from T-12', tone: 'model' });
	const calls = turn?.calls ?? [];
	const modelMs = calls.reduce((n, c) => n + c.ms, 0);
	hops.push({ name: calls.length === 1 ? 'Model, 1 call' : `Model, ${calls.length} calls in all`, value: hopMs(modelMs), share: share(modelMs), budget: 'model', tone: 'model' });
	const tools = [...(turn?.tools ?? [])].sort((a, b) => b.ms - a.ms);
	if (tools.length) {
		const top = tools[0];
		const shell = /shell|command/i.test(top.name);
		hops.push({ name: `Tools: ${top.name}`, value: hopMs(top.ms), share: share(top.ms), budget: shell ? 'your repo' : '8 s timeout', tone: 'tool' });
		const rest = tools.slice(1);
		if (rest.length) {
			const restMs = rest.reduce((n, t) => n + t.ms, 0);
			hops.push({ name: rest.length === 1 ? `Tools: ${rest[0].name}` : `Tools: ${rest.length} others`, value: hopMs(restMs), share: share(restMs), budget: '8 s timeout', tone: 'tool' });
		}
	} else {
		hops.push({ name: 'Tools', value: 'none', share: 0, budget: '—', tone: 'tool' });
	}
	return {
		hops,
		totalMs: measured.totalMs,
		input: calls.reduce((n, c) => n + c.input, 0),
		cached: calls.reduce((n, c) => n + c.cached, 0),
		output: calls.reduce((n, c) => n + c.output, 0),
		requests: calls.length + (turn?.routing ? 1 : 0),
	};
}
