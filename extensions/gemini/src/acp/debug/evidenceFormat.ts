/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The evidence as the model reads it (DEBUG_MODE.md, Evidence for the
// model): per point, ordered by hypothesis, the counts, first and last
// values, distinct values and the last few events, then a timeline across
// points, all under one character budget and wrapped as external text. And
// the comparison of two runs the verify card and the model share.

import type { EvidenceEvent, EvidenceStore } from './evidenceStore';
import type { Point } from './points';

/** About 3,000 tokens: well under the CLI's cap on one tool output, for a mode that runs many turns. */
export const evidenceBudgetChars = 12_000;
/** A value, in what the model gets. */
export const maxValueChars = 500;
const timelineEvents = 40;
const eventsPerPoint = 5;

/**
 * Program output framed as data, with inner `<external>` tags escaped so the
 * text cannot close its frame; the same frame as teamTools' `external`, with
 * the source Debug mode's.
 */
export function externalDebug(ref: string, text: string): string {
	return `<external source="debug" ref="${ref.replace(/["<>\r\n]/g, '')}">\n${text.replace(/<(\/?external)\b/gi, '&lt;$1')}\n</external>`;
}

export function clipValue(text: string, max = maxValueChars): string {
	return text.length > max ? `${text.slice(0, max)}... (${text.length - max} more characters)` : text;
}

function seconds(ms: number): string {
	return `+${(ms / 1000).toFixed(3)} s`;
}

export interface FormatOptions {
	readonly points: readonly Point[];
	/** Only these points; all of them when unset. */
	readonly only?: readonly string[];
	/** Only this run and later. */
	readonly since?: number;
	/** Events per point; the default is 5. */
	readonly limit?: number;
	readonly budget?: number;
}

/** The text `debug_evidence` answers with, under the budget. */
export function formatEvidence(store: EvidenceStore, options: FormatOptions): string {
	const budget = options.budget ?? evidenceBudgetChars;
	const perPoint = Math.max(1, Math.min(options.limit ?? eventsPerPoint, 50));
	const chosen = options.points.filter(p => !options.only || options.only.includes(p.id));
	const ordered = [...chosen].sort((a, b) => a.hypothesis.localeCompare(b.hypothesis, undefined, { numeric: true }) || a.id.localeCompare(b.id, undefined, { numeric: true }));
	const runs = store.runs.filter(r => options.since === undefined || r.id >= options.since);
	const header: string[] = [];
	if (!runs.length) {
		header.push('No reproduction has run yet.');
	} else {
		header.push(`Runs: ${runs.map(r => `${r.id} ${r.label}${r.endedAt === undefined ? ' (running)' : r.exitCode === undefined ? '' : ` (exit ${r.exitCode})`}`).join('; ')}.`);
	}
	const totals = store.totals;
	header.push(`${totals.hits} hits, ${totals.drops} dropped, ${totals.redactions} redacted${totals.evicted ? `, ${totals.evicted} oldest events no longer kept` : ''}.`);

	const sections: string[][] = [];
	for (const point of ordered) {
		const stats = store.pointStats(point.id);
		const lines = [`${point.id} ${point.file}:${point.line} (${point.hypothesis}, ${point.kind === 'marked' ? 'marked line' : point.kind})`];
		if (!stats || !stats.hits) {
			lines.push(point.status === 'removed' ? '  removed' : point.bound === false ? '  no hits; not bound (check source maps, or use a marked line)' : '  no hits');
			sections.push(lines);
			continue;
		}
		lines.push(`  ${stats.hits} hit${stats.hits === 1 ? '' : 's'}${stats.drops ? `, ${stats.drops} dropped` : ''}${stats.redactions ? `, ${stats.redactions} redacted` : ''}`);
		if (stats.first !== undefined) {
			lines.push(`  first: ${clipValue(stats.first)}`);
		}
		if (stats.last !== undefined && stats.last !== stats.first) {
			lines.push(`  last: ${clipValue(stats.last)}`);
		}
		if (stats.distinct.size > 1) {
			lines.push(`  distinct: ${[...stats.distinct].map(([value, count]) => `${clipValue(value, 120)} (x${count})`).join('; ')}${stats.otherValues ? `; ${stats.otherValues} other` : ''}`);
		}
		const events = store.query({ points: [point.id], since: options.since, limit: perPoint });
		for (const event of events) {
			lines.push(`  ${point.id}#${event.id} ${seconds(event.time)} run ${event.run}${event.kind === 'values' ? '' : ` ${event.kind}`}: ${clipValue(event.text)}`);
		}
		sections.push(lines);
	}

	const timeline = store.query({ points: ordered.map(p => p.id), since: options.since }).slice(0, timelineEvents);
	const timelineLines = timeline.length > 1 ? ['Timeline (first events across points):', ...timeline.map(e => `  ${seconds(e.time)} run ${e.run} ${e.point}#${e.id}: ${clipValue(e.text, 120)}`)] : [];

	// The wrapper's tags count against the budget too.
	const wrapper = externalDebug('evidence', '').length;
	return externalDebug('evidence', fit([header, ...sections, timelineLines].filter(s => s.length), Math.max(0, budget - wrapper)));
}

/** Room kept for the note that says how many lines were left out. */
const trimmedNoteChars = 90;

/** The sections joined under `budget`: the events are trimmed from the back of each section first, then the timeline, then whole text. */
function fit(sections: string[][], budget: number): string {
	const join = () => sections.map(s => s.join('\n')).join('\n\n');
	let text = join();
	let trimmed = 0;
	// Once anything is trimmed, the note saying so must fit as well.
	while (text.length > (trimmed || text.length > budget ? budget - trimmedNoteChars : budget)) {
		const longest = sections.reduce((best, s, i) => s.length > 2 && (best < 0 || s.length > sections[best].length) ? i : best, -1);
		if (longest < 0) {
			break;
		}
		sections[longest].pop();
		trimmed++;
		text = join();
	}
	if (trimmed) {
		text = `${text}\n\n(${trimmed} lines left out to fit; ask for fewer points or a smaller limit.)`;
	}
	return text.length > budget ? `${text.slice(0, budget - 20)}\n(cut to fit)` : text;
}

export interface PointComparison {
	readonly point: string;
	readonly where: string;
	readonly before: { readonly hits: number; readonly last?: string };
	readonly after: { readonly hits: number; readonly last?: string };
	readonly changed: boolean;
}

/** Two runs side by side per point: counts and the last value of each. */
export function compareRuns(store: EvidenceStore, points: readonly Point[], before: number, after: number): readonly PointComparison[] {
	const last = (events: readonly EvidenceEvent[]) => events.length ? events[events.length - 1].text : undefined;
	return points.map(point => {
		const a = store.query({ points: [point.id] }).filter(e => e.run === before);
		const b = store.query({ points: [point.id] }).filter(e => e.run === after);
		const comparison = { point: point.id, where: `${point.file}:${point.line}`, before: { hits: a.length, last: last(a) }, after: { hits: b.length, last: last(b) } };
		return { ...comparison, changed: comparison.before.hits !== comparison.after.hits || comparison.before.last !== comparison.after.last };
	});
}

/** The comparison as the model and the verify card read it. */
export function formatComparison(comparisons: readonly PointComparison[], before: number, after: number): string {
	if (!comparisons.length) {
		return `Runs ${before} and ${after}: no points to compare.`;
	}
	const lines = comparisons.map(c => `${c.point} ${c.where}: before ${c.before.hits} hit${c.before.hits === 1 ? '' : 's'}${c.before.last === undefined ? '' : ` (${clipValue(c.before.last, 120)})`}, after ${c.after.hits} hit${c.after.hits === 1 ? '' : 's'}${c.after.last === undefined ? '' : ` (${clipValue(c.after.last, 120)})`}${c.changed ? '' : ' - same'}`);
	return externalDebug(`runs ${before} and ${after}`, `Before the fix (run ${before}) and after (run ${after}):\n${lines.join('\n')}`);
}
