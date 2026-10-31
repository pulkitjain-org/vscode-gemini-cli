/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { callDebugTool, type DebugBackend, DebugMcpServer, type DebugSessionView, debugTools } from '../../../src/acp/debug/debugMcp';
import { debugToolNames, initialDebugState, type DebugState } from '../../../src/acp/debug/debugState';
import { EvidenceStore } from '../../../src/acp/debug/evidenceStore';
import type { Hypothesis } from '../../../src/acp/debug/hypotheses';
import { PointSet } from '../../../src/acp/debug/points';
import type { McpHttpConfig } from '../../../src/acp/localMcpServer';

function fake(phase: DebugState['phase'] = 'instrument') {
	const calls: unknown[][] = [];
	const session = {
		state: { ...initialDebugState, phase },
		hypotheses: [] as Hypothesis[],
		points: new PointSet('agent-1', 'gc7f3a'),
		evidence: new EvidenceStore(() => 1),
	};
	const on = (agent: string) => agent === 'agent-1' ? session : undefined;
	const backend: DebugBackend = {
		session: on,
		setHypotheses: async (agent, list) => {
			calls.push(['setHypotheses', agent, list.map(h => `${h.id}:${h.status}`)]);
			session.hypotheses = [...list];
			return `${list.length} hypotheses kept.`;
		},
		configs: async agent => (calls.push(['configs', agent]), 'No launch.json.'),
		launch: async (agent, args) => (calls.push(['launch', agent, args]), 'Started.'),
		attach: async (agent, args) => (calls.push(['attach', agent, args]), 'Attached.'),
		addPoint: async (agent, input, asks) => {
			calls.push(['addPoint', agent, input, asks]);
			const added = session.points.add(input);
			return added.ok ? `${added.point.id} placed.` : added.error;
		},
		removePoints: async (agent, ids) => (calls.push(['removePoints', agent, ids]), 'Removed.'),
		reproduce: async (agent, steps) => (calls.push(['reproduce', agent, steps]), 'Card shown.'),
		inspect: async (agent, args) => (calls.push(['inspect', agent, args]), 'Values.'),
		requestLog: async (agent, why) => (calls.push(['requestLog', agent, why]), 'Asked.'),
		fix: async (agent, id) => (calls.push(['fix', agent, id]), `Fix for ${id}.`),
		verify: async agent => (calls.push(['verify', agent]), 'Verifying.'),
	};
	return { backend, calls, session: session as DebugSessionView & { state: DebugState; hypotheses: Hypothesis[] } };
}

const text = (result: { content: readonly { type: string; text?: string }[]; isError?: boolean }) => `${result.isError ? 'error: ' : ''}${result.content[0]?.type === 'text' ? result.content[0].text : ''}`;

describe('debug MCP server', () => {
	it('defines every tool of the design with an object schema', () => {
		expect({
			names: debugTools.map(t => t.name),
			objects: debugTools.every(t => t.inputSchema.type === 'object' && t.description.length > 20),
			required: Object.fromEntries(debugTools.filter(t => Array.isArray(t.inputSchema.required)).map(t => [t.name, t.inputSchema.required])),
		}).toEqual({
			names: [...debugToolNames],
			objects: true,
			required: {
				debug_hypotheses: ['hypotheses'],
				debug_logpoint: ['file', 'line', 'hypothesis', 'expressions'],
				debug_breakpoint: ['file', 'line', 'hypothesis'],
				debug_instrument: ['file', 'line', 'hypothesis', 'expressions'],
				debug_remove: ['ids'],
				debug_inspect: ['stop', 'expressions'],
				debug_request_log: ['why'],
				debug_fix: ['hypothesis'],
			},
		});
	});

	it('refuses a tool the phase does not allow, and every tool when Debug mode is off', async () => {
		const { backend, calls } = fake('investigate');
		expect({
			guarded: text(await callDebugTool(backend, 'agent-1', 'debug_logpoint', { file: 'a.ts', line: 1, hypothesis: 'h1', expressions: ['x'] })),
			off: text(await callDebugTool(backend, 'agent-2', 'debug_configs', {})),
			unknown: text(await callDebugTool(backend, 'agent-1', 'debug_hypotheses', { hypotheses: [{ claim: 'a' }] })).startsWith('error') ? 'refused' : 'ok',
			calls: calls.map(c => c[0]),
		}).toEqual({
			guarded: 'error: Debug mode is in Investigate: debug_logpoint is not available in this phase. Available now: debug_hypotheses, debug_configs, debug_request_log.',
			off: 'error: Debug mode is off for this session.',
			unknown: 'ok',
			calls: ['setHypotheses'],
		});
	});

	it('checks hypotheses against the session\'s evidence, and debug_fix against a confirmed one', async () => {
		const { backend, calls, session } = fake('analyse');
		session.evidence.startRun();
		session.evidence.record('p2', 'snapshot', 's');
		const noEvidence = text(await callDebugTool(backend, 'agent-1', 'debug_hypotheses', { hypotheses: [{ claim: 'a', status: 'confirmed', evidence: ['p2#5'] }] }));
		const kept = text(await callDebugTool(backend, 'agent-1', 'debug_hypotheses', { hypotheses: [{ claim: 'a', status: 'confirmed', evidence: ['p2#1'] }, { claim: 'b' }] }));
		const fixOpen = text(await callDebugTool(backend, 'agent-1', 'debug_fix', { hypothesis: 'h2' }));
		const fixMissing = text(await callDebugTool(backend, 'agent-1', 'debug_fix', {}));
		const fixed = text(await callDebugTool(backend, 'agent-1', 'debug_fix', { hypothesis: 'h1' }));
		session.state = { ...session.state, userAllowedEdits: true };
		const skipped = text(await callDebugTool(backend, 'agent-1', 'debug_fix', { hypothesis: 'h2' }));
		expect({ noEvidence, kept, fixOpen, fixMissing, fixed, skipped, fixes: calls.filter(c => c[0] === 'fix').map(c => c[2]) }).toEqual({
			noEvidence: 'error: Hypothesis h1 refers to p2#5, which is not evidence of this debug session.',
			kept: '2 hypotheses kept.',
			fixOpen: 'error: h2 is open, not confirmed: mark it confirmed with debug_hypotheses, giving the evidence references that show it, before fixing.',
			fixMissing: 'error: debug_fix needs a confirmed hypothesis\'s id; the list has h1 (confirmed), h2 (open).',
			fixed: 'Fix for h1.',
			skipped: 'Fix for h2.',
			fixes: ['h1', 'h2'],
		});
	});

	it('checks a point\'s arguments and expressions, and tells the host which ones need a card', async () => {
		const { backend, calls, session } = fake('instrument');
		session.hypotheses = [{ id: 'h1', claim: 'a', confirms: '', refutes: '', status: 'open', evidence: [] }];
		const results = [
			await callDebugTool(backend, 'agent-1', 'debug_logpoint', { file: 'cart.ts', line: 42, hypothesis: 'h1', expressions: ['cart.total', 'items.map(i => i.id)'] }),
			await callDebugTool(backend, 'agent-1', 'debug_logpoint', { file: 'cart.ts', line: 43, hypothesis: 'h9', expressions: ['x'] }),
			await callDebugTool(backend, 'agent-1', 'debug_logpoint', { file: 'cart.ts', line: 44, hypothesis: 'h1', expressions: ['process.env'] }),
			await callDebugTool(backend, 'agent-1', 'debug_logpoint', { file: 'cart.ts', hypothesis: 'h1', expressions: ['x'] }),
			await callDebugTool(backend, 'agent-1', 'debug_breakpoint', { file: 'cart.py', line: 88, hypothesis: 'h1', condition: 'len(items) > 1', hitCount: 2, hold: true }),
			await callDebugTool(backend, 'agent-1', 'debug_instrument', { file: 'page.js', line: 3, hypothesis: 'h1', expressions: ['total'], channel: 'smoke' }),
			await callDebugTool(backend, 'agent-1', 'debug_instrument', { file: 'page.js', line: 3, hypothesis: 'h1', expressions: ['total'], channel: 'http' }),
			await callDebugTool(backend, 'agent-1', 'debug_remove', { ids: ['p1', 'p7'] }),
			await callDebugTool(backend, 'agent-1', 'debug_remove', { ids: ['all'] }),
		].map(text);
		expect({ results, added: calls.filter(c => c[0] === 'addPoint').map(c => [c[2], c[3]]), removed: calls.filter(c => c[0] === 'removePoints').map(c => c[2]) }).toEqual({
			results: [
				'p1 placed.',
				'error: No hypothesis h9: the list has h1.',
				'error: The whole environment is never shown: name the one variable you need, such as process.env.PORT.',
				'error: debug_logpoint needs file, line and hypothesis.',
				'p2 placed.',
				'error: channel is console or http.',
				'p3 placed.',
				'error: No such point: p7. Points: p1, p2, p3.',
				'Removed.',
			],
			added: [
				[{ kind: 'logpoint', file: 'cart.ts', line: 42, hypothesis: 'h1', expressions: ['cart.total', 'items.map(i => i.id)'] }, [{ expression: 'items.map(i => i.id)', why: 'It defines a function.' }]],
				[{ kind: 'breakpoint', file: 'cart.py', line: 88, hypothesis: 'h1', condition: 'len(items) > 1', hitCount: 2, hold: true }, [{ expression: 'len(items) > 1', why: 'The condition is not a plain comparison of property paths and literals.' }]],
				[{ kind: 'marked', file: 'page.js', line: 3, hypothesis: 'h1', expressions: ['total'], channel: 'http' }, []],
			],
			removed: ['all'],
		});
	});

	it('answers debug_evidence from the store, by point or hypothesis, and passes the other calls through', async () => {
		const { backend, calls, session } = fake('verify');
		session.hypotheses = [{ id: 'h1', claim: 'a', confirms: '', refutes: '', status: 'open', evidence: [] }, { id: 'h2', claim: 'b', confirms: '', refutes: '', status: 'open', evidence: [] }];
		session.points.add({ kind: 'logpoint', file: 'a.ts', line: 1, hypothesis: 'h1', expressions: ['x'] });
		session.points.add({ kind: 'logpoint', file: 'b.ts', line: 2, hypothesis: 'h2', expressions: ['y'] });
		session.evidence.startRun();
		session.evidence.record('p1', 'values', '{"x":1}');
		session.evidence.record('p2', 'values', '{"y":2}');
		const byHypothesis = text(await callDebugTool(backend, 'agent-1', 'debug_evidence', { ids: ['h2'] }));
		const bad = text(await callDebugTool(backend, 'agent-1', 'debug_evidence', { ids: ['zz'] }));
		const passthrough = [
			await callDebugTool(backend, 'agent-1', 'debug_configs', {}),
			await callDebugTool(backend, 'agent-1', 'debug_launch', { config: 'Launch Server', kind: 'server' }),
			await callDebugTool(backend, 'agent-1', 'debug_launch', { kind: 'test' }),
			await callDebugTool(backend, 'agent-1', 'debug_attach', { port: 9229 }),
			await callDebugTool(backend, 'agent-1', 'debug_attach', { port: 70000 }),
			await callDebugTool(backend, 'agent-1', 'debug_reproduce', { steps: ['Open the cart', 'Reload'] }),
			await callDebugTool(backend, 'agent-1', 'debug_inspect', { stop: 's1', expressions: ['cart', 'cart.items.length', 'reset()'] }),
			await callDebugTool(backend, 'agent-1', 'debug_request_log', { why: 'the server logs each order' }),
			await callDebugTool(backend, 'agent-1', 'debug_nothing', {}),
		].map(text);
		expect({
			byHypothesis: byHypothesis.includes('p2 b.ts:2 (h2, logpoint)') && !byHypothesis.includes('p1 a.ts:1'),
			bad,
			passthrough,
			calls: calls.map(c => c.slice(0, 1).concat(c.slice(2))),
		}).toEqual({
			byHypothesis: true,
			bad: 'error: Ids are points (p1) or hypotheses (h1): zz is neither.',
			passthrough: ['No launch.json.', 'Started.', 'error: debug_launch needs a configuration\'s name (see debug_configs), or a program or module to run.', 'Attached.', 'error: The port is a number from 1 to 65535.', 'Card shown.', 'Values.', 'Asked.', 'error: Unknown tool: debug_nothing'],
			calls: [
				['configs'],
				['launch', { config: 'Launch Server', type: undefined, program: undefined, module: undefined, args: [], cwd: undefined, kind: 'server' }],
				['attach', { port: 9229, processId: undefined }],
				['reproduce', ['Open the cart', 'Reload']],
				['inspect', { stop: 's1', frame: 0, expressions: ['cart', 'cart.items.length', 'reset()'], asks: ['reset()'] }],
				['requestLog', 'the server logs each order'],
			],
		});
	});

	describe('on localMcpServer', () => {
		const servers: { dispose(): void }[] = [];
		afterEach(() => servers.splice(0).forEach(s => s.dispose()));

		async function post(config: McpHttpConfig, body: unknown): Promise<unknown> {
			const response = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: config.headers[0].value }, body: JSON.stringify(body) });
			return response.json();
		}

		it('lists the tools only for an agent in Debug mode and says Debug mode is off to the others', async () => {
			const { backend } = fake('investigate');
			const server = new DebugMcpServer(backend, '1');
			servers.push(server);
			await server.start();
			const inMode = server.configFor('agent-1')!;
			const outOfMode = server.configFor('agent-2')!;
			const listed = await post(inMode, { jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
			const none = await post(outOfMode, { jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: unknown[] } };
			const off = await post(outOfMode, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'debug_configs', arguments: {} } }) as { result: unknown };
			const initialized = await post(inMode, { jsonrpc: '2.0', id: 4, method: 'initialize', params: {} }) as { result: { serverInfo: { name: string }; instructions: string } };
			expect({ listed: listed.result.tools.length, none: none.result.tools.length, off: off.result, name: initialized.result.serverInfo.name, instructions: initialized.result.instructions.startsWith('Debug mode: collect evidence') }).toEqual({
				listed: debugTools.length,
				none: 0,
				off: { content: [{ type: 'text', text: 'Debug mode is off for this session.' }], isError: true },
				name: 'geminicode-debug',
				instructions: true,
			});
		});
	});
});
