/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultProtected } from '../../src/acp/checksConfig';
import { runChecks, verifyFolder } from '../../src/acp/verifyRun';
import { snapshotTree } from '../../src/acp/worktreeApply';
import { commitAll, git } from '../../src/acp/worktrees';

let root: string;
let repo: string;
let base: string;

beforeAll(() => {
	Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' });
});

// A repository whose check is a shell script: the "test" asserts that total.txt holds 2.
const check = 'sh test/check.sh';
beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'verify-run-')));
	repo = path.join(root, 'shop');
	await fs.mkdir(path.join(repo, 'test'), { recursive: true });
	await git(repo, ['init', '--quiet', '--initial-branch=main']);
	await fs.writeFile(path.join(repo, 'total.txt'), '1\n');
	await fs.writeFile(path.join(repo, 'test', 'check.sh'), 'test "$(cat total.txt)" = 2 || { echo "expected 2, got $(cat total.txt)"; exit 1; }\necho ok\n');
	await fs.writeFile(path.join(repo, '.gitignore'), 'deps/\n');
	await commitAll(repo, 'Initial');
	base = String(await git(repo, ['rev-parse', 'HEAD'])).trim();
	// What git does not carry, and the check needs where it runs.
	await fs.mkdir(path.join(repo, 'deps'));
	await fs.writeFile(path.join(repo, 'deps', 'tool'), 'installed\n');
});

afterEach(() => fs.rm(root, { recursive: true, force: true }));

const verify = (change: Partial<Parameters<typeof verifyFolder>[0]> = {}) => verifyFolder({ folder: repo, commands: [check], protected: defaultProtected(), base, now: () => 5, ...change });

describe('running a repository\'s checks', () => {
	it('fails with the failing command\'s exit code and output, bound to the tree it ran on', async () => {
		const result = await verify();
		expect({ ...result, runs: result.runs.map(run => ({ ...run, ms: 0 })) }).toEqual({
			status: 'failed', tree: await snapshotTree(repo), at: 5, protectedChanged: [],
			runs: [{ command: check, exitCode: 1, ms: 0, lines: ['expected 2, got 1'], dropped: 0 }],
		});
	});

	it('passes once the agent fixed the code, with one pass when it touched no protected file', async () => {
		await fs.writeFile(path.join(repo, 'total.txt'), '2\n');
		const result = await verify();
		expect([result.status, result.runs.map(run => run.exitCode), result.originalRuns, result.protectedChanged]).toEqual(['passed', [0], undefined, []]);
	});

	it('stops at the first command that fails', async () => {
		const runs = await runChecks(['echo one', 'exit 3', 'echo never'], repo, undefined);
		expect(runs.map(run => [run.command, run.exitCode, run.lines])).toEqual([['echo one', 0, ['one']], ['exit 3', 3, []]]);
	});

	it('says so when the checks only pass because the agent changed the test', async () => {
		// The agent "fixed" the failure by making the test accept 1.
		await fs.writeFile(path.join(repo, 'test', 'check.sh'), 'echo ok\n');
		const before = await snapshotTree(repo);
		const result = await verify();
		expect([result.status, result.protectedChanged, result.runs.map(run => run.exitCode), result.originalRuns?.map(run => [run.exitCode, run.lines])]).toEqual([
			'weakened', ['test/check.sh'], [0], [[1, ['expected 2, got 1']]],
		]);
		// The agent's own folder is as it was: the second pass ran in a copy.
		expect([await fs.readFile(path.join(repo, 'test', 'check.sh'), 'utf8'), await snapshotTree(repo), result.tree]).toEqual(['echo ok\n', before, before]);
	});

	it('passes when the code is right and the changed test still passes as it was', async () => {
		await fs.writeFile(path.join(repo, 'total.txt'), '2\n');
		await fs.appendFile(path.join(repo, 'test', 'check.sh'), 'echo also ok\n');
		const result = await verify();
		expect([result.status, result.protectedChanged, result.originalRuns?.map(run => run.lines)]).toEqual(['passed', ['test/check.sh'], [['ok']]]);
	});

	it('runs the second pass with what git ignores, and without a test the agent added', async () => {
		await fs.writeFile(path.join(repo, 'total.txt'), '2\n');
		await fs.writeFile(path.join(repo, 'test', 'extra.sh'), 'echo extra\n');
		const result = await verify({ commands: ['cat deps/tool', 'test ! -f test/extra.sh && echo original'] });
		// The first pass sees the agent's new test file; the second, the original tests only.
		expect([result.runs.map(run => run.exitCode), result.originalRuns?.map(run => run.lines), result.status]).toEqual([[0, 1], undefined, 'failed']);
		const again = await verify({ commands: ['cat deps/tool', 'ls test'] });
		expect([again.status, again.runs[1].lines, again.originalRuns?.map(run => run.lines)]).toEqual(['passed', ['check.sh', 'extra.sh'], [['installed'], ['check.sh']]]);
	});

	it('has no second pass without the commit the agent started from', async () => {
		await fs.writeFile(path.join(repo, 'test', 'check.sh'), 'echo ok\n');
		const result = await verify({ base: undefined });
		expect([result.status, result.originalRuns, result.protectedChanged]).toEqual(['passed', undefined, []]);
	});

	it('is stopped, not failed, when it is cancelled, and ends what the command started', async () => {
		const stop = new AbortController();
		const marker = path.join(root, 'started');
		const running = verify({ commands: [`touch ${marker}; sleep 30 & wait`], signal: stop.signal });
		await expect.poll(() => fs.stat(marker).then(() => true, () => false)).toBe(true);
		const started = Date.now();
		stop.abort();
		const result = await running;
		expect([result.status, result.runs.map(run => run.exitCode), Date.now() - started < 10_000]).toEqual(['stopped', [-1], true]);
	});

	it('stops a command that runs past its time', async () => {
		const result = await verify({ commands: ['sleep 30'], timeoutMs: 200 });
		expect([result.status, result.runs[0].exitCode, result.runs[0].lines.at(-1)]).toEqual(['failed', -1, 'Stopped after 0 minutes.']);
	});
});
