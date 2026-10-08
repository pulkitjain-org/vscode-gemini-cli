/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The context ring under the composer and the usage popover it opens: how
// full this chat's context window is, today's quota per model for the
// account, which the extension reads when the popover opens, and the tokens
// this chat used per model, from its turn ends.

import type { ViewContext, ViewQuota } from '../src/host/chatProtocol';
import { chatUsage } from '../src/acp/turnUsage';
import { format, formatTokens, resetsIn } from './chatLogic';
import { button, el, setLabel } from './dom';
import { closePicker } from './picker';
import { state, strings, ui, vscode } from './view';

const { usagePopover: popover, usageRing: ring } = ui;
let quota: ViewQuota = { kind: 'checking' };
let context: ViewContext | undefined;
/** Whether the popover lists every model's quota, and this chat's tokens per model. */
let allModels = false;
let details = false;
/** The quota rows shown before "All N models". */
const shownQuota = 4;
/** Where the CLI starts summarising older history, as a share of the window (its default `model.compressionThreshold`). */
const summariseAt = 0.5;

popover.setAttribute('aria-label', strings.usage);
// Focus stays on the popover itself, which survives re-rendering its contents.
popover.tabIndex = -1;

ring.addEventListener('click', () => toggleUsage());
updateRing();

/** How full the context window is, in whole percent; undefined until known. */
export function contextPercent(): number | undefined {
	return context ? Math.round(Math.min(1, context.used / context.limit) * 100) : undefined;
}

/** The context window's use from the extension: the ring shows it, and an open popover too. */
export function showContext(value: ViewContext | undefined): void {
	context = value;
	updateRing();
	if (!popover.hidden) {
		renderUsage();
	}
}

function updateRing(): void {
	const percent = contextPercent();
	const share = context ? context.used / context.limit : 0;
	ring.classList.toggle('high', share >= summariseAt && share < 0.9);
	ring.classList.toggle('full', share >= 0.9);
	ring.querySelector('.ring-fill')?.setAttribute('stroke-dasharray', `${percent ?? 0} 100`);
	ring.querySelector('span')!.textContent = percent === undefined ? '' : `${percent}%`;
	setLabel(ring, percent === undefined ? strings.usage : format(strings.usageRing, percent));
}

/** Opens the popover, or closes it if open. */
export function toggleUsage(): void {
	if (!popover.hidden) {
		closeUsage();
		return;
	}
	closePicker();
	quota = { kind: 'checking' };
	allModels = false;
	details = false;
	popover.hidden = false;
	ring.setAttribute('aria-expanded', 'true');
	ring.classList.add('active');
	renderUsage();
	popover.focus();
	vscode.postMessage({ type: 'readQuota' });
}

function closeUsage(): void {
	if (popover.hidden) {
		return;
	}
	popover.hidden = true;
	ring.setAttribute('aria-expanded', 'false');
	ring.classList.remove('active');
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
	if (!popover.hidden && target && !popover.contains(target) && !ring.contains(target)) {
		closeUsage();
	}
});

function renderUsage(): void {
	popover.replaceChildren(renderContext(), renderQuota(), renderChat());
}

/** A link-styled button that shows or hides more of the popover. */
function moreLink(label: string, expanded: boolean, toggle: () => void): HTMLElement {
	const link = button('usage-more', label, () => {
		toggle();
		renderUsage();
		popover.focus();
	}, expanded ? 'chevron-up' : 'chevron-right');
	link.setAttribute('aria-expanded', String(expanded));
	return link;
}

function renderContext(): HTMLElement {
	const section = el('section', 'usage-section');
	const heading = el('div', 'usage-heading');
	heading.append(el('span', undefined, strings.usageContext), el('span', 'usage-sub', strings.usageThisChatScope));
	section.append(heading);
	if (!context) {
		section.append(el('p', 'usage-note', strings.usageContextNone));
		return section;
	}
	const share = Math.min(1, context.used / context.limit);
	const row = el('div', `usage-context${share >= 0.9 ? ' full' : share >= summariseAt ? ' high' : ''}`);
	const big = ring.querySelector('svg')!.cloneNode(true) as SVGElement;
	big.classList.add('ring-large');
	const figures = el('div');
	const used = el('div', 'usage-context-used', formatTokens(context.used));
	used.title = context.used.toLocaleString();
	used.append(el('span', 'usage-context-of', ` ${format(strings.usageContextOf, formatTokens(context.limit))}`));
	figures.append(used, el('div', 'usage-note', format(strings.usageContextNote, Math.round(summariseAt * 100))));
	row.append(big, figures);
	section.append(row);
	return section;
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
	const summary = el('div', 'usage-summary');
	summary.append(figure(strings.usageInput, usage.input, strings.usageInputNote));
	if (context?.cached) {
		summary.append(figure(strings.usageCached, context.cached, strings.usageCachedNote));
	}
	summary.append(figure(strings.usageOutput, usage.output));
	section.append(summary);
	if (usage.countedTurns < usage.turns) {
		section.append(el('p', 'usage-note', strings.usageSomeCounted.replace('{0}', String(usage.countedTurns)).replace('{1}', String(usage.turns))));
	}
	section.append(moreLink(details ? strings.usageHideDetails : strings.usageDetails, details, () => details = !details));
	if (!details) {
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
	section.append(table, el('p', 'usage-note', strings.usageInputNote));
	return section;
}

/** "Input 295.8K", with the exact count and what it means on hover. */
function figure(label: string, count: number, note?: string): HTMLElement {
	const item = el('span', 'usage-figure');
	item.append(el('span', 'usage-figure-label', label), el('span', 'usage-figure-value', formatTokens(count)));
	item.title = note ? `${count.toLocaleString()}. ${note}` : count.toLocaleString();
	return item;
}

function tokensCell(count: number): HTMLElement {
	const cell = el('td', 'num', formatTokens(count));
	cell.title = count.toLocaleString();
	return cell;
}

function renderQuota(): HTMLElement {
	const section = el('section', 'usage-section');
	const heading = el('div', 'usage-heading');
	heading.append(el('span', undefined, strings.usageQuota), el('span', 'usage-sub', strings.usageAccount));
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
	const models = [...quota.quota].sort((a, b) => b.used - a.used);
	const shown = allModels || models.length <= shownQuota + 1 ? models : models.slice(0, shownQuota);
	for (const model of shown) {
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
	if (models.length > shownQuota + 1) {
		section.append(moreLink(allModels ? strings.usageFewerModels : format(strings.usageAllModels, models.length), allModels, () => allModels = !allModels));
	}
	const minutes = Math.floor((now - quota.at) / 60_000);
	section.append(el('p', 'usage-note', quota.checking ? strings.usageChecking : minutes < 1 ? strings.usageCheckedJustNow : format(strings.usageCheckedMinutes, minutes)));
	return section;
}
