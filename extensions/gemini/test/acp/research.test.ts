/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime, AgentRuntimeState } from '../../src/acp/agentRuntime';
import { applyVerdicts, mergePrompt, parseSlices, parseWorkerReply, plainReport, ResearchRun, type ResearchProgress, toVerify, workerModel } from '../../src/acp/research';
import { researchQuestionOf } from '../../src/acp/researchQuestion';
import { AgentSidecar } from '../../src/acp/sidecar';
import type { FakeAgentScript, ScriptedStep } from '../fake-agent/fakeAgent';
import { fakeAgentCommand, waitFor } from '../helpers';

const reply = (text: string): ScriptedStep => ({ step: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
const slice = { title: 'src/auth', focus: 'Where tokens are read', paths: ['src/auth/**'] };

describe('research parts and replies', () => {
	it('takes the question from /research, and nothing else', () => {
		expect(['/research where are tokens logged?', '/research', '/researcher x', 'research x'].map(researchQuestionOf)).toEqual(['where are tokens logged?', '', undefined, undefined]);
	});

	it('reads the planner\'s parts, at most the limit, and falls back to one part', () => {
		const planned = 'Here:\n```json\n[{"title":"src/auth","focus":"tokens","paths":["src/auth/**"]},{"title":"src/api","paths":["src/api/**"]},{"focus":"no title"},{"title":"c"}]\n```';
		expect({
			parts: parseSlices(planned, 'Q?', 2),
			fallback: parseSlices('I could not split it.', 'Q?'),
		}).toEqual({
			parts: [{ title: 'src/auth', focus: 'tokens', paths: ['src/auth/**'] }, { title: 'src/api', focus: 'Q?', paths: ['src/api/**'] }],
			fallback: [{ title: 'Whole repository', focus: 'Q?', paths: [] }],
		});
	});

	it('reads a worker\'s findings, the verifier\'s verdicts, and writes a plain report when the merge fails', () => {
		const result = parseWorkerReply('Looked.\n```json\n{"summary":"Two reads.","findings":[{"claim":"Logs the header","file":"src/trace.ts","line":41,"severity":"high"},{"claim":"Reads the token","file":"src/auth.ts","line":"x","severity":"odd"},{"file":"no claim"}]}\n```', slice);
		const check = toVerify([result]);
		const verified = applyVerdicts(check, '```json\n[{"index":1,"verdict":"confirmed"}]\n```');
		expect({
			result,
			noJson: parseWorkerReply('Nothing in auth handles tokens.', slice).summary,
			verified,
			merge: mergePrompt('Q?', [result], verified).split('\n').slice(2, 6),
			plain: plainReport([result, { slice: { ...slice, title: 'src/api' }, summary: '', findings: [], failed: 'took too long' }], applyVerdicts(check, '[{"index":1,"verdict":"refuted"}]')),
			model: [workerModel({ currentId: 'pro', available: [{ id: 'gemini-pro', name: '' }, { id: 'gemini-flash-lite', name: '' }, { id: 'gemini-flash', name: '' }] }), workerModel(undefined)],
		}).toEqual({
			result: {
				slice, summary: 'Two reads.',
				findings: [{ claim: 'Logs the header', file: 'src/trace.ts', line: 41, severity: 'high' }, { claim: 'Reads the token', file: 'src/auth.ts', severity: 'info' }],
			},
			noJson: 'Nothing in auth handles tokens.',
			verified: [{ claim: 'Logs the header', file: 'src/trace.ts', line: 41, severity: 'high', verified: 'confirmed' }],
			merge: ['<part title="src/auth">', 'Two reads.', '- [high, confirmed] Logs the header (src/trace.ts:41)', '- [info] Reads the token (src/auth.ts)'],
			plain: '**src/auth**\nTwo reads.\n- Reads the token `src/auth.ts`\n\n**src/api** (not finished: took too long)',
			model: ['gemini-flash', undefined],
		});
	});
});

describe('ResearchRun', () => {
	let sidecar: AgentSidecar | undefined;
	let runtime: AgentRuntime | undefined;
	const cwd = mkdtempSync(path.join(tmpdir(), 'research-test-'));
	afterEach(() => {
		runtime?.dispose();
		sidecar?.dispose();
	});

	async function start(script: FakeAgentScript): Promise<AgentRuntime> {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand(script), cwd: undefined, restartDelaysMs: [] });
		runtime = new AgentRuntime(sidecar);
		const ready = waitFor<AgentRuntimeState>(runtime.onDidChangeState, s => s.kind === 'ready');
		sidecar.start();
		await ready;
		return runtime;
	}

	it('plans, reads each part in a read-only session, verifies the serious findings and merges, giving each worker the index and releasing it', async () => {
		const runtime = await start({
			turns: [
				[
					{ step: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'read', kind: 'read', status: 'completed', locations: [{ path: `${cwd}/src/trace.ts` }] } },
					{ step: 'permission', request: { toolCall: { toolCallId: 'w1', title: 'write_file', kind: 'edit' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } },
					reply('\n```json\n{"summary":"Auth reads it.","findings":[{"claim":"Logs the header","file":"src/trace.ts","line":41,"severity":"high"}]}\n```'),
				],
				[reply('```json\n{"summary":"Nothing in the API.","findings":[]}\n```')],
				[reply('```json\n[{"index":1,"verdict":"confirmed"}]\n```')],
			],
		});
		const asked: string[] = [];
		const servers: string[] = [];
		const released: string[] = [];
		const progress: ResearchProgress[] = [];
		const run = new ResearchRun('Where are tokens logged?', {
			runtime, cwd, concurrency: 1,
			mcpServers: worker => (servers.push(worker), []),
			release: worker => released.push(worker),
			ask: async system => {
				asked.push(system.split('\n')[0]);
				return asked.length === 1 ? '[{"title":"src/auth","paths":["src/auth/**"]},{"title":"src/api","paths":["src/api/**"]}]' : 'Tokens are logged in one place: `src/trace.ts:41` (verified).';
			},
			onProgress: p => progress.push(p),
		});
		const report = await run.run();
		expect({
			report,
			asked,
			workers: servers.map(s => s.replace(/^research-\w+-\d+-/, '')),
			released: released.length,
			states: [...new Set(progress.map(p => p.state))],
			last: progress.at(-1),
		}).toEqual({
			report: 'Tokens are logged in one place: `src/trace.ts:41` (verified).',
			asked: ['You split a question about a code repository into independent parts, so several read-only researchers can answer it at the same time, each reading one part of the code.', 'You write the answer to a question about a code repository from what several read-only researchers found, each in one part of the code.'],
			workers: ['worker-0', 'worker-1', 'verify'],
			released: 3,
			states: ['planning', 'reading', 'verifying', 'merging', 'done'],
			last: { state: 'done', slices: [{ title: 'src/auth', state: 'done', files: 1, findings: 1 }, { title: 'src/api', state: 'done', files: 0, findings: 0 }] },
		});
	});

	it('stops every worker on Stop and reports what was done', async () => {
		const runtime = await start({ turns: [[{ step: 'delay', ms: 5000 }, reply('late')]] });
		const progress: ResearchProgress[] = [];
		const run = new ResearchRun('Q?', {
			runtime, cwd, concurrency: 2,
			mcpServers: () => [],
			release: () => undefined,
			ask: async () => '[{"title":"a"}]',
			onProgress: p => {
				progress.push(p);
				if (p.state === 'reading' && p.slices[0]?.state === 'reading') {
					setTimeout(() => run.stop(), 50);
				}
			},
		});
		const report = await run.run();
		expect({ report, last: progress.at(-1)?.state }).toEqual({ report: '**a** (not finished: stopped)', last: 'stopped' });
	});
});
