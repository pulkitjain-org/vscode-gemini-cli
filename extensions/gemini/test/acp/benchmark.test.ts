/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { benchComparison, benchResultsFileName, BenchSummary, BenchTask, readBenchTasks, readBenchVariants, runBenchmark } from '../../src/acp/benchmark';
import { promptVersions } from '../../src/acp/promptVersions';
import { fakeAgentCommand } from '../helpers';

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

/** A repository with one commit, standing in for the team's repository at the task's base commit. */
async function repository(): Promise<{ repo: string; sha: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-bench-repo-'));
	dirs.push(repo);
	const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Bench', '-c', 'user.email=bench@example.com', ...args]).toString().trim();
	git('init', '--quiet');
	await fs.writeFile(path.join(repo, 'cart.ts'), 'export const cap = 200;\n');
	git('add', '.');
	git('commit', '--quiet', '-m', 'base');
	return { repo, sha: git('rev-parse', 'HEAD') };
}

describe('benchmark', () => {
	it('runs each task in its own clone and grades it with the task\'s command', async () => {
		const { repo, sha } = await repository();
		const tasks: BenchTask[] = [
			{ key: 'ACME-412', repo, baseSha: sha, prompt: 'Cap the gift message', grader: { command: 'test -f cart.ts' } },
			{ key: 'ACME-413', repo, baseSha: sha, prompt: 'Trim it first', grader: { command: 'exit 3' } },
		];
		const agent = fakeAgentCommand({
			supportsSetModel: true,
			promptMeta: { quota: { token_count: { input_tokens: 1200, output_tokens: 80 }, model_usage: [{}, {}] } },
			turns: [
				[{ step: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } }],
				[{ step: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } }],
			],
		});
		const started: string[] = [];
		const summary = await runBenchmark({ tasks, agent, model: 'gemini-3.8-flash', geminiCodeVersion: '1.2.0', cliVersion: '0.64.0', onTask: task => started.push(task.key) });
		expect(started).toEqual(['ACME-412', 'ACME-413']);
		expect({
			...summary, ranAt: undefined, medianFirstTextMs: undefined, medianWallMs: undefined,
			results: summary.results.map(r => ({ key: r.key, completed: r.completed, graderExit: r.graderExit, requests: r.requests, tokensIn: r.tokensIn, tokensOut: r.tokensOut, stopReason: r.stopReason, error: r.error, sawText: r.firstTextMs !== null })),
		}).toEqual({
			ranAt: undefined, promptVersions, geminiCodeVersion: '1.2.0', cliVersion: '0.64.0', model: 'gemini-3.8-flash', tasks: 2, completed: 1, completionRate: 0.5, requestsPerCompletedTask: 2, medianTurns: 1, tokensInPerTask: 1200, tokensOutPerTask: 80, medianFirstTextMs: undefined, medianWallMs: undefined,
			results: [
				{ key: 'ACME-412', completed: true, graderExit: 0, requests: 2, tokensIn: 1200, tokensOut: 80, stopReason: 'end_turn', error: undefined, sawText: true },
				{ key: 'ACME-413', completed: false, graderExit: 3, requests: 2, tokensIn: 1200, tokensOut: 80, stopReason: 'end_turn', error: undefined, sawText: true },
			],
		});
		expect(benchResultsFileName(summary)).toBe('1.2.0-0.64.0-gemini-3.8-flash.json');
	});

	it('sends a task\'s failing check back to the agent, as many times as the variant allows, and counts the turns', async () => {
		const { repo, sha } = await repository();
		// The check fails once in each clone, then passes; the grader is never shown to the agent.
		const flaky = 'test -f .checked || { touch .checked; echo "1 test failed"; exit 1; }';
		const tasks: BenchTask[] = [
			{ key: 'ACME-1', repo, baseSha: sha, prompt: 'Go', grader: { command: 'true' }, check: { command: flaky } },
			{ key: 'ACME-2', repo, baseSha: sha, prompt: 'Go', grader: { command: 'true' }, check: { command: 'echo still failing; exit 1' } },
			{ key: 'ACME-3', repo, baseSha: sha, prompt: 'Go', grader: { command: 'true' } },
		];
		const agent = () => fakeAgentCommand({ supportsSetModel: true, promptMeta: { quota: { token_count: { input_tokens: 1000, output_tokens: 50 }, model_usage: [{}] } } });
		const plain = await runBenchmark({ tasks, agent: agent(), model: 'm' });
		const looped = await runBenchmark({ tasks, agent: agent(), model: 'm', variant: { name: 'verify-2', checkRounds: 2 } });
		expect([
			plain.results.map(r => [r.key, r.turns, r.tokensIn]), plain.medianTurns, plain.variant,
			looped.results.map(r => [r.key, r.turns, r.tokensIn, r.tokensOut]), looped.medianTurns, looped.tokensInPerTask, looped.variant,
			benchResultsFileName(looped),
		]).toEqual([
			[['ACME-1', 1, 1000], ['ACME-2', 1, 1000], ['ACME-3', 1, 1000]], 1, undefined,
			// One more turn until the check passed; both rounds spent on the one that never does; one turn without a check.
			[['ACME-1', 2, 2000, 100], ['ACME-2', 3, 3000, 150], ['ACME-3', 1, 1000, 50]], 2, 2000, { name: 'verify-2', checkRounds: 2 },
			'dev-dev-m-verify-2.json',
		]);
	});

	it('gives the CLI a variant\'s settings as its system settings file, and its environment', async () => {
		const { repo, sha } = await repository();
		const out = path.join(repo, '..', `${path.basename(repo)}-seen.txt`);
		dirs.push(out);
		const tasks: BenchTask[] = [{ key: 'ACME-9', repo, baseSha: sha, prompt: 'Go', grader: { command: 'true' } }];
		// A stand-in for the CLI that writes down what it was started with, then exits.
		const agent = { command: 'sh', args: ['-c', `cat "$GEMINI_CLI_SYSTEM_SETTINGS_PATH" > "${out}"; echo " $BENCH_EXTRA" >> "${out}"`], env: process.env, shell: false };
		await runBenchmark({ tasks, agent, model: 'm', variant: { name: 'compress-early', settings: { model: { compressionThreshold: 0.3 } }, env: { BENCH_EXTRA: 'on' } } });
		expect(await fs.readFile(out, 'utf8')).toBe('{"model":{"compressionThreshold":0.3}} on\n');
	});

	it('reads a variants file, and says what is wrong with one', () => {
		expect(readBenchVariants(JSON.stringify([{ name: 'base' }, { name: 'verify-2', checkRounds: 2 }, { name: 'timeout_90', settings: { a: 1 }, env: { A: 1 } }]))).toEqual([
			{ name: 'base' }, { name: 'verify-2', checkRounds: 2 }, { name: 'timeout_90', settings: { a: 1 }, env: { A: '1' } },
		]);
		const problem = (value: unknown) => {
			try {
				readBenchVariants(JSON.stringify(value));
				return 'none';
			} catch (err) {
				return (err as Error).message;
			}
		};
		expect([problem({}), problem([{ name: 'a b' }]), problem([{ name: 'a' }, { name: 'a' }]), problem([{ name: 'a', checkRounds: 11 }]), problem([{ name: 'a', settings: [] }])]).toEqual([
			'The variants file must hold a JSON array of variants.',
			'Variant 1 needs a name of its own, of letters, digits, ".", "-" and "_".',
			'Variant 2 needs a name of its own, of letters, digits, ".", "-" and "_".',
			'Variant "a": checkRounds is a whole number from 0 to 10.',
			'Variant "a": settings is an object.',
		]);
	});

	it('sets runs of the same tasks side by side', () => {
		const summary = (change: Partial<BenchSummary>): BenchSummary => ({
			ranAt: '', model: 'm', tasks: 10, completed: 4, completionRate: 0.4, requestsPerCompletedTask: 12.5, medianTurns: 1, tokensInPerTask: 90000, tokensOutPerTask: 2100,
			medianFirstTextMs: 900, medianWallMs: 61_400, results: [], ...change,
		});
		expect(benchComparison([summary({}), summary({ variant: { name: 'verify-2', checkRounds: 2 }, completed: 6, completionRate: 0.6, medianTurns: 2, medianWallMs: null, tokensInPerTask: null })])).toEqual([
			'variant   completed  rate  median turns  median s  tokens in / task  tokens out / task  requests / completed',
			'(none)    4/10       40%   1             61        90000             2100               12.5',
			'verify-2  6/10       60%   2             -         -                 2100               12.5',
		]);
	});

	it('reports a CLI that is not there to start as the task\'s error', async () => {
		const { repo, sha } = await repository();
		const tasks: BenchTask[] = [{ key: 'ACME-9', repo, baseSha: sha, prompt: 'Go', grader: { command: 'true' } }];
		const summary = await runBenchmark({ tasks, agent: { command: path.join(repo, 'no-such-gemini'), args: [], env: process.env, shell: false }, model: 'm' });
		expect(summary.results.map(r => [r.key, r.completed, /could not start/.test(r.error ?? '')])).toEqual([['ACME-9', false, true]]);
	});

	it('stops before the next task once cancelled, keeping what finished', async () => {
		const { repo, sha } = await repository();
		const tasks: BenchTask[] = ['ACME-1', 'ACME-2', 'ACME-3'].map(key => ({ key, repo, baseSha: sha, prompt: 'Go', grader: { command: 'true' } }));
		const controller = new AbortController();
		const summary = await runBenchmark({ tasks, agent: fakeAgentCommand({ supportsSetModel: true }), model: 'm', signal: controller.signal, onTask: (_, index) => index === 1 && controller.abort() });
		expect(summary.results.map(r => [r.key, r.completed])).toEqual([['ACME-1', true], ['ACME-2', false]]);
		expect(benchResultsFileName(summary)).toBe('dev-dev-m.json');
	});

	it('reads the task files, all of them or the keys asked for', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-bench-tasks-'));
		dirs.push(dir);
		for (const key of ['ACME-2', 'ACME-1']) {
			await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify({ key, repo: 'r', baseSha: 's', prompt: 'p', grader: { command: 'true' } }));
		}
		await fs.writeFile(path.join(dir, 'README.txt'), 'not a task');
		expect([(await readBenchTasks(dir)).map(t => t.key), (await readBenchTasks(dir, ['ACME-2'])).map(t => t.key)]).toEqual([['ACME-1', 'ACME-2'], ['ACME-2']]);
	});
});
