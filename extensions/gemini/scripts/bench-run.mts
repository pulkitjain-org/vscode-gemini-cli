/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs the benchmark tasks in gemini/bench/tasks against a Gemini CLI, the way
// GeminiCode's agent runs it: `gemini --acp` with the user's saved sign-in,
// one session per task in a fresh clone at the task's base commit. See
// gemini/bench/README.md for the task files and the result columns. The app's
// Gemini: Run Benchmark command runs the same code (src/acp/benchmark.ts).
//
//   node --experimental-transform-types extensions/gemini/scripts/bench-run.mts --cli <gemini.js or gemini> --model <id>
//     [--tasks gemini/bench/tasks] [--out gemini/bench/results/<file>.json] [--only ACME-412,ACME-413]
//     [--timeout 1200000] [--project <google cloud project id>] [--version <GeminiCode version>]
//
// The CLI is started with GEMINI_CLI_NO_RELAUNCH, as the app starts it. Tool
// calls are allowed (the session runs in Auto Edit, and shell commands are
// answered with the allow-once option), so run this only on tasks you chose.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { benchResultsFileName, readBenchTasks, runBenchmark } from '../src/acp/benchmark.ts';

const { values: args } = parseArgs({
	options: {
		cli: { type: 'string' }, model: { type: 'string' },
		tasks: { type: 'string', default: path.resolve(import.meta.dirname, '..', '..', '..', 'gemini', 'bench', 'tasks') },
		out: { type: 'string' }, only: { type: 'string' }, timeout: { type: 'string', default: '1200000' }, project: { type: 'string' },
		version: { type: 'string' },
	},
});
if (!args.cli || !args.model) {
	console.error('Pass --cli (the gemini executable or bundle/gemini.js) and --model.');
	process.exit(2);
}
const cli = path.resolve(args.cli);
const tasks = await readBenchTasks(args.tasks!, (args.only ?? '').split(',').map(s => s.trim()).filter(Boolean));
if (!tasks.length) {
	console.error(`No tasks in ${args.tasks}.`);
	process.exit(2);
}

// A bundled CLI sits at <version>/bundle/gemini.js beside its package.json.
function cliVersion(): string | undefined {
	try {
		return (JSON.parse(readFileSync(path.join(path.dirname(cli), '..', 'package.json'), 'utf8')) as { version?: string }).version;
	} catch {
		return undefined;
	}
}

const isScript = /\.(c|m)?js$/.test(cli);
const summary = await runBenchmark({
	tasks,
	agent: {
		command: isScript ? process.execPath : cli,
		args: isScript ? [cli, '--acp'] : ['--acp'],
		env: { ...process.env, GEMINI_CLI_NO_RELAUNCH: 'true', ...args.project ? { GOOGLE_CLOUD_PROJECT: args.project } : {} },
	},
	model: args.model,
	geminiCodeVersion: args.version,
	cliVersion: cliVersion(),
	turnTimeoutMs: Number(args.timeout),
	log: line => console.log(line),
});
const out = args.out ?? path.join(path.resolve(import.meta.dirname, '..', '..', '..', 'gemini', 'bench', 'results'), benchResultsFileName(summary));
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(summary, null, '\t')}\n`);
console.log(`\n${summary.completed} of ${summary.tasks} completed; ${summary.requestsPerCompletedTask ?? '-'} requests per completed task; median first text ${summary.medianFirstTextMs ?? '-'} ms. Written to ${out}.`);
