/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { checkHypotheses, confirmed, describeHypotheses, parseEvidenceRef } from '../../../src/acp/debug/hypotheses';

const exists = (ref: { point: string; event: number }) => ref.point === 'p3' && ref.event <= 12;

describe('hypotheses', () => {
	it('keeps given ids, assigns missing ones, and defaults the status to open', () => {
		const result = checkHypotheses([
			{ id: 'h2', claim: 'The discount is applied twice.', confirms: 'two applyDiscount calls', refutes: 'one call', status: 'confirmed', evidence: ['p3#4', 'p3#5'] },
			{ claim: 'Rounding happens first.' },
		], exists);
		expect(result).toEqual({
			ok: true,
			list: [
				{ id: 'h2', claim: 'The discount is applied twice.', confirms: 'two applyDiscount calls', refutes: 'one call', status: 'confirmed', evidence: ['p3#4', 'p3#5'] },
				{ id: 'h3', claim: 'Rounding happens first.', confirms: '', refutes: '', status: 'open', evidence: [] },
			],
		});
	});

	it('refuses the list when it is too long, an id repeats, or a confirmed one has no evidence', () => {
		const five = Array.from({ length: 6 }, (_, i) => ({ claim: `claim ${i}` }));
		expect([
			checkHypotheses([], exists),
			checkHypotheses(five, exists),
			checkHypotheses([{ id: 'h1', claim: 'a' }, { id: 'h1', claim: 'b' }], exists),
			checkHypotheses([{ id: 'x1', claim: 'a' }], exists),
			checkHypotheses([{ claim: 'a', status: 'confirmed' }], exists),
			checkHypotheses([{ claim: 'a', status: 'refuted', evidence: ['p3#99'] }], exists),
			checkHypotheses([{ claim: 'a', status: 'open', evidence: ['nope'] }], exists),
			checkHypotheses([{ claim: 'a', status: 'maybe' }], exists),
			checkHypotheses('not a list', exists),
		].map(r => r.ok ? 'ok' : r.error)).toEqual([
			'The list needs at least one hypothesis.',
			'At most 5 hypotheses at a time: keep the ones the evidence still allows.',
			'Hypothesis id h1 is used twice.',
			'Hypothesis ids are h1, h2, ...; "x1" is not one.',
			'Hypothesis h1 is confirmed without evidence: give the references (p3#12) that show it, or keep it open.',
			'Hypothesis h1 refers to p3#99, which is not evidence of this debug session.',
			'Hypothesis h1 refers to evidence "nope"; references are point#event, such as p3#12.',
			'Hypothesis h1 has status "maybe"; it is one of open, confirmed, refuted, unclear.',
			'debug_hypotheses takes a list of hypotheses.',
		]);
	});

	it('parses evidence references and describes the list for the model', () => {
		const checked = checkHypotheses([{ claim: 'Stale rate.', refutes: 'rate is fresh', status: 'refuted', evidence: ['p3#2'] }, { claim: 'Open one.' }], exists);
		const list = checked.ok ? checked.list : [];
		expect({ ref: parseEvidenceRef(' p3#12 '), bad: parseEvidenceRef('p3'), confirmed: confirmed(list).length, text: describeHypotheses(list) }).toEqual({
			ref: { point: 'p3', event: 12 },
			bad: undefined,
			confirmed: 0,
			text: 'h1 [refuted] Stale rate.\n  Refutes: rate is fresh\n  Evidence: p3#2\nh2 [open] Open one.',
		});
	});
});
