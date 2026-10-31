/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The hypotheses of a debug session (DEBUG_MODE.md): the list the agent sets
// whole with `debug_hypotheses`, checked here before GeminiCode keeps it: how
// many, their ids, their statuses, and that a confirmed or refuted one names
// evidence that exists (`p3#12`: point 3, event 12).

export type HypothesisStatus = 'open' | 'confirmed' | 'refuted' | 'unclear';

export const hypothesisStatuses: readonly HypothesisStatus[] = ['open', 'confirmed', 'refuted', 'unclear'];

export interface Hypothesis {
	/** `h1`, `h2`, ... */
	readonly id: string;
	readonly claim: string;
	/** What evidence would confirm it. */
	readonly confirms: string;
	/** What evidence would refute it. */
	readonly refutes: string;
	readonly status: HypothesisStatus;
	/** Evidence references (`p3#12`) behind a confirmed or refuted status. */
	readonly evidence: readonly string[];
}

/** The list is two to five; one is accepted for a bug with one obvious cause, more than five is refused. */
export const maxHypotheses = 5;
export const maxClaimChars = 400;

export interface EvidenceRef {
	readonly point: string;
	readonly event: number;
}

const refPattern = /^(p\d+)#(\d+)$/;
const idPattern = /^h\d+$/;

/** `p3#12` as a point id and an event number, or undefined. */
export function parseEvidenceRef(ref: string): EvidenceRef | undefined {
	const match = refPattern.exec(ref.trim());
	return match ? { point: match[1], event: Number(match[2]) } : undefined;
}

export type HypothesesCheck = { readonly ok: true; readonly list: readonly Hypothesis[] } | { readonly ok: false; readonly error: string };

/**
 * The list as `debug_hypotheses` gave it, checked. Ids are kept when given
 * (`h1`...) and assigned in order when not. `exists` says whether an
 * evidence reference names an event of this debug session.
 */
export function checkHypotheses(input: unknown, exists: (ref: EvidenceRef) => boolean): HypothesesCheck {
	if (!Array.isArray(input)) {
		return { ok: false, error: 'debug_hypotheses takes a list of hypotheses.' };
	}
	if (!input.length) {
		return { ok: false, error: 'The list needs at least one hypothesis.' };
	}
	if (input.length > maxHypotheses) {
		return { ok: false, error: `At most ${maxHypotheses} hypotheses at a time: keep the ones the evidence still allows.` };
	}
	const list: Hypothesis[] = [];
	const ids = new Set<string>();
	// Ids given anywhere in the list, so an assigned one never collides with a later given one.
	const given = new Set(input.map(item => typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).id === 'string' ? ((item as Record<string, unknown>).id as string).trim() : ''));
	for (let i = 0; i < input.length; i++) {
		const item = input[i];
		if (typeof item !== 'object' || item === null || Array.isArray(item)) {
			return { ok: false, error: `Hypothesis ${i + 1} is not an object.` };
		}
		const record = item as Record<string, unknown>;
		const str = (key: string) => typeof record[key] === 'string' ? (record[key] as string).trim() : '';
		const givenId = str('id');
		let n = i + 1;
		while (!givenId && (given.has(`h${n}`) || ids.has(`h${n}`))) {
			n++;
		}
		const id = givenId || `h${n}`;
		if (!idPattern.test(id)) {
			return { ok: false, error: `Hypothesis ids are h1, h2, ...; "${givenId}" is not one.` };
		}
		if (ids.has(id)) {
			return { ok: false, error: `Hypothesis id ${id} is used twice.` };
		}
		ids.add(id);
		const claim = str('claim');
		if (!claim) {
			return { ok: false, error: `Hypothesis ${id} needs a claim.` };
		}
		if (claim.length > maxClaimChars) {
			return { ok: false, error: `Hypothesis ${id}'s claim is longer than ${maxClaimChars} characters: one line, please.` };
		}
		const status = str('status') || 'open';
		if (!(hypothesisStatuses as readonly string[]).includes(status)) {
			return { ok: false, error: `Hypothesis ${id} has status "${status}"; it is one of ${hypothesisStatuses.join(', ')}.` };
		}
		const rawRefs = Array.isArray(record.evidence) ? record.evidence : [];
		const evidence: string[] = [];
		for (const raw of rawRefs) {
			const ref = typeof raw === 'string' ? parseEvidenceRef(raw) : undefined;
			if (!ref) {
				return { ok: false, error: `Hypothesis ${id} refers to evidence "${String(raw)}"; references are point#event, such as p3#12.` };
			}
			if (!exists(ref)) {
				return { ok: false, error: `Hypothesis ${id} refers to ${ref.point}#${ref.event}, which is not evidence of this debug session.` };
			}
			evidence.push(`${ref.point}#${ref.event}`);
		}
		if ((status === 'confirmed' || status === 'refuted') && !evidence.length) {
			return { ok: false, error: `Hypothesis ${id} is ${status} without evidence: give the references (p3#12) that show it, or keep it open.` };
		}
		list.push({ id, claim, confirms: str('confirms'), refutes: str('refutes'), status: status as HypothesisStatus, evidence });
	}
	return { ok: true, list };
}

/** The confirmed hypotheses, in order. */
export function confirmed(list: readonly Hypothesis[]): readonly Hypothesis[] {
	return list.filter(h => h.status === 'confirmed');
}

/** The hypothesis with `id`, or undefined. */
export function findHypothesis(list: readonly Hypothesis[], id: string): Hypothesis | undefined {
	return list.find(h => h.id === id);
}

/** One line per hypothesis, as the model and the card read it. */
export function describeHypotheses(list: readonly Hypothesis[]): string {
	if (!list.length) {
		return 'No hypotheses yet.';
	}
	return list.map(h => {
		const lines = [`${h.id} [${h.status}] ${h.claim}`];
		if (h.confirms) {
			lines.push(`  Confirms: ${h.confirms}`);
		}
		if (h.refutes) {
			lines.push(`  Refutes: ${h.refutes}`);
		}
		if (h.evidence.length) {
			lines.push(`  Evidence: ${h.evidence.join(', ')}`);
		}
		return lines.join('\n');
	}).join('\n');
}
