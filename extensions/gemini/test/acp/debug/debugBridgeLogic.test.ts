/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { attachConfig, breakpointSpec, describeConfigs, parseJsonc, formatSnapshot, handleStop, Holds, OutputLines, OutputTail, reloadsItself, resolveLaunchConfig, SessionTracker, smallConfig, type StoppedEvent, takeSnapshot, type Timers, trackedNonce } from '../../../src/acp/debug/debugBridgeLogic';
import type { Point } from '../../../src/acp/debug/points';
import { dapEvent, dapResponse, FakeDap, never, output, stopped, stoppedThreadScript } from '../../fake-dap/fakeDap';

function tracker() {
	const seen = { marked: [] as string[], stops: [] as StoppedEvent[], exits: [] as (number | undefined)[], ended: 0 };
	const session = new SessionTracker({
		marked: line => seen.marked.push(line),
		stopped: stop => seen.stops.push(stop),
		exited: code => seen.exits.push(code),
		terminated: () => seen.ended++,
	});
	return { session, seen };
}

const breakpoint = (id: string, extra: Partial<Point> = {}): Point => ({ id, agent: 'a', kind: 'breakpoint', file: 'src/cart.js', line: 9, hypothesis: 'h1', status: 'active', ...extra });

/** Timers the test moves by hand. */
function manualTimers(): Timers & { run(): void; readonly pending: number } {
	const queue = new Map<number, () => void>();
	let next = 0;
	return {
		set: callback => {
			queue.set(++next, callback);
			return next;
		},
		clear: handle => void queue.delete(handle as number),
		run: () => {
			const callbacks = [...queue.values()];
			queue.clear();
			callbacks.forEach(callback => callback());
		},
		get pending() {
			return queue.size;
		},
	};
}

describe('the tracker', () => {
	it('skips responses and plain output, joins marker lines sent in pieces, and reports stops, exits and the end', () => {
		const { session, seen } = tracker();
		session.onMessage(dapResponse('threads'));
		session.onMessage(output('listening on 3001\n'));
		session.onMessage(output('@@gc:gc7f3a:p1@@ {"cart.t', 'console'));
		session.onMessage(output('otal":9}\nplain after\n', 'console'));
		session.onMessage(stopped(4, [7]));
		session.onMessage(dapEvent('exited', { exitCode: 1 }));
		session.onMessage(dapEvent('terminated'));
		session.end();
		expect({ ...seen, tail: session.tail.text() }).toEqual({
			marked: ['@@gc:gc7f3a:p1@@ {"cart.total":9}'],
			stops: [{ reason: 'breakpoint', threadId: 4, hitBreakpointIds: [7] }],
			exits: [1],
			ended: 1,
			tail: 'listening on 3001\nplain after\n',
		});
	});

	it('skips 100,000 mixed messages quickly', () => {
		const { session } = tracker();
		const messages = [dapResponse('stackTrace'), output('a plain line of output\n'), { type: 'request', command: 'next' }];
		const start = performance.now();
		for (let i = 0; i < 100_000; i++) {
			session.onMessage(messages[i % 3]);
		}
		expect(performance.now() - start).toBeLessThan(500);
	});

	it('caps a line in progress and the tail of plain output', () => {
		const lines = new OutputLines();
		lines.push('stdout', 'x'.repeat(20_000));
		const [line] = lines.push('stdout', '\n');
		const tail = new OutputTail(10);
		tail.append('0123456789abc');
		tail.append('de');
		expect({ line: line.length, tail: tail.text(), size: tail.length }).toEqual({ line: 16 * 1024, tail: '56789abcde', size: 10 });
	});
});

describe('stops', () => {
	it('takes a snapshot of the top frame two levels down, then continues the thread', async () => {
		const dap = new FakeDap(stoppedThreadScript());
		const outcome = await handleStop({ reason: 'breakpoint', threadId: 4, hitBreakpointIds: [7] }, {
			pointFor: async id => id === 7 ? breakpoint('p2') : undefined,
			request: dap.request,
			snapshots: () => 0,
			stopId: () => 's1',
			holds: new Holds(),
		});
		expect({ outcome, commands: dap.commands }).toEqual({
			outcome: { kind: 'snapshot', point: 'p2', text: ['#0 applyDiscount (cart.js:9)', '#1 checkout (server.js:20)', '  cart = Object', '    total = 9', '    discounts = Array(2)', '  code = "SAVE10"'].join('\n') },
			commands: ['stackTrace', 'scopes', 'variables', 'variables', 'continue'],
		});
	});

	it('leaves the user\'s stops alone, and only counts a point past its snapshot cap', async () => {
		const dap = new FakeDap(stoppedThreadScript());
		const context = { pointFor: async (id: number) => id === 7 ? breakpoint('p2') : undefined, request: dap.request, stopId: () => 's1', holds: new Holds() };
		const user = await handleStop({ reason: 'breakpoint', threadId: 4, hitBreakpointIds: [3] }, { ...context, snapshots: () => 0 });
		const pause = await handleStop({ reason: 'pause', threadId: 4, hitBreakpointIds: [] }, { ...context, snapshots: () => 0 });
		const counted = await handleStop({ reason: 'breakpoint', threadId: 4, hitBreakpointIds: [7] }, { ...context, snapshots: () => 50 });
		expect({ user, pause, counted, commands: dap.commands }).toEqual({ user: { kind: 'user' }, pause: { kind: 'user' }, counted: { kind: 'counted', point: 'p2' }, commands: ['continue'] });
	});

	it('holds a stop with hold until released, and continues it by itself after 30 seconds', async () => {
		const dap = new FakeDap(stoppedThreadScript());
		const timers = manualTimers();
		const holds = new Holds(timers);
		const outcome = await handleStop({ reason: 'breakpoint', threadId: 4, hitBreakpointIds: [7] }, { pointFor: async () => breakpoint('p2', { hold: true }), request: dap.request, snapshots: () => 0, stopId: () => 's1', holds });
		const heldBefore = holds.size;
		const continuedBefore = dap.commands.filter(c => c === 'continue').length;
		timers.run();
		await Promise.resolve();
		expect({ kind: outcome.kind, heldBefore, continuedBefore, heldAfter: holds.size, continuedAfter: dap.commands.filter(c => c === 'continue').length }).toEqual({ kind: 'held', heldBefore: 1, continuedBefore: 0, heldAfter: 0, continuedAfter: 1 });
	});

	it('gives up on a request the adapter never answers, and says the snapshot is partial', async () => {
		const timers = manualTimers();
		const dap = new FakeDap(stoppedThreadScript({ variables: () => never }));
		const taking = takeSnapshot(dap.request, 4, Date.now, timers);
		for (let i = 0; i < 5; i++) {
			await new Promise(resolve => setImmediate(resolve));
			timers.run();
		}
		const snapshot = await taking;
		expect({ frames: snapshot.frames.length, variables: snapshot.variables, partial: snapshot.partial, text: formatSnapshot(snapshot).split('\n').pop() }).toEqual({ frames: 2, variables: [], partial: true, text: '  (partial: a request timed out or a cap was reached)' });
	});
});

describe('launch and attach', () => {
	it('resolves a copy of the configuration for the agent\'s folder, with the marker and the guard, and shows env names only', () => {
		const user = { type: 'node', request: 'launch', name: 'Server', program: '${workspaceFolder}/src/server.js', args: ['--port', '3001'], env: { PORT: '3001', API_TOKEN: 'secret' }, serverReadyAction: { action: 'openExternally' }, preLaunchTask: 'npm: build' };
		const resolved = resolveLaunchConfig(user, '/w/shop-debug', 'gc7f3a');
		expect(resolved).toEqual({
			ok: true,
			config: { type: 'node', request: 'launch', name: 'Server', program: '/w/shop-debug/src/server.js', args: ['--port', '3001'], env: { PORT: '3001', API_TOKEN: 'secret', GEMINI_DEBUG: 'gc7f3a' }, preLaunchTask: 'npm: build', __geminiDebug: 'gc7f3a' },
			card: { name: 'Server', type: 'node', request: 'launch', program: '/w/shop-debug/src/server.js', args: ['--port', '3001'], preLaunchTask: 'npm: build', envNames: ['API_TOKEN', 'PORT'] },
		});
		expect(user.serverReadyAction).toBeDefined();
	});

	it('refuses variables that depend on the editor or run commands, compounds and a missing type', () => {
		const refusals = [
			resolveLaunchConfig({ type: 'node', program: '${file}' }, '/w', 'gc7f3a'),
			resolveLaunchConfig({ type: 'node', args: ['${input:pick}', '${command:x}'] }, '/w', 'gc7f3a'),
			resolveLaunchConfig({ configurations: ['a', 'b'] }, '/w', 'gc7f3a'),
			resolveLaunchConfig({ program: 'x.js' }, '/w', 'gc7f3a'),
		].map(r => r.ok ? 'ok' : r.error.split(':')[0]);
		expect(refusals).toEqual(['The configuration uses ${file}, which depends on the editor or runs a command; Debug mode fills in only the folder\'s variables and ${env', 'The configuration uses ${input', 'Compound configurations are not supported yet', 'The configuration has no type (such as node or debugpy).']);
	});

	it('builds small configurations inside the folder, and attaches only to this machine', () => {
		const join = (a: string, b: string) => `${a}/${b}`;
		expect({
			node: smallConfig({ program: 'src/server.js', args: [] }, '/w', join),
			python: smallConfig({ program: 'report.py', args: ['--n', '3'] }, '/w', join),
			outside: smallConfig({ program: '../etc/x.js', args: [] }, '/w', join),
			attachNode: attachConfig({ port: 9229 }, 'gc7f3a'),
			attachPython: attachConfig({ port: 5678 }, 'gc7f3a'),
			watches: [reloadsItself({ runtimeExecutable: 'nodemon' }), reloadsItself({ program: 'server.js' })],
		}).toEqual({
			node: { ok: true, config: { type: 'node', request: 'launch', name: 'Gemini debug', program: '/w/src/server.js', args: [], cwd: '/w', console: 'internalConsole', skipFiles: ['<node_internals>/**'] } },
			python: { ok: true, config: { type: 'debugpy', request: 'launch', name: 'Gemini debug', program: '/w/report.py', args: ['--n', '3'], cwd: '/w', console: 'internalConsole', justMyCode: true } },
			outside: { ok: false, error: 'The program must be inside the agent\'s folder, as a relative path.' },
			attachNode: { name: 'Gemini attach', request: 'attach', __geminiDebug: 'gc7f3a', type: 'node', address: '127.0.0.1', port: 9229, skipFiles: ['<node_internals>/**'] },
			attachPython: { name: 'Gemini attach', request: 'attach', __geminiDebug: 'gc7f3a', type: 'debugpy', connect: { host: '127.0.0.1', port: 5678 }, justMyCode: true },
			watches: [true, false],
		});
	});

	it('tracks a session by its marker or its parent\'s, and never the user\'s', () => {
		const parent = { configuration: { type: 'node', __geminiDebug: 'gc7f3a' } };
		expect([trackedNonce(parent), trackedNonce({ configuration: { type: 'pwa-node' }, parentSession: parent }), trackedNonce({ configuration: { type: 'node' } })]).toEqual(['gc7f3a', 'gc7f3a', undefined]);
	});

	it('reads launch.json with its comments and trailing commas, leaving strings alone', () => {
		const text = '{\n\t// Use IntelliSense\n\t"configurations": [\n\t\t{ "name": "a // b", "url": "http://x/*y*/", /* note */ "type": "node", },\n\t],\n}';
		expect([parseJsonc(text), parseJsonc(''), parseJsonc('{ nope')]).toEqual([{ configurations: [{ name: 'a // b', url: 'http://x/*y*/', type: 'node' }] }, undefined, undefined]);
	});

	it('lists configurations without env values', () => {
		const text = describeConfigs([{ folder: 'shop', config: { name: 'Server', type: 'node', request: 'launch', program: 'src/server.js', env: { TOKEN: 'x' } } }], [{ name: 'All', parts: ['Server', 'Worker'] }], [], [9229]);
		expect(text).toEqual([
			'Launch configurations:',
			'- Server: node launch src/server.js, env: TOKEN (values not shown) (shop)',
			'- All: compound of Server, Worker (not supported yet: launch the parts one at a time)',
			'No debug sessions running.',
			'Debug ports listening on 127.0.0.1: 9229 (debug_attach with the port).',
		].join('\n'));
	});
});

describe('breakpoint fields', () => {
	it('guards the agent\'s points to the program Debug mode launched, joined with its own condition', () => {
		const logpoint: Point = { id: 'p1', agent: 'a', kind: 'logpoint', file: 'src/cart.js', line: 9, hypothesis: 'h1', status: 'active', expressions: ['cart.total'] };
		expect({
			logpoint: breakpointSpec(logpoint, 'gc7f3a', true),
			breakpoint: breakpointSpec(breakpoint('p2', { condition: 'cart.items.length > 1', hitCount: 2 }), 'gc7f3a', true),
			python: breakpointSpec(breakpoint('p3', { file: 'report.py' }), 'gc7f3a', true),
			attached: breakpointSpec(logpoint, 'gc7f3a', false),
		}).toEqual({
			logpoint: { condition: 'process.env.GEMINI_DEBUG === "gc7f3a"', logMessage: '@@gc:gc7f3a:p1@@ {"cart.total":{cart.total}}' },
			breakpoint: { condition: '(process.env.GEMINI_DEBUG === "gc7f3a") && (cart.items.length > 1)', hitCondition: '2' },
			python: { condition: '__import__("os").environ.get("GEMINI_DEBUG") == "gc7f3a"' },
			attached: { logMessage: '@@gc:gc7f3a:p1@@ {"cart.total":{cart.total}}' },
		});
	});
});
