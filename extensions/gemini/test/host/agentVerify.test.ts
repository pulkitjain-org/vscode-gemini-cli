/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => import('./vscodeStub'));
import { defaultProtected } from '../../src/acp/checksConfig';
import { commitAll, git } from '../../src/acp/worktrees';
import { AgentVerify, type AgentVerifyHost } from '../../src/host/agents/agentVerify';
import { AgentVerifyState } from '../../src/host/agents/agentVerifyState';
import { window, workspace } from './vscodeStub';

let root: string;
let repo: string;

beforeAll(() => {
	Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' });
});

// The repository's check: total.txt must hold 2.
const check = 'sh test/check.sh';
beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-verify-')));
	repo = path.join(root, 'shop');
	await fs.mkdir(path.join(repo, 'test'), { recursive: true });
	await git(repo, ['init', '--quiet', '--initial-branch=main']);
	await fs.writeFile(path.join(repo, 'total.txt'), '1\n');
	await fs.writeFile(path.join(repo, 'test', 'check.sh'), 'test "$(cat total.txt)" = 2 || { echo "expected 2, got $(cat total.txt)"; exit 1; }\n');
	await commitAll(repo, 'Initial');
	(workspace as { isTrusted: boolean }).isTrusted = true;
	window.showWarningMessage = async () => undefined;
});

afterEach(() => fs.rm(root, { recursive: true, force: true }));

/** Verify for one agent, "a", in the repository, with what it sent, reported and stored. */
function setUp(options: { own?: boolean; maxRounds?: number; busy?: boolean } = {}) {
	const state = new AgentVerifyState();
	const sent: string[] = [];
	const reports: string[] = [];
	const stored = new Map<string, unknown>();
	let changed = 0;
	const host: AgentVerifyHost = {
		state,
		globalState: { keys: () => [...stored.keys()], get: (key: string, fallback?: unknown) => stored.get(key) ?? fallback, update: async (key: string, value: unknown) => { stored.set(key, value); } } as AgentVerifyHost['globalState'],
		place: () => ({ folder: repo, title: 'Fix the total' }),
		busy: () => !!options.busy,
		send: (_id, text) => (sent.push(text), true),
		errors: async () => undefined,
		risky: () => false,
		maxRounds: () => options.maxRounds ?? 2,
		changed: () => { changed++; },
		report: (_id, text) => reports.push(text),
		log: () => undefined,
	};
	const entry = state.of('a');
	entry.config = { commands: [check], protected: defaultProtected(), afterTurn: 'ask' };
	entry.own = options.own ?? true;
	entry.folder = repo;
	return { verify: new AgentVerify(host), state, entry, sent, reports, stored, changes: () => changed };
}

/** The agent's next turn, as the pane reports it: it starts, edits or not, and ends. */
async function turn(verify: AgentVerify, edit?: () => Promise<void>): Promise<void> {
	verify.turnStarted('a');
	await edit?.();
	await verify.turnEnded('a', !!edit);
}

describe('Verify for an agent', () => {
	it('shows no row for an agent whose repository names no checks', () => {
		const state = new AgentVerifyState();
		state.of('a');
		expect(state.view('a')).toBeUndefined();
	});

	it('offers to run the checks, then shows a failure with what to do about it', async () => {
		const { verify, state, reports } = setUp();
		const before = state.view('a')!;
		await verify.act('a', 'run');
		const after = state.view('a')!;
		expect([before.state, before.text, before.actions.map(action => action.id), after.state, after.text, after.actions.map(action => action.id), reports]).toEqual([
			'none', `Checks not run: ${check}`, ['run'],
			'failed', `Checks failed: ${check} (exit code 1)`, ['send', 'run', 'output'],
			[`Checks failed: ${check} exited with 1.`],
		]);
	});

	it('sends the failure to the agent as text to read, when asked', async () => {
		const { verify, sent } = setUp();
		await verify.act('a', 'run');
		await verify.act('a', 'send');
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain(`<external source="checks" ref="${check}">`);
		expect(sent[0]).toContain('expected 2, got 1');
	});

	it('says a result is of an earlier version once the agent edits files', async () => {
		const { verify, state } = setUp();
		await fs.writeFile(path.join(repo, 'total.txt'), '2\n');
		await verify.act('a', 'run');
		const fresh = state.view('a')!;
		state.edited('a');
		expect([fresh.state, fresh.detail, state.view('a')!.detail]).toEqual(['passed', undefined, 'Checks passed on an earlier version: the agent changed files since.']);
	});

	it('names the test files when the checks only pass because the agent changed them', async () => {
		const { verify, state, reports } = setUp();
		await fs.writeFile(path.join(repo, 'test', 'check.sh'), 'true\n');
		await verify.act('a', 'run');
		const view = state.view('a')!;
		expect([view.state, view.text, view.detail, reports]).toEqual([
			'weakened', 'Passes with the agent\'s test changes, fails with the original tests', 'It changed: test/check.sh',
			['Checks pass only with its changes to the tests, and fail with the original test/check.sh.'],
		]);
	});

	it('runs after a turn only when the repository says always, and only when the turn edited files', async () => {
		const { verify, state, entry } = setUp();
		await turn(verify, async () => undefined);
		const asked = state.view('a')!.state;
		entry.config = { ...entry.config!, afterTurn: 'always' };
		await turn(verify);
		const unedited = state.view('a')!.state;
		await turn(verify, async () => undefined);
		expect([asked, unedited, state.view('a')!.state]).toEqual(['none', 'none', 'failed']);
	});
});

describe('keep going until checks pass', () => {
	it('sends failures after each turn until the checks pass', async () => {
		const { verify, state, sent } = setUp();
		await verify.act('a', 'goal');
		// Turned on while idle: the checks ran at once, failed, and the failure went to the agent.
		const first = sent.length;
		await turn(verify, () => fs.writeFile(path.join(repo, 'total.txt'), '3\n'));
		const second = sent.length;
		await turn(verify, () => fs.writeFile(path.join(repo, 'total.txt'), '2\n'));
		const view = state.view('a')!;
		expect([first, second, sent.length, view.state, view.goal.on, view.detail]).toEqual([1, 2, 2, 'passed', true, undefined]);
	});

	it('stops when the rounds are spent, and starts over with the user\'s own prompt', async () => {
		const { verify, state, entry, sent } = setUp({ maxRounds: 1 });
		await verify.act('a', 'goal');
		// The turn Verify started.
		entry.sent = true;
		await turn(verify, () => fs.writeFile(path.join(repo, 'total.txt'), '3\n'));
		const spent = [sent.length, state.view('a')!.detail];
		// The user's own prompt.
		await turn(verify, () => fs.writeFile(path.join(repo, 'total.txt'), '4\n'));
		expect([spent, sent.length, state.view('a')!.detail]).toEqual([[1, 'Stopped after 1 round: the checks still fail.'], 2, undefined]);
	});

	it('stops when a round changed no file', async () => {
		const { verify, state, entry, sent } = setUp();
		await verify.act('a', 'goal');
		entry.sent = true;
		await turn(verify);
		expect([sent.length, state.view('a')!.detail]).toEqual([1, 'Stopped: the last round changed no file.']);
	});

	it('never sends by itself with a limit of 0', async () => {
		const { verify, state, sent } = setUp({ maxRounds: 0 });
		await verify.act('a', 'goal');
		expect([sent.length, state.view('a')!.state, state.view('a')!.detail]).toEqual([0, 'failed', 'Stopped after 0 rounds: the checks still fail.']);
	});

	it('waits for a running turn before its first run', async () => {
		const { verify, state } = setUp({ busy: true });
		await verify.act('a', 'goal');
		expect([state.view('a')!.state, state.view('a')!.goal.on]).toEqual(['none', true]);
	});

	it('takes a command the user names in the composer, with no question about a repository\'s commands', async () => {
		const { verify, state, entry, sent } = setUp({ own: false });
		entry.config = undefined;
		(window as { showInputBox: () => Promise<string | undefined> }).showInputBox = async () => 'test "$(cat total.txt)" = 2';
		let asked = 0;
		window.showWarningMessage = async () => { asked++; return undefined; };
		await verify.askGoal('a');
		expect([asked, state.view('a')!.state, state.view('a')!.goal.on, sent.length, entry.own]).toEqual([0, 'failed', true, 1, true]);
	});
});

describe('a repository\'s commands', () => {
	it('run only once the user allowed them, and are remembered when asked', async () => {
		const { verify, state, stored } = setUp({ own: false });
		const picks: (string | undefined)[] = [undefined, 'Run and Remember'];
		let asked = 0;
		window.showWarningMessage = (async (_message: string, _options: unknown, ...items: { title: string }[]) => {
			const pick = picks[asked++];
			return items.find(item => item.title === pick);
		}) as typeof window.showWarningMessage;
		await verify.act('a', 'run');
		const declined = state.view('a')!.state;
		await verify.act('a', 'run');
		const ran = state.view('a')!.state;
		await verify.act('a', 'run');
		expect([declined, ran, asked, (stored.get('gemini.verify.allowed') as string[]).length]).toEqual(['none', 'failed', 2, 1]);
	});

	it('are asked about once for Run Once, which then covers each run after a turn', async () => {
		const { verify, state, stored } = setUp({ own: false });
		let asked = 0;
		window.showWarningMessage = (async (_message: string, _options: unknown, ...items: { title: string }[]) => {
			asked++;
			return items.find(item => item.title === 'Run Once');
		}) as typeof window.showWarningMessage;
		await verify.act('a', 'goal');
		state.of('a').sent = true;
		await turn(verify, () => fs.writeFile(path.join(repo, 'total.txt'), '2\n'));
		expect([asked, state.view('a')!.state, stored.get('gemini.verify.allowed')]).toEqual([1, 'passed', undefined]);
	});

	it('are not asked about again by a turn\'s end once the user said no', async () => {
		const { verify, entry } = setUp({ own: false });
		entry.config = { ...entry.config!, afterTurn: 'always' };
		let asked = 0;
		window.showWarningMessage = async () => { asked++; return undefined; };
		await turn(verify, async () => undefined);
		await turn(verify, async () => undefined);
		expect(asked).toBe(1);
	});

	it('do not run in a workspace that is not trusted', async () => {
		const { verify, state } = setUp();
		(workspace as { isTrusted: boolean }).isTrusted = false;
		await verify.act('a', 'run');
		expect([state.view('a')!.state, state.view('a')!.detail]).toEqual(['none', 'Checks run only in a trusted workspace.']);
	});
});

describe('a run in progress', () => {
	it('shows as running with Stop, and a new turn stops it', async () => {
		const { verify, state, entry } = setUp();
		const marker = path.join(root, 'started');
		entry.config = { ...entry.config!, commands: [`touch ${marker}; sleep 30 & wait`] };
		const running = verify.act('a', 'run');
		await expect.poll(() => fs.stat(marker).then(() => true, () => false)).toBe(true);
		const during = state.view('a')!;
		verify.turnStarted('a');
		await running;
		expect([during.state, during.actions.map(action => action.id), state.view('a')!.state]).toEqual(['running', ['stop', 'output'], 'none']);
	});
});
