/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => import('./vscodeStub'));
import { AgentTerminals, blockIdleMs } from '../../src/host/agentTerminals';
import { terminalEvents, window } from './vscodeStub';

/** A terminal with shell integration, as `createTerminal` makes one; `executions` are the commands its shell reported. */
function fakeTerminal() {
	const terminal = {
		name: 'Agent',
		exitStatus: undefined as unknown,
		shellIntegration: { cwd: undefined, executeCommand: vi.fn(() => execution('')) },
		show: vi.fn(),
		sendText: vi.fn(),
		dispose: vi.fn(),
	};
	return terminal;
}

/** A command the shell reported starting, with no output. */
function execution(commandLine: string) {
	return { commandLine: { value: commandLine }, cwd: undefined, read: () => (async function* () { })() };
}

/** How long `ends` lets pass after the end event, for the end handler's wait on the stream's last chunk. */
const endSettleMs = 200;

/** The shell reports `commandLine` ending in `terminal` with `exitCode`, and `endSettleMs` pass. */
async function ends(terminal: unknown, commandLine: string, exitCode: number | undefined): Promise<void> {
	const each = execution(commandLine);
	terminalEvents.start.fire({ terminal, execution: each });
	terminalEvents.end.fire({ terminal, execution: each, exitCode });
	await vi.advanceTimersByTimeAsync(endSettleMs);
}

describe('AgentTerminals.run', () => {
	let terminals: AgentTerminals;
	let terminal: ReturnType<typeof fakeTerminal>;

	beforeEach(() => {
		vi.useFakeTimers();
		terminal = fakeTerminal();
		window.createTerminal = () => terminal;
		terminals = new AgentTerminals(async () => 1);
	});
	afterEach(() => {
		terminals.dispose();
		vi.useRealTimers();
	});

	it('ends with the one command of a one-line run as soon as it ends', async () => {
		const run = terminals.run('a', 'Agent', '/work', 'npm test', false);
		await vi.advanceTimersByTimeAsync(0);
		await ends(terminal, 'npm test', 0);
		expect((await run).command?.commandLine).toEqual('npm test');
	});

	it('ends with the last command of a block once as many have ended as it has lines', async () => {
		const run = terminals.run('a', 'Agent', '/work', 'npm ci\nnpm test', false);
		await vi.advanceTimersByTimeAsync(0);
		await ends(terminal, 'npm ci', 0);
		await ends(terminal, 'npm test', 0);
		expect((await run).command?.commandLine).toEqual('npm test');
	});

	it('ends with the command that failed, without waiting for the rest of the block', async () => {
		const run = terminals.run('a', 'Agent', '/work', 'npm ci\nnpm test', false);
		await vi.advanceTimersByTimeAsync(0);
		await ends(terminal, 'npm ci', 1);
		expect((await run).exitCode).toEqual(1);
	});

	it('ends when the shell took the block as one command and is back at its prompt', async () => {
		const run = terminals.run('a', 'Agent', '/work', 'npm ci\nnpm test', false);
		await vi.advanceTimersByTimeAsync(0);
		await ends(terminal, 'npm ci\nnpm test', 0);
		let outcome: unknown;
		void run.then(value => { outcome = value; });
		await vi.advanceTimersByTimeAsync(blockIdleMs - endSettleMs - 1);
		expect(outcome).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(outcome).toBeDefined();
		// The terminal is free for the next Run, rather than a fresh one being opened.
		const again = terminals.run('a', 'Agent', '/work', 'npm test', false);
		await vi.advanceTimersByTimeAsync(0);
		expect(terminal.shellIntegration.executeCommand).toHaveBeenCalledTimes(2);
		await ends(terminal, 'npm test', 0);
		await again;
	});

	it('keeps waiting while the next command of a block starts in time', async () => {
		const run = terminals.run('a', 'Agent', '/work', 'npm ci\nnpm test\nnpm run lint', false);
		await vi.advanceTimersByTimeAsync(0);
		await ends(terminal, 'npm ci', 0);
		await vi.advanceTimersByTimeAsync(blockIdleMs - endSettleMs - 100);
		terminalEvents.start.fire({ terminal, execution: execution('npm test') });
		await vi.advanceTimersByTimeAsync(blockIdleMs);
		let outcome: unknown;
		void run.then(value => { outcome = value; });
		await vi.advanceTimersByTimeAsync(0);
		expect(outcome).toBeUndefined();
	});

	it('forgets a command still running in a terminal that closed, and ends the wait on it', async () => {
		const run = terminals.run('a', 'Agent', '/work', 'npm test', false);
		await vi.advanceTimersByTimeAsync(0);
		terminalEvents.start.fire({ terminal, execution: execution('npm test') });
		const running = (terminals as unknown as { running: Map<unknown, unknown> }).running;
		expect(running.size).toEqual(1);
		terminalEvents.close.fire(terminal);
		expect([running.size, await run]).toEqual([0, {}]);
	});
});
