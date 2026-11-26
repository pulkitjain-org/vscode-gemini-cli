/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The docs site's Benchmark page, written as Markdown from the results files in
// gemini/bench/results/ (one per release and model, from Gemini: Run Benchmark or
// extensions/gemini/scripts/bench-run.mts), so build.mts renders it like any guide page.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The parts of a results file the page shows (extensions/gemini/src/acp/benchmark.ts, BenchSummary). */
export interface BenchRun {
	readonly ranAt: string;
	readonly geminiCodeVersion?: string;
	readonly cliVersion?: string;
	readonly model: string;
	readonly tasks: number;
	readonly completed: number;
	readonly completionRate: number;
	readonly requestsPerCompletedTask: number | null;
	readonly medianFirstTextMs: number | null;
	readonly medianWallMs: number | null;
	readonly results: readonly {
		readonly key: string;
		readonly completed: boolean;
		readonly requests: number;
		readonly tokensIn: number;
		readonly tokensOut: number;
		readonly firstTextMs: number | null;
		readonly wallMs: number;
		readonly error?: string;
	}[];
}

/** Every results file in `dir`, newest release first; none when the folder is missing. */
export function readBenchRuns(dir: string): BenchRun[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
		.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as BenchRun)
		.sort((a, b) => compareVersions(b.geminiCodeVersion, a.geminiCodeVersion) || compareVersions(b.cliVersion, a.cliVersion) || a.model.localeCompare(b.model));
}

/** The page's Markdown: every release's numbers, then the newest release task by task. */
export function benchmarkMarkdown(runs: readonly BenchRun[]): string {
	const lines = [
		'# Benchmark',
		'',
		'How each GeminiCode release does on the same set of tasks, drawn from the team\'s own closed Jira tickets. Each task starts from the commit its merge request started from, gets the ticket as its prompt, and counts as completed when the merge request\'s own tests pass in the agent\'s working tree.',
		'',
	];
	if (!runs.length) {
		lines.push('No release has been benchmarked yet. Results appear here once a run\'s file is added to `gemini/bench/results/`.', '');
		return lines.join('\n');
	}
	lines.push(
		'## Releases',
		'',
		'Compare releases on the share of tasks completed first, then on requests per completed task: a release that completes the same tasks with fewer requests costs less quota.',
		'',
		'| Release | Gemini CLI | Model | Completed | Requests per completed task | First text, median | Turn, median |',
		'| --- | --- | --- | --- | --- | --- | --- |',
		...runs.map(run => `| ${run.geminiCodeVersion ?? 'dev build'} | ${run.cliVersion ?? 'unknown'} | ${cell(run.model)} | ${run.completed} of ${run.tasks} (${Math.round(run.completionRate * 100)}%) | ${run.requestsPerCompletedTask ?? '-'} | ${seconds(run.medianFirstTextMs)} | ${seconds(run.medianWallMs)} |`),
		'',
	);
	const newest = runs[0].geminiCodeVersion;
	const latest = runs.filter(run => run.geminiCodeVersion === newest);
	lines.push(
		`## ${newest ? `GeminiCode ${newest}` : 'The newest run'}, task by task`,
		'',
		`Run on ${latest.map(run => `${cell(run.model)} on ${run.ranAt.slice(0, 10)}`).join(' and ')}.`,
		'',
		'| Task | Model | Completed | Requests | Tokens in / out | First text | Turn |',
		'| --- | --- | --- | --- | --- | --- | --- |',
		...latest.flatMap(run => run.results.map(r => `| ${cell(r.key)} | ${cell(run.model)} | ${r.completed ? 'Yes' : r.error ? `No: ${cell(r.error)}` : 'No'} | ${r.requests} | ${r.tokensIn.toLocaleString('en-US')} / ${r.tokensOut.toLocaleString('en-US')} | ${seconds(r.firstTextMs)} | ${seconds(r.wallMs)} |`)),
		'',
	);
	return lines.join('\n');
}

/** Two made-up runs for the sample build, which has no results files to read. */
export function sampleBenchRuns(): BenchRun[] {
	const run = (model: string, completed: readonly boolean[], requests: number): BenchRun => ({
		ranAt: '2026-10-16T09:00:00Z', geminiCodeVersion: '1.0.0', cliVersion: '0.64.0', model,
		tasks: completed.length, completed: completed.filter(Boolean).length, completionRate: Math.round(completed.filter(Boolean).length / completed.length * 100) / 100,
		requestsPerCompletedTask: requests, medianFirstTextMs: 1400, medianWallMs: 182_000,
		results: completed.map((ok, i) => ({ key: `ACME-${410 + i}`, completed: ok, requests: requests + i, tokensIn: 28_807 + i * 1000, tokensOut: 1_200 + i * 100, firstTextMs: 1300 + i * 50, wallMs: 170_000 + i * 6000 })),
	});
	return [run('gemini-3.8-flash', [true, true, false], 14), run('gemini-3.8-pro', [true, true, true], 11)];
}

/** `1.4 s` under a minute, `3 min 2 s` from there. */
function seconds(ms: number | null): string {
	if (ms === null) {
		return '-';
	}
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)} s`;
	}
	const total = Math.round(ms / 1000);
	return `${Math.floor(total / 60)} min ${total % 60} s`;
}

/** Text inside a table cell: no pipes or line breaks. */
function cell(value: string): string {
	return value.replace(/\|/g, '/').replace(/\s+/g, ' ');
}

/** Orders `1.10.0` after `1.9.2`; a missing version (a dev build) sorts first. */
function compareVersions(a: string | undefined, b: string | undefined): number {
	if (a === b) {
		return 0;
	}
	if (!a || !b) {
		return a ? 1 : -1;
	}
	return a.localeCompare(b, 'en', { numeric: true });
}
