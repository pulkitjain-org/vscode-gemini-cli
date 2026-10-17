/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The parts of a turn's fold: its line ("Worked for 3m 12s · read 14 files"),
// what stays in sight while it is folded (the files it changed, steps that
// failed) and the line of a run of steps. transcript.ts puts them together
// with the items' own elements; workFold.ts decides what goes where.

import { basename } from '../src/acp/attachments';
import { teamToolTitle } from '../src/acp/toolLinks';
import { format, formatDuration, toolKindIcon, type ItemOf } from './chatLogic';
import { toolLogo } from './toolLogos';
import { button, el, icon, setTip } from './dom';
import { strings, vscode } from './view';
import { runPeek, type FoldGroup, type StepKind, type WorkSummary } from './workFold';

const stepOrder: readonly StepKind[] = ['read', 'search', 'execute', 'edit', 'fetch', 'other'];

/** "read 14 files, searched 11 patterns, ran 9 commands". */
export function summaryText(summary: WorkSummary): string {
	const { counts } = strings.work;
	return stepOrder
		.filter(kind => summary.counts[kind])
		.map(kind => summary.counts[kind] === 1 ? counts[kind][0] : format(counts[kind][1], summary.counts[kind]))
		.join(', ');
}

/** How the turn went, for its fold line. */
export type FoldState =
	| { readonly kind: 'working' }
	| { readonly kind: 'done'; readonly durationMs?: number }
	| { readonly kind: 'stopped'; readonly durationMs?: number };

/** Makes `node` a button that runs `toggle` on a click, Return or Space, with its open state for screen readers. */
function toggleRow(node: HTMLElement, open: boolean, toggle: () => void): void {
	node.tabIndex = 0;
	node.setAttribute('role', 'button');
	node.setAttribute('aria-expanded', String(open));
	node.addEventListener('click', toggle);
	node.addEventListener('keydown', event => {
		if (event.target === node && (event.key === 'Enter' || event.key === ' ')) {
			event.preventDefault();
			toggle();
		}
	});
}

/** The fold's own line: a chevron (a spinner while it works), how it went, and what it did. */
export function renderFoldHead(state: FoldState, steps: number, summary: WorkSummary, open: boolean, toggle: () => void): HTMLElement {
	const head = el('div', 'work-head');
	toggleRow(head, open, toggle);
	const { work } = strings;
	let lead: string;
	switch (state.kind) {
		case 'working':
			lead = strings.activityWorking;
			break;
		case 'stopped':
			lead = state.durationMs !== undefined ? format(work.stoppedAfter, formatDuration(state.durationMs)) : work.stopped;
			break;
		case 'done':
			lead = state.durationMs !== undefined ? format(strings.workedFor, formatDuration(state.durationMs)) : steps === 1 ? work.oneStep : format(work.steps, steps);
			break;
	}
	head.append(state.kind === 'working' ? icon('loading', 'codicon-modifier-spin work-spinner') : icon('chevron-right', 'chevron'), el('span', 'work-lead', lead));
	const text = summaryText(summary);
	if (text) {
		head.append(el('span', 'work-summary', text));
	}
	const failed = summary.failed.length;
	if (failed) {
		const fixed = summary.failed.every(call => summary.recovered.has(call.id));
		head.append(el('span', fixed ? 'work-failed fixed' : 'work-failed', format(fixed ? work.failedFixed : work.failed, failed)));
	}
	return head;
}

/**
 * What stays in sight while the fold is folded: the files the turn changed,
 * each opening its diff, and every step that failed, with a way to its output.
 */
export function renderPinned(summary: WorkSummary, showOutput: (call: ItemOf<'toolCall'>) => void): HTMLElement | undefined {
	const pinned = el('div', 'work-pinned');
	if (summary.changes.length) {
		const row = el('div', 'work-changes');
		row.append(icon('edit'), el('span', 'work-changes-label', strings.work.changed));
		for (const change of summary.changes) {
			const chip = button('chip diff-chip', basename(change.path), () => vscode.postMessage({ type: 'openDiff', itemId: change.itemId, path: change.path }));
			chip.append(el('span', 'added', `+${change.added}`), el('span', 'removed', `-${change.removed}`));
			setTip(chip, `${strings.openDiff}: ${change.path}`);
			row.append(chip);
		}
		pinned.append(row);
	}
	for (const call of summary.failed) {
		const fixed = summary.recovered.has(call.id);
		const row = el('div', fixed ? 'work-failure fixed' : 'work-failure');
		row.append(icon('error'), el('span', 'work-failure-title', call.title));
		if (fixed) {
			row.append(el('span', 'work-failure-note', strings.work.fixedLater));
		}
		row.append(button('work-show', strings.work.showOutput, () => showOutput(call)));
		pinned.append(row);
	}
	return pinned.childElementCount ? pinned : undefined;
}

/** How many names a run's line lists. */
const peekLimit = 8;

/** A run's line: "Searched 9 patterns  "cart-empty", "Explore our Creations", +7" and how it is going. */
export function renderRunRow(group: Extract<FoldGroup, { kind: 'run' }>, open: boolean, toggle: () => void): HTMLElement {
	const row = el('div', 'tool-row work-run-row');
	toggleRow(row, open, toggle);
	const { calls } = group;
	const peek = runPeek(calls, peekLimit);
	// Past the limit, say how many more; repeats of a name are not counted twice below it.
	const more = peek.length === peekLimit ? calls.length - peekLimit : 0;
	const label = el('span', 'tool-title');
	label.append(el('span', 'tool-verb', format(strings.work.runs[group.step], calls.length)));
	const team = teamToolTitle(calls[0].title, strings.teamToolVerbs);
	const kindIcon = team ? toolLogo(team.tool, 14) : icon(toolKindIcon(calls[0].toolKind));
	kindIcon.classList.add('kind-icon');
	row.append(icon('chevron-right', 'chevron'), kindIcon, label);
	row.append(el('span', 'work-peek', peek.join(', ') + (more > 0 ? `, +${more}` : '')));
	const running = calls.some(call => call.status === 'pending' || call.status === 'in_progress');
	row.append(running ? icon('loading', 'status-icon codicon-modifier-spin') : icon('check', 'status-icon completed'));
	return row;
}
