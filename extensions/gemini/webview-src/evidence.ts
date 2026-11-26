/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Evidence page (src/host/debug/evidencePage.ts): every event of a
// Debug mode by time, filtered by run, hypothesis, point or a search of the
// values, a snapshot unfolding into its frames and variables, the last two
// runs side by side, and the totals. Rows come a page of 200 at a time.

import type { EvidenceFilter, EvidenceRow, EvidenceStrings, EvidenceView, FromEvidence, ToEvidence } from '../src/host/debug/debugProtocol';
import { bootPage } from './panelBoot';
import { button, el } from './panelDom';
import { selectMenu } from './selectMenu';

const { strings, post, main, start } = bootPage<ToEvidence, FromEvidence, EvidenceStrings>();
const pageRows = 200;
let filter: EvidenceFilter = { limit: pageRows };
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const heading = el('h1', 'evidence-title', strings.title);
const controls = el('div', 'evidence-controls');
const runPick = el('select');
const hypothesisPick = el('select');
const pointPick = el('select');
const search = el('input');
search.type = 'search';
search.placeholder = strings.search;
search.setAttribute('aria-label', strings.search);
runPick.setAttribute('aria-label', strings.run);
hypothesisPick.setAttribute('aria-label', strings.allHypotheses);
pointPick.setAttribute('aria-label', strings.allPoints);
// Themed menus, not the system's: the <select>s stay, hidden, as the values.
const menus = [selectMenu(runPick, strings.run), selectMenu(hypothesisPick, strings.allHypotheses), selectMenu(pointPick, strings.allPoints)];
controls.append(...menus.map(menu => menu.element), search);
const note = el('p', 'evidence-note');
const compare = el('section', 'evidence-compare');
const table = el('table', 'evidence-table');
const footer = el('div', 'evidence-footer');
main.append(heading, note, controls, compare, table, footer);

function setFilter(change: Partial<EvidenceFilter>): void {
	filter = { ...filter, limit: pageRows, ...change };
	post({ type: 'filter', filter });
}

runPick.addEventListener('change', () => setFilter({ run: runPick.value ? Number(runPick.value) : undefined }));
hypothesisPick.addEventListener('change', () => setFilter({ hypothesis: hypothesisPick.value || undefined }));
pointPick.addEventListener('change', () => setFilter({ point: pointPick.value || undefined }));
search.addEventListener('input', () => {
	if (searchTimer) {
		clearTimeout(searchTimer);
	}
	searchTimer = setTimeout(() => setFilter({ search: search.value.trim() || undefined }), 150);
});

function options(select: HTMLSelectElement, all: string, values: readonly { readonly value: string; readonly label: string }[], current: string | undefined): void {
	select.replaceChildren(...[{ value: '', label: all }, ...values].map(option => {
		const node = el('option', undefined, option.label);
		node.value = option.value;
		node.selected = option.value === (current ?? '');
		return node;
	}));
}

function row(item: EvidenceRow): HTMLElement {
	const tr = el('tr', `evidence-row ${item.kind}`);
	tr.id = `${item.point}-${item.event}`;
	const where = button('link evidence-where', item.where, () => post({ type: 'open', point: item.point }));
	const values = el('td', 'evidence-values');
	if (item.kind === 'snapshot') {
		const details = el('details');
		details.append(el('summary', undefined, `${strings.snapshot}: ${item.text.split('\n')[0]}`), el('pre', undefined, item.text));
		values.append(details);
	} else {
		values.append(el('code', undefined, item.text));
	}
	const point = el('td', 'evidence-point', `${item.point}#${item.event}`);
	const cell = el('td');
	cell.append(where);
	tr.append(el('td', 'evidence-time', item.time), point, cell, values);
	return tr;
}

function render(view: EvidenceView): void {
	heading.textContent = view.title;
	note.textContent = view.ended ? strings.ended : '';
	note.hidden = !view.ended;
	options(runPick, strings.allRuns, view.runs.map(run => ({ value: String(run.id), label: `${strings.run} ${run.id}${run.label && run.label !== `Run ${run.id}` ? ` - ${run.label}` : ''}` })), filter.run === undefined ? undefined : String(filter.run));
	options(hypothesisPick, strings.allHypotheses, view.hypotheses.map(id => ({ value: id, label: id })), filter.hypothesis);
	options(pointPick, strings.allPoints, view.points.map(point => ({ value: point.id, label: `${point.id} ${point.where}` })), filter.point);
	menus.forEach(menu => menu.sync());
	compare.replaceChildren();
	if (view.comparison?.length) {
		const rows = el('table', 'evidence-compare-table');
		const head = el('tr');
		head.append(el('th', undefined, strings.point), el('th', undefined, strings.where), el('th', undefined, strings.before), el('th', undefined, strings.after));
		rows.append(head);
		for (const item of view.comparison) {
			const tr = el('tr', item.changed ? 'changed' : 'same');
			tr.append(el('td', undefined, item.point), el('td', undefined, item.where), el('td', undefined, item.before), el('td', undefined, item.after));
			rows.append(tr);
		}
		compare.append(el('h2', undefined, strings.compare), rows);
	}
	const head = el('tr');
	head.append(el('th', undefined, strings.time), el('th', undefined, strings.point), el('th', undefined, strings.where), el('th', undefined, strings.values));
	table.replaceChildren(head, ...view.rows.map(row));
	footer.replaceChildren(el('span', 'evidence-totals', view.totals));
	if (!view.rows.length) {
		footer.prepend(el('p', 'evidence-empty', strings.empty));
	}
	if (view.more) {
		footer.append(button('secondary', strings.more, () => {
			filter = { ...filter, limit: filter.limit + pageRows };
			post({ type: 'filter', filter });
		}));
	}
	if (view.focus) {
		const target = document.getElementById(view.focus.replace('#', '-'));
		target?.scrollIntoView({ block: 'center' });
		target?.classList.add('focused');
	}
}

start(message => {
	if (message.type === 'view') {
		render(message.view);
	}
});
