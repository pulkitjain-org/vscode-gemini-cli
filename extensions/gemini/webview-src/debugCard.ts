/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Debug mode's bar and cards in the chat (DEBUG_MODE.md, Visual design),
// loaded the first time a chat enters Debug mode (media/debugCard.js): most
// chats never do. The bar sits under the queue strip, above the composer:
// the phase line, the counts, Evidence and Stop, and, unfolded, the points
// and the bar's other actions. The reproduce, verify, rounds and clean-up
// cards draw under it. Every word comes from the host with the view; the
// live count reaches screen readers at most every five seconds.

import type { FromWebview } from '../src/host/chatProtocol';
import type { DebugAction, DebugBarView, DebugCardView, DebugPointView } from '../src/host/debug/debugProtocol';
import { button, el, icon } from './panelDom';

export interface DebugCardDeps {
	/** The element the bar goes after: the queue strip. */
	readonly anchor: HTMLElement;
	/** The bar's stylesheet, linked the first time. */
	readonly style?: string;
	post(message: FromWebview): void;
	setTip(node: HTMLElement, tip: string): void;
	/** The chat's polite live region. */
	announce(text: string): void;
}

/** How often the live count is read out, at most. */
const announceMs = 5000;

let bar: HTMLElement | undefined;
let lastAnnounced = 0;

function kindIcon(kind: DebugPointView['kind']): string {
	return kind === 'logpoint' ? 'debug-breakpoint-log' : kind === 'breakpoint' ? 'debug-breakpoint' : 'bracket';
}

/** Draws `view` in place of the bar, or takes the bar away. */
export function renderDebug(view: DebugBarView | undefined, d: DebugCardDeps, now: number = Date.now()): HTMLElement | undefined {
	if (!view) {
		bar?.remove();
		bar = undefined;
		return undefined;
	}
	if (d.style && !document.querySelector('link[data-debug-style]')) {
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = d.style;
		link.dataset.debugStyle = '';
		document.head.append(link);
	}
	if (!bar || !bar.isConnected) {
		bar = el('section', 'debug-bar');
		d.anchor.after(bar);
	}
	const s = view.strings;
	const send = (action: DebugAction, arg?: string) => d.post({ type: 'debugAction', action, ...arg ? { arg } : {} });
	const act = (label: string, action: DebugAction, iconName?: string, tip?: string, arg?: string, className = 'secondary') => {
		const node = button(`debug-button ${className}`, label, () => send(action, arg), iconName);
		if (tip) {
			d.setTip(node, tip);
		}
		return node;
	};
	bar.setAttribute('aria-label', s.debug);
	const parts: HTMLElement[] = [];
	if (!view.ended) {
		const head = el('div', 'debug-head');
		const title = el('span', 'debug-title');
		title.append(icon('bug'), el('span', undefined, s.debug));
		const phases = el('ol', 'debug-phases');
		phases.setAttribute('aria-label', s.phases);
		for (const phase of view.phases) {
			const item = el('li', `debug-phase ${phase.state}`);
			if (phase.state === 'done') {
				item.append(icon('check'));
			}
			item.append(el('span', undefined, phase.label));
			if (phase.state === 'current') {
				item.setAttribute('aria-current', 'step');
			}
			phases.append(item);
		}
		head.append(title, phases);
		const line = el('div', 'debug-line');
		const summary = button('debug-summary', view.summary, () => send('evidence'));
		d.setTip(summary, s.evidenceTip);
		line.append(summary, el('span', 'debug-spacer'),
			act(view.folded ? s.showPoints : s.hidePoints, 'fold', view.folded ? 'chevron-down' : 'chevron-up'),
			act(s.evidence, 'evidence', 'output', s.evidenceTip),
			act(s.stop, 'stop', 'debug-stop', s.stopTip));
		parts.push(head, line);
		if (!view.folded) {
			parts.push(unfolded(view, act, send, d));
		}
		if (now - lastAnnounced >= announceMs) {
			d.announce(view.summary);
			lastAnnounced = now;
		}
	}
	if (view.card) {
		parts.push(card(view.card, view, act));
	}
	bar.replaceChildren(...parts);
	return bar;
}

function unfolded(view: DebugBarView, act: (label: string, action: DebugAction, iconName?: string, tip?: string, arg?: string, className?: string) => HTMLButtonElement, send: (action: DebugAction, arg?: string) => void, d: DebugCardDeps): HTMLElement {
	const s = view.strings;
	const body = el('div', 'debug-body');
	body.append(el('div', 'debug-heading', s.points));
	const list = el('ul', 'debug-points');
	for (const point of view.points) {
		const row = el('li', 'debug-point');
		const where = button('debug-where', point.where, () => send('openPoint', point.id), kindIcon(point.kind));
		d.setTip(where, point.kindLabel);
		row.append(el('span', 'debug-id', point.id), where, el('span', 'debug-hypothesis', point.hypothesis), el('span', 'debug-kind', point.kindLabel), el('span', 'debug-hits', point.hits),
			act(s.remove, 'removePoint', undefined, s.removeTip, point.id, 'link'));
		list.append(row);
	}
	body.append(view.points.length ? list : el('p', 'debug-empty', s.noPoints));
	if (view.logFile) {
		const log = el('div', 'debug-log');
		log.append(icon('file'), el('span', undefined, `${s.logFile}: ${view.logFile}`), act(s.stopLog, 'stopLog', undefined, undefined, undefined, 'link'));
		body.append(log);
	}
	const actions = el('div', 'debug-actions');
	actions.append(act(s.skipToFix, 'skipToFix'), act(s.backToInvestigate, 'backToInvestigate'));
	if (view.launched) {
		actions.append(act(s.restartProgram, 'restartProgram', 'debug-restart'), act(s.stopProgram, 'stopProgram', 'debug-stop'));
	}
	if (view.points.length) {
		actions.append(act(s.removeAllPoints, 'removeAllPoints', 'trash'));
	}
	body.append(actions);
	return body;
}

function card(view: DebugCardView, bar: DebugBarView, act: (label: string, action: DebugAction, iconName?: string, tip?: string, arg?: string, className?: string) => HTMLButtonElement): HTMLElement {
	const s = bar.strings;
	const node = el('div', `debug-card ${view.kind}`);
	node.append(el('div', 'debug-card-title', view.title));
	const buttons = el('div', 'debug-actions');
	switch (view.kind) {
		case 'reproduce': {
			const steps = el('ol', 'debug-steps');
			view.steps.forEach(step => steps.append(el('li', undefined, step)));
			node.append(steps, el('div', 'debug-status', view.status));
			if (view.hint) {
				const hint = el('div', 'debug-hint');
				hint.append(icon('info'), el('span', undefined, view.hint));
				if (view.canRestart) {
					hint.append(act(s.restartProgram, 'restartProgram', 'debug-restart'));
				}
				node.append(hint);
			}
			buttons.append(act(s.reproduced, 'reproduced', undefined, undefined, undefined, 'primary'), act(s.didntHappen, 'didntHappen'), act(s.stop, 'stop'));
			break;
		}
		case 'verify': {
			const table = el('table', 'debug-compare');
			const head = el('tr');
			head.append(el('th', undefined, ''), el('th', undefined, ''), el('th', undefined, s.before), el('th', undefined, s.after));
			table.append(head);
			for (const row of view.rows) {
				const tr = el('tr', row.changed ? 'changed' : 'same');
				tr.append(el('td', 'debug-id', row.point), el('td', undefined, row.where), el('td', undefined, row.before), el('td', undefined, row.changed ? row.after : `${row.after} (${s.same})`));
				table.append(tr);
			}
			node.append(table);
			if (view.note) {
				node.append(el('div', 'debug-status', view.note));
			}
			buttons.append(act(s.fixed, 'fixed', undefined, undefined, undefined, 'primary'), act(s.stillBroken, 'stillBroken'));
			if (view.offerTest) {
				buttons.append(act(s.regressionTest, 'regressionTest'));
			}
			break;
		}
		case 'rounds':
			node.append(el('p', 'debug-status', view.text));
			buttons.append(act(s.keepGoing, 'keepGoing', undefined, undefined, undefined, 'primary'), act(s.hint, 'hint'), act(s.stop, 'stop'));
			break;
		case 'cleanup':
			view.lines.forEach(line => node.append(el('div', 'debug-status', line)));
			for (const left of view.left) {
				const row = el('div', 'debug-left');
				row.append(el('span', undefined, left.text), act(s.showDiff, 'showDiff', undefined, undefined, left.id, 'link'), act(s.removeAnyway, 'removeAnyway', undefined, undefined, left.id, 'link'), act(s.keep, 'keepRegion', undefined, undefined, left.id, 'link'));
				node.append(row);
				if (left.diff) {
					node.append(el('pre', 'debug-diff', left.diff));
				}
			}
			buttons.append(act(s.dismiss, 'dismiss'));
			break;
	}
	node.append(buttons);
	return node;
}
