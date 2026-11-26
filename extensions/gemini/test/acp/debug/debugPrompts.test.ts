/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { debugModeInstructions, phasePrompt } from '../../../src/acp/debug/debugPrompts';
import { debugPhases, initialDebugState } from '../../../src/acp/debug/debugState';
import { PointSet } from '../../../src/acp/debug/points';

const hypotheses = [
	{ id: 'h1', claim: 'The total is rounded before the discount.', confirms: 'total at p1 has no decimals', refutes: '', status: 'open' as const, evidence: [] },
	{ id: 'h2', claim: 'The discount is applied twice on reload.', confirms: '', refutes: '', status: 'confirmed' as const, evidence: ['p2#1'] },
];

describe('debug prompts', () => {
	it('carries the phase, the bug report, the hypotheses, the points and the phase\'s tools each turn', () => {
		const points = new PointSet('agent-1', 'gc7f3a');
		points.add({ kind: 'logpoint', file: 'cart.ts', line: 42, hypothesis: 'h1', expressions: ['cart.total'] });
		points.add({ kind: 'breakpoint', file: 'cart.ts', line: 88, hypothesis: 'h2' });
		points.add({ kind: 'marked', file: 'old.js', line: 1, hypothesis: 'h2', expressions: ['x'] });
		points.remove('p3');
		expect(phasePrompt({ state: { ...initialDebugState, phase: 'analyse', rounds: 1 }, hypotheses, points: points.all, hits: new Map([['p1', 12], ['p2', 1]]), report: 'Checkout total is wrong after reload.', userSaid: 'Reproduced', logFile: '~/Library/Logs/shop/server.log' })).toBe([
			'[Debug mode: Analyse, round 1]',
			'Bug report: Checkout total is wrong after reload.',
			'The user said: Reproduced.',
			'Hypotheses:\nh1 [open] The total is rounded before the discount.\n  Confirms: total at p1 has no decimals\nh2 [confirmed] The discount is applied twice on reload.\n  Evidence: p2#1',
			'Points:\np1 cart.ts:42 h1 logpoint cart.total - 12 hits\np2 cart.ts:88 h2 breakpoint - 1 hit',
			'Following the log file ~/Library/Logs/shop/server.log for lines added since the pick.',
			'Read debug_evidence. Update debug_hypotheses: confirmed or refuted with the evidence references (p3#12) that show it. One confirmed: call debug_fix with its id. None: place new points (back to Instrument) or refine the hypotheses.',
			'Tools available in this phase: debug_hypotheses, debug_configs, debug_logpoint, debug_breakpoint, debug_instrument, debug_remove, debug_evidence, debug_inspect, debug_request_log, debug_fix.',
		].join('\n\n'));
	});

	it('has guidance for every phase, the no-evidence case, Skip to Fix and exhausted rounds, all in ASCII', () => {
		const prompts = debugPhases.map(phase => phasePrompt({ state: { ...initialDebugState, phase }, hypotheses: [], points: [], hits: new Map() }));
		const noEvidence = phasePrompt({ state: { ...initialDebugState, phase: 'reproduce' }, hypotheses: [], points: [], hits: new Map(), noEvidence: true });
		const skipped = phasePrompt({ state: { ...initialDebugState, phase: 'fix', userAllowedEdits: true }, hypotheses: [], points: [], hits: new Map() });
		const exhausted = phasePrompt({ state: { ...initialDebugState, phase: 'analyse', rounds: 4 }, hypotheses: [], points: [], hits: new Map() });
		expect({
			distinct: new Set(prompts).size,
			empty: prompts[0].includes('No hypotheses yet.') && prompts[0].includes('Points: none.'),
			noEvidence: noEvidence.includes('The last run brought no evidence'),
			skipped: skipped.includes('The user allowed edits without a confirmed hypothesis'),
			exhausted: exhausted.includes('Several rounds have confirmed nothing'),
			ascii: [...prompts, noEvidence, skipped, exhausted, debugModeInstructions].every(t => /^[\x20-\x7e\n]*$/.test(t)),
			instructions: debugModeInstructions.includes('<external source="debug">') && debugModeInstructions.includes('debug_logpoint'),
		}).toEqual({ distinct: 7, empty: true, noEvidence: true, skipped: true, exhausted: true, ascii: true, instructions: true });
	});
});
