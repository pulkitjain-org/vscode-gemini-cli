/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Audit log page (src/host/auditPage.ts): a day's writes to Jira and
// GitLab as a table, with the intents that never got a result marked, filters
// by day and tool, and Export and Open Folder.

import type { AuditPageView, AuditRowView, AuditStrings, FromAudit, ToAudit } from '../src/host/auditProtocol';
import { button, el, format, pageStrings } from './panelDom';
import { toolLogo } from './toolLogos';

declare function acquireVsCodeApi(): { postMessage(message: FromAudit): void };

const vscode = acquireVsCodeApi();
const strings = pageStrings<AuditStrings>();
const page = document.getElementById('page')!;

let view: AuditPageView | undefined;
/** The tool filter: all, or one tool. */
let tool: 'all' | 'jira' | 'gitlab' = 'all';
let onlyOpen = false;

function post(message: FromAudit): void {
	vscode.postMessage(message);
}

function render(): void {
	if (!view) {
		return;
	}
	page.replaceChildren();
	const header = el('header', 'settings-header');
	const intro = el('div');
	const hint = el('p', 'hint');
	const [before, after] = strings.subtitle.split('{0}');
	hint.append(before ?? '', el('code', 'mono', view.folder), after ?? '');
	intro.append(el('h1', undefined, strings.title), hint);
	header.append(intro);
	page.append(header);

	// Day, tool, and only the open intents; Export and Open Folder at the end.
	const filters = el('div', 'audit-filters');
	const dayLabel = el('label', 'audit-filter');
	const day = el('select', 'audit-select');
	for (const d of view.days) {
		const option = el('option', undefined, d);
		option.value = d;
		option.selected = d === view.day;
		day.append(option);
	}
	day.addEventListener('change', () => post({ type: 'day', day: day.value }));
	dayLabel.append(el('span', 'muted', strings.day), day);
	const toolLabel = el('label', 'audit-filter');
	const tools = el('select', 'audit-select');
	for (const [value, label] of [['all', strings.all], ['jira', 'Jira'], ['gitlab', 'GitLab']] as const) {
		const option = el('option', undefined, label);
		option.value = value;
		option.selected = value === tool;
		tools.append(option);
	}
	tools.addEventListener('change', () => {
		tool = tools.value as typeof tool;
		render();
	});
	toolLabel.append(el('span', 'muted', strings.tool), tools);
	const openLabel = el('label', 'audit-filter');
	const openBox = el('input');
	openBox.type = 'checkbox';
	openBox.checked = onlyOpen;
	openBox.addEventListener('change', () => {
		onlyOpen = openBox.checked;
		render();
	});
	openLabel.append(openBox, el('span', undefined, strings.onlyOpen));
	const actions = el('div', 'row-actions');
	actions.append(button('', strings.exportDay, () => post({ type: 'export', day: view!.day }), 'export'), button('', strings.openFolder, () => post({ type: 'openFolder' }), 'folder-opened'));
	filters.append(dayLabel, toolLabel, openLabel, el('span', 'spacer'), ...view.unfinished ? [el('span', 'tag warn', format(strings.unfinished, view.unfinished))] : [], actions);
	page.append(filters);

	const rows = view.rows.filter(row => (tool === 'all' || row.toolKind === tool) && (!onlyOpen || row.state === 'open'));
	const card = el('section', 'rows audit-card');
	if (!rows.length) {
		card.append(el('p', 'empty', strings.nothing));
	} else {
		const table = el('table', 'audit-table');
		const head = el('thead');
		const headRow = el('tr');
		for (const column of [strings.columns.time, strings.columns.caller, strings.columns.action, strings.columns.effect, strings.columns.answered, strings.columns.remote, strings.columns.state]) {
			headRow.append(el('th', undefined, column));
		}
		head.append(headRow);
		const body = el('tbody');
		for (const row of rows) {
			body.append(auditRow(row));
		}
		table.append(head, body);
		card.append(table);
	}
	page.append(card);
}

function auditRow(row: AuditRowView): HTMLElement {
	const tr = el('tr', row.state === 'open' ? 'open' : undefined);
	tr.append(el('td', 'mono', row.time), el('td', undefined, row.caller));
	const action = el('td', 'mono');
	if (row.toolKind !== 'other') {
		action.append(toolLogo(row.toolKind, 13));
	}
	action.append(el('span', undefined, row.tool));
	const remote = el('td', `mono${row.state === 'open' ? ' warn' : ''}`, row.state === 'open' ? strings.noResult : row.error ?? row.remote ?? '');
	const state = el('td');
	state.append(el('span', `tag ${row.state === 'done' ? 'ok' : row.state === 'failed' ? 'error' : 'warn'}`, row.state === 'done' ? strings.done : row.state === 'failed' ? strings.failed : strings.open));
	if (row.state === 'open') {
		state.append(button('small', strings.markChecked, () => post({ type: 'settle', id: row.id })));
	}
	tr.append(action, el('td', undefined, row.effect), el('td', undefined, row.answered), remote, state);
	return tr;
}

window.addEventListener('message', (event: MessageEvent<ToAudit>) => {
	if (event.data.type === 'view') {
		view = event.data.view;
		render();
	}
});

post({ type: 'ready' });
