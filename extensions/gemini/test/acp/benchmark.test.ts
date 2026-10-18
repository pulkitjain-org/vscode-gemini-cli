/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { benchResultsFileName, BenchTask, readBenchTasks, runBenchmark } from '../../src/acp/benchmark';
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
			ranAt: undefined, geminiCodeVersion: '1.2.0', cliVersion: '0.64.0', model: 'gemini-3.8-flash', tasks: 2, completed: 1, completionRate: 0.5, requestsPerCompletedTask: 2, medianFirstTextMs: undefined, medianWallMs: undefined,
			results: [
				{ key: 'ACME-412', completed: true, graderExit: 0, requests: 2, tokensIn: 1200, tokensOut: 80, stopReason: 'end_turn', error: undefined, sawText: true },
				{ key: 'ACME-413', completed: false, graderExit: 3, requests: 2, tokensIn: 1200, tokensOut: 80, stopReason: 'end_turn', error: undefined, sawText: true },
			],
		});
		expect(benchResultsFileName(summary)).toBe('1.2.0-0.64.0-gemini-3.8-flash.json');
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
