/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// How a turn's work folds: which items go under the turn's "Worked for" line,
// how runs of the same kind of step become one line, and what the folded line
// says. No DOM, so it can be tested.

import { basename } from '../src/acp/attachments';
import type { TranscriptItem } from '../src/acp/chatTranscript';
import { subagentName, type ItemOf } from './chatLogic';

type ToolCall = ItemOf<'toolCall'>;

/** A turn's items after its prompt: those under the fold, and those shown after it, each in order. */
export interface TurnLayout {
	readonly folded: readonly TranscriptItem[];
	readonly after: readonly TranscriptItem[];
}

/** Steps: what the agent does on its way to the answer. */
function isStep(item: TranscriptItem): boolean {
	return item.kind === 'thought' || item.kind === 'toolCall' || item.kind === 'other';
}

/**
 * Splits the items of a turn (after its prompt) into the fold and what shows
 * after it. Thoughts, tool calls, unknown updates, answered questions and
 * what the agent said between steps fold; its last words (the answer), the
 * plan, notices, a question still waiting and the turn's end do not.
 */
export function turnLayout(items: readonly TranscriptItem[]): TurnLayout {
	let lastStep = -1;
	for (let i = items.length - 1; i >= 0; i--) {
		if (isStep(items[i])) {
			lastStep = i;
			break;
		}
	}
	const folded: TranscriptItem[] = [];
	const after: TranscriptItem[] = [];
	items.forEach((item, i) => {
		const folds = isStep(item)
			|| (item.kind === 'agent' && i < lastStep)
			|| (item.kind === 'permission' && !!item.answer);
		(folds ? folded : after).push(item);
	});
	return { folded, after };
}

/** What a run of tool calls is about; calls of one kind in a row share a line. */
export type StepKind = 'read' | 'search' | 'execute' | 'edit' | 'fetch' | 'other';

export function stepKind(call: ToolCall): StepKind {
	switch (call.toolKind) {
		case 'read':
		case 'search':
		case 'execute':
		case 'edit':
		case 'fetch':
			return call.toolKind;
		default:
			return 'other';
	}
}

/** One line of an opened fold: an item on its own, or a run of tool calls of one kind. */
export type FoldGroup =
	| { readonly kind: 'item'; readonly item: TranscriptItem }
	| { readonly kind: 'run'; readonly step: StepKind; readonly calls: readonly ToolCall[] };

/** A call that never joins a run: a failure, so it stays in sight, or a subagent, which has its own row. */
function standsAlone(call: ToolCall): boolean {
	return call.status === 'failed' || !!subagentName(call.title);
}

/** The fold's lines: two or more tool calls of one kind in a row become a run. */
export function foldGroups(folded: readonly TranscriptItem[]): FoldGroup[] {
	const groups: FoldGroup[] = [];
	let run: ToolCall[] = [];
	const flush = () => {
		if (run.length === 1) {
			groups.push({ kind: 'item', item: run[0] });
		} else if (run.length) {
			groups.push({ kind: 'run', step: stepKind(run[0]), calls: run });
		}
		run = [];
	};
	for (const item of folded) {
		if (item.kind === 'toolCall' && !standsAlone(item)) {
			if (run.length && stepKind(run[0]) !== stepKind(item)) {
				flush();
			}
			run.push(item);
			continue;
		}
		flush();
		groups.push({ kind: 'item', item });
	}
	flush();
	return groups;
}

/** The id a run is known by: its first call's, which stays the same as the run grows. */
export function runId(group: Extract<FoldGroup, { kind: 'run' }>): string {
	return `run-${group.calls[0].id}`;
}

/** A file the turn changed, with its lines added and removed over all its edits. */
export interface ChangedFile {
	readonly path: string;
	readonly added: number;
	readonly removed: number;
	/** The last edit to it, whose diff the chip opens. */
	readonly itemId: string;
}

/** What a fold says about itself while folded. */
export interface WorkSummary {
	/** Tool calls of each kind; reads and edits count files, the rest count calls. */
	readonly counts: Readonly<Record<StepKind, number>>;
	/** Calls that failed, in order. */
	readonly failed: readonly ToolCall[];
	/** Ids of failed calls that the same call, run again later in the turn, got through. */
	readonly recovered: ReadonlySet<string>;
	readonly changes: readonly ChangedFile[];
}

export function workSummary(folded: readonly TranscriptItem[]): WorkSummary {
	const counts: Record<StepKind, number> = { read: 0, search: 0, execute: 0, edit: 0, fetch: 0, other: 0 };
	const readPaths = new Set<string>();
	const failed: ToolCall[] = [];
	const recovered = new Set<string>();
	const changes = new Map<string, ChangedFile>();
	const calls = folded.filter((item): item is ToolCall => item.kind === 'toolCall');
	calls.forEach((call, i) => {
		const kind = stepKind(call);
		if (kind === 'read' && call.locations.length) {
			for (const location of call.locations) {
				readPaths.add(location.path);
			}
		} else if (kind !== 'edit') {
			counts[kind]++;
		}
		for (const detail of call.details) {
			if (detail.type === 'diff') {
				const before = changes.get(detail.path);
				changes.set(detail.path, { path: detail.path, added: (before?.added ?? 0) + detail.added, removed: (before?.removed ?? 0) + detail.removed, itemId: call.id });
			}
		}
		if (kind === 'edit' && !call.details.some(detail => detail.type === 'diff')) {
			// An edit with no diff (a failed one, or an older CLI) still counts.
			counts.edit++;
		}
		if (call.status === 'failed') {
			failed.push(call);
			if (calls.slice(i + 1).some(later => later.title === call.title && later.status === 'completed')) {
				recovered.add(call.id);
			}
		}
	});
	counts.read += readPaths.size;
	counts.edit += changes.size;
	return { counts, failed, recovered, changes: [...changes.values()] };
}

/** Short names for what a run's calls acted on, for its line: file names, search patterns, command names. */
export function runPeek(calls: readonly ToolCall[], limit = 8): string[] {
	const names: string[] = [];
	for (const call of calls) {
		if (names.length === limit) {
			break;
		}
		const kind = stepKind(call);
		const space = call.title.indexOf(' ');
		const rest = space === -1 ? call.title : call.title.slice(space + 1);
		let name: string;
		if (kind === 'execute') {
			// "grep -r x src": the command's name.
			name = call.title.trim().split(/\s+/)[0] ?? '';
		} else if ((kind === 'read' || kind === 'edit') && call.locations.length) {
			name = call.locations.map(location => basename(location.path)).join(', ');
		} else if (kind === 'search') {
			name = call.title;
		} else {
			name = rest;
		}
		if (name && !names.includes(name)) {
			names.push(name);
		}
	}
	return names;
}

/** The first thing a finished thought is about: its first bold heading (as Gemini writes them), else its first line. */
export function thoughtSummary(text: string): string {
	const heading = /\*\*([^*\n]+)\*\*/.exec(text)?.[1];
	return (heading ?? text.split('\n').find(line => line.trim()) ?? '').trim();
}

/** Indexes of the prompts that start each turn: user messages. */
export function turnStarts(items: readonly TranscriptItem[]): number[] {
	const starts: number[] = [];
	items.forEach((item, i) => {
		if (item.kind === 'user') {
			starts.push(i);
		}
	});
	return starts;
}

/** The index of the prompt whose turn the item at `index` is in, or -1 before the first prompt. */
export function turnOf(starts: readonly number[], index: number): number {
	let low = 0;
	let high = starts.length - 1;
	let found = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (starts[mid] <= index) {
			found = starts[mid];
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return found;
}
