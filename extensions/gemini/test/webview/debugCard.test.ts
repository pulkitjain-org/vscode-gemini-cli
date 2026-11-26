/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// Debug mode's bar and cards (webview-src/debugCard.ts): the phase line with
// the current phase marked, folding, the cards' buttons and what they send,
// and the live count read out at most every five seconds.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HTMLElement } from 'happy-dom';
import type { FromWebview } from '../../src/host/chatProtocol';
import type { DebugBarStrings, DebugBarView } from '../../src/host/debug/debugProtocol';
import { page, startScript } from './pages';

const { document } = page;
type Deps = { readonly anchor: HTMLElement; post(message: FromWebview): void; setTip(): void; announce(text: string): void };
/** The bar's module, webview-src/debugCard.ts, as media/debugCard.js is built. */
let renderDebug: (view: DebugBarView | undefined, deps: Deps, now?: number) => HTMLElement | undefined;

beforeAll(async () => {
	renderDebug = (await startScript('debugCard')).renderDebug as typeof renderDebug;
});

const strings = new Proxy({}, { get: (_, key) => String(key) }) as DebugBarStrings;

function view(change: Partial<DebugBarView> = {}): DebugBarView {
	return {
		strings,
		phases: [{ label: 'Investigate', state: 'done' }, { label: 'Instrument', state: 'done' }, { label: 'Reproduce', state: 'current' }, { label: 'Fix', state: 'todo' }],
		summary: '2 hypotheses open - 2 points - 13 events',
		points: [
			{ id: 'p1', where: 'src/cart.js:30', hypothesis: 'h1', kind: 'logpoint', kindLabel: 'logpoint', hits: '12 hits' },
			{ id: 'p2', where: 'src/cart.js:38', hypothesis: 'h2', kind: 'breakpoint', kindLabel: 'breakpoint', hits: '1 hit' },
		],
		launched: true,
		folded: true,
		...change,
	};
}

let posted: FromWebview[];
let announced: string[];
let anchor: HTMLElement;

function deps(): Deps {
	return { anchor, post: (message: FromWebview) => posted.push(message), setTip: () => undefined, announce: (text: string) => announced.push(text) };
}

function labels(root: HTMLElement): string[] {
	return [...root.querySelectorAll('button')].map(node => node.textContent ?? '');
}

function click(root: HTMLElement, label: string): void {
	([...root.querySelectorAll('button')].find(node => node.textContent === label) as unknown as { click(): void }).click();
}

beforeEach(() => {
	document.body.replaceChildren();
	anchor = document.createElement('div') as unknown as HTMLElement;
	document.body.append(anchor as never);
	posted = [];
	announced = [];
	renderDebug(undefined, deps());
});

describe('the debug bar', () => {
	it('shows the phases with the current one marked, folds its points away, and sends what its buttons mean', () => {
		const bar = renderDebug(view(), deps(), 0)!;
		const phases = [...bar.querySelectorAll('.debug-phase')].map(node => `${node.textContent}${node.getAttribute('aria-current') ? ' (current)' : ''}`);
		const folded = labels(bar);
		click(bar, 'showPoints');
		click(bar, 'stop');
		const open = renderDebug(view({ folded: false }), deps(), 1)!;
		click(open, 'src/cart.js:38');
		([...open.querySelectorAll('.debug-point button')].filter(node => node.textContent === 'remove')[0] as unknown as { click(): void }).click();
		expect({ after: anchor.nextElementSibling === bar, phases, folded, open: labels(open), posted }).toEqual({
			after: true,
			phases: ['Investigate', 'Instrument', 'Reproduce (current)', 'Fix'],
			folded: ['2 hypotheses open - 2 points - 13 events', 'showPoints', 'evidence', 'stop'],
			open: ['2 hypotheses open - 2 points - 13 events', 'hidePoints', 'evidence', 'stop', 'src/cart.js:30', 'remove', 'src/cart.js:38', 'remove', 'skipToFix', 'backToInvestigate', 'restartProgram', 'stopProgram', 'removeAllPoints'],
			posted: [{ type: 'debugAction', action: 'fold' }, { type: 'debugAction', action: 'stop' }, { type: 'debugAction', action: 'openPoint', arg: 'p2' }, { type: 'debugAction', action: 'removePoint', arg: 'p1' }],
		});
	});

	it('reads the count out at most every five seconds', () => {
		renderDebug(view(), deps(), 10_000);
		renderDebug(view({ summary: 'later' }), deps(), 12_000);
		renderDebug(view({ summary: 'much later' }), deps(), 15_000);
		expect(announced).toEqual(['2 hypotheses open - 2 points - 13 events', 'much later']);
	});

	it('draws the reproduce card with its hint, the verify card\'s runs, and the clean-up card alone once ended', () => {
		const reproduce = renderDebug(view({ card: { kind: 'reproduce', title: 'Reproduce the bug', steps: ['Open the cart', 'Reload'], status: 'Waiting for evidence...', hint: 'No evidence yet.', canRestart: true } }), deps())!;
		const card = reproduce.querySelector('.debug-card') as HTMLElement;
		const steps = [...card.querySelectorAll('li')].map(node => node.textContent);
		const reproduceButtons = labels(card);
		click(card, 'reproduced');
		const verify = renderDebug(view({ card: { kind: 'verify', title: 'Before and after', rows: [{ point: 'p2', where: 'src/cart.js:38', before: '2 hits', after: '1 hit', changed: true }, { point: 'p1', where: 'src/cart.js:30', before: '1 hit', after: '1 hit', changed: false }], offerTest: true } }), deps())!;
		const cells = [...verify.querySelectorAll('.debug-compare tr')].slice(1).map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent).join(' | '));
		const ended = renderDebug(view({ ended: true, phases: [], points: [], card: { kind: 'cleanup', title: 'Debug mode ended', lines: ['Removed 1 logpoints, 1 breakpoints and 1 marked lines in 1 files.'], left: [{ id: 'p3', text: 'checkout.js:17 was edited after it was added.', diff: '- a\n+ b' }] } }), deps())!;
		click(ended, 'removeAnyway');
		expect({ steps, reproduceButtons, cells, ended: { phases: ended.querySelectorAll('.debug-phase').length, buttons: labels(ended), diff: ended.querySelector('.debug-diff')?.textContent }, last: posted.slice(-1) }).toEqual({
			steps: ['Open the cart', 'Reload'],
			reproduceButtons: ['restartProgram', 'reproduced', 'didntHappen', 'stop'],
			cells: ['p2 | src/cart.js:38 | 2 hits | 1 hit', 'p1 | src/cart.js:30 | 1 hit | 1 hit (same)'],
			ended: { phases: 0, buttons: ['showDiff', 'removeAnyway', 'keep', 'dismiss'], diff: '- a\n+ b' },
			last: [{ type: 'debugAction', action: 'removeAnyway', arg: 'p3' }],
		});
	});
});
