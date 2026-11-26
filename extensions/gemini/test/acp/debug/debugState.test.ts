/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { allows, debugPhases, debugToolNames, editRefusal, editsAllowed, initialDebugState, keepGoing, move, refusal, roundsExhausted, type DebugPhase, type DebugState } from '../../../src/acp/debug/debugState';

function at(phase: DebugPhase, extra: Partial<DebugState> = {}): DebugState {
	return { ...initialDebugState, ...extra, phase };
}

describe('debug state', () => {
	it('lets the agent move only along the phase table', () => {
		const moves: Record<string, string[]> = {};
		for (const from of debugPhases) {
			moves[from] = debugPhases.filter(to => move(at(from), to) !== undefined);
		}
		expect(moves).toEqual({
			investigate: ['instrument', 'cleanup'],
			instrument: ['reproduce', 'cleanup'],
			reproduce: ['analyse', 'cleanup'],
			analyse: ['instrument', 'fix', 'cleanup'],
			fix: ['verify', 'cleanup'],
			verify: ['fix', 'cleanup'],
			cleanup: [],
		});
	});

	it('lets the user move it anywhere but out of Clean up, and remembers Skip to Fix', () => {
		const skipped = move(at('investigate'), 'fix', { by: 'user' });
		const back = move(at('verify'), 'investigate', { by: 'user' });
		expect({ skipped, back, afterCleanup: move(at('cleanup'), 'investigate', { by: 'user' }) }).toEqual({
			skipped: { phase: 'fix', rounds: 0, roundCap: 4, userAllowedEdits: true },
			back: { phase: 'investigate', rounds: 0, roundCap: 4, userAllowedEdits: false },
			afterCleanup: undefined,
		});
	});

	it('counts rounds when Analyse goes back to Instrument, double without evidence, and asks after the cap', () => {
		let state = move(at('analyse'), 'instrument', { hadEvidence: true })!;
		state = move(at('analyse', state), 'instrument', { hadEvidence: false })!;
		const third = move(at('analyse', state), 'instrument')!;
		const kept = keepGoing(third);
		expect({
			afterTwo: state.rounds,
			afterThree: third.rounds,
			exhausted: roundsExhausted(third),
			keptCap: kept.roundCap,
			keptExhausted: roundsExhausted(kept),
			notInFix: roundsExhausted(at('fix', { rounds: 9 })),
		}).toEqual({ afterTwo: 3, afterThree: 4, exhausted: true, keptCap: 8, keptExhausted: false, notInFix: false });
	});

	it('allows each phase its tools and refuses the rest readably', () => {
		const byPhase: Record<string, string[]> = {};
		for (const phase of debugPhases) {
			byPhase[phase] = debugToolNames.filter(tool => allows(at(phase), tool));
		}
		expect(byPhase.investigate).toEqual(['debug_hypotheses', 'debug_configs', 'debug_request_log']);
		expect(byPhase.fix).toEqual(['debug_hypotheses', 'debug_configs', 'debug_remove', 'debug_evidence', 'debug_verify']);
		expect(byPhase.cleanup).toEqual([]);
		expect(byPhase.analyse).toContain('debug_fix');
		expect(byPhase.instrument).not.toContain('debug_fix');
		expect(refusal(at('investigate'), 'debug_logpoint')).toBe('Debug mode is in Investigate: debug_logpoint is not available in this phase. Available now: debug_hypotheses, debug_configs, debug_request_log.');
		expect(refusal(at('cleanup'), 'debug_evidence')).toBe('Debug mode has ended: debug_evidence is no longer available.');
	});

	it('lets file writes through in Fix only', () => {
		expect(debugPhases.filter(phase => editsAllowed(at(phase)))).toEqual(['fix']);
		expect(editRefusal(at('analyse'))).toBe('Debug mode is in Analyse: edits wait until a hypothesis is confirmed (debug_fix). To observe, use debug_logpoint or debug_instrument.');
	});
});
