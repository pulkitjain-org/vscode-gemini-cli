/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The usage popover, from Show Usage and Quota in the chat's title bar: the tokens this
// chat used per model, from its turn ends, and today's quota per model, which
// the extension reads when the popover opens.

import type { ViewQuota } from '../src/host/chatProtocol';
import { chatUsage } from '../src/acp/turnUsage';
import { format, formatTokens, resetsIn } from './chatLogic';
import { button, el, setLabel } from './dom';
import { closePicker } from './picker';
import { state, strings, ui, vscode } from './view';

const { usagePopover: popover } = ui;
let quota: ViewQuota = { kind: 'checking' };

popover.setAttribute('aria-label', strings.usage);
// Focus stays on the popover itself, which survives re-rendering its contents.
popover.tabIndex = -1;

/** Opens the popover, or closes it if open. */
export function toggleUsage(): void {
	if (!popover.hidden) {
		closeUsage();
		return;
	}
	closePicker();
	quota = { kind: 'checking' };
	popover.hidden = false;
	renderUsage();
	popover.focus();
	vscode.postMessage({ type: 'readQuota' });
}

function closeUsage(): void {
	if (popover.hidden) {
		return;
	}
	popover.hidden = true;
	ui.input.focus();
}

/** Today's quota from the extension; shown if the popover is still open. */
export function showQuota(value: ViewQuota): void {
	quota = value;
	if (!popover.hidden) {
		renderUsage();
	}
}

/** The transcript changed: a turn that ends adds its tokens. */
export function updateUsage(): void {
	if (!popover.hidden) {
		renderUsage();
	}
}

document.addEventListener('keydown', event => {
	if (event.key === 'Escape' && !popover.hidden) {
		event.preventDefault();
		event.stopPropagation();
		closeUsage();
	}
}, true);

document.addEventListener('mousedown', event => {
	const target = event.target as Node | null;
	if (!popover.hidden && target && !popover.contains(target)) {
		closeUsage();
	}
});

function renderUsage(): void {
	const head = el('div', 'usage-head');
	head.append(el('span', 'usage-title', strings.usage));
	const close = button('icon-button usage-close', '', closeUsage, 'close');
	setLabel(close, strings.close);
	head.append(close);
	popover.replaceChildren(head, renderChat(), renderQuota());
}

function renderChat(): HTMLElement {
	const section = el('section', 'usage-section');
	const usage = chatUsage(state.items);
	const heading = el('div', 'usage-heading');
	heading.append(el('span', undefined, strings.usageThisChat));
	if (usage.turns) {
		heading.append(el('span', 'usage-sub', usage.turns === 1 ? strings.usageOneTurn : format(strings.usageTurns, usage.turns)));
	}
	section.append(heading);
	if (!usage.turns) {
		section.append(el('p', 'usage-note', strings.usageNoTurns));
		return section;
	}
	if (!usage.models.length) {
		section.append(el('p', 'usage-note', strings.usageNoCounts));
		return section;
	}
	const table = el('table', 'usage-table');
	const header = el('tr');
	header.append(el('th', undefined, strings.usageModel), el('th', 'num', strings.usageInput), el('th', 'num', strings.usageOutput));
	table.append(header);
	const rows = usage.models.length > 1 ? [...usage.models, { model: '', input: usage.input, output: usage.output }] : usage.models;
	for (const { model, input, output } of rows) {
		const row = el('tr', model ? undefined : 'usage-total');
		row.append(el('td', 'usage-model', model || strings.usageTotal), tokensCell(input), tokensCell(output));
		table.append(row);
	}
	section.append(table);
	const notes = [strings.usageInputNote];
	if (usage.countedTurns < usage.turns) {
		notes.unshift(strings.usageSomeCounted.replace('{0}', String(usage.countedTurns)).replace('{1}', String(usage.turns)));
	}
	section.append(el('p', 'usage-note', notes.join(' ')));
	return section;
}

function tokensCell(count: number): HTMLElement {
	const cell = el('td', 'num', formatTokens(count));
	cell.title = count.toLocaleString();
	return cell;
}

function renderQuota(): HTMLElement {
	const section = el('section', 'usage-section');
	const heading = el('div', 'usage-heading');
	heading.append(el('span', undefined, strings.usageQuota));
	section.append(heading);
	switch (quota.kind) {
		case 'checking':
			section.append(el('p', 'usage-note', strings.usageChecking));
			return section;
		case 'off':
			section.append(el('p', 'usage-note', strings.usageQuotaOff));
			return section;
		case 'none':
			section.append(el('p', 'usage-note', strings.usageQuotaNone));
			return section;
		case 'failed':
			section.append(el('p', 'usage-note', strings.usageQuotaFailed));
			return section;
	}
	const now = Date.now();
	const list = el('div', 'usage-quota');
	for (const model of quota.quota) {
		const percent = Math.round(model.used * 100);
		const row = el('div', `usage-quota-row${model.used >= 0.95 ? ' full' : model.used >= 0.8 ? ' high' : ''}`);
		const bar = el('div', 'usage-bar');
		bar.setAttribute('role', 'meter');
		bar.setAttribute('aria-valuemin', '0');
		bar.setAttribute('aria-valuemax', '100');
		bar.setAttribute('aria-valuenow', String(percent));
		bar.setAttribute('aria-label', model.model);
		const fill = el('div', 'usage-fill');
		fill.style.width = `${Math.max(percent ? 2 : 0, percent)}%`;
		bar.append(fill);
		const reset = resetsIn(model.resetTime, now);
		const detail = [format(strings.usageUsed, percent)];
		if (reset) {
			detail.push(format(reset.unit === 'hours' ? strings.usageResetsHours : strings.usageResetsMinutes, reset.value));
		}
		row.append(el('span', 'usage-model', model.model), el('span', 'usage-detail', detail.join(' \u00b7 ')), bar);
		list.append(row);
	}
	section.append(list);
	const minutes = Math.floor((now - quota.at) / 60_000);
	section.append(el('p', 'usage-note', quota.checking ? strings.usageChecking : minutes < 1 ? strings.usageCheckedJustNow : format(strings.usageCheckedMinutes, minutes)));
	return section;
}
