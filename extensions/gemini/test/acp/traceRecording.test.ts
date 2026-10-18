/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTraceFile, renderTrace, summarizeTrace, traceEnv } from '../../src/acp/traceRecording';

describe('a performance trace', () => {
	const text = readFileSync(path.join(__dirname, '..', 'fixtures', 'trace-sample.txt'), 'utf8');

	it('turns the export on for one process, prompts off', () => {
		const env = traceEnv('/tmp/t.jsonl');
		expect(env.GEMINI_TELEMETRY_ENABLED).toBe('true');
		expect(env.GEMINI_TELEMETRY_TARGET).toBe('local');
		expect(env.GEMINI_TELEMETRY_OUTFILE).toBe('/tmp/t.jsonl');
		expect(env.GEMINI_TELEMETRY_LOG_PROMPTS).toBe('false');
	});

	it('reads the CLI\'s file of back-to-back JSON objects', () => {
		const events = parseTraceFile(text);
		expect(events.map(e => e.name)).toEqual(['gemini_cli.startup_stats', 'gemini_cli.startup_stats', 'gemini_cli.api_request', 'gemini_cli.api_response', 'gemini_cli.model_routing', 'gemini_cli.api_request', 'gemini_cli.api_response', 'gemini_cli.model_routing', 'gemini_cli.api_request', 'gemini_cli.api_response', 'gemini_cli.tool_call']);
		expect(events[3].time).toBe(Date.parse('2026-10-18T07:00:16.925Z'));
	});

	it('groups a turn\'s routing, model and tool calls, and renders the budget\'s numbers', () => {
		const summary = summarizeTrace(parseTraceFile(text));
		expect(summary.startups[0].phases.map(p => p.name)).toContain('load_settings');
		expect(summary.turns).toHaveLength(2);
		const [auto, picked] = summary.turns;
		expect(auto.routing).toEqual({ ms: 263, model: 'gemini-3.1-pro-preview', source: 'agent-router/default' });
		expect(auto.calls.map(c => [c.model, c.role, c.ms])).toEqual([['gemini-3.1-pro-preview', 'main', 220]]);
		expect(picked.routing?.source).toBe('agent-router/override');
		expect(picked.tools).toEqual([{ name: 'run_shell_command', ms: 19800, ok: true }]);
		const md = renderTrace(summary, '/tmp/t.jsonl');
		expect(md).toContain('| 1 | 263 ms → gemini-3.1-pro-preview | 220 ms | 1 (gemini-3.1-pro-preview) | 220 ms | 0 | 0 ms | 1 | 0 | 1 |');
		expect(md).toContain('| 2 | 0 ms → gemini-3-flash-preview | 210 ms | 1 (gemini-3-flash-preview) | 210 ms | 1 (run_shell_command) | 19.8 s | 1 | 0 | 1 |');
		expect(md).toContain('of which cached 0 (0%)');
	});
});
