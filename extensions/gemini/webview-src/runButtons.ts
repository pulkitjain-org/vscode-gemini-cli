/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run on a reply's shell blocks: Run (a play icon) runs the block in the agent's
// terminal, and the chevron beside it offers Insert Without Running, Run in New
// Terminal and each repository.
// The extension decides where it runs and whether to ask first (chatRun.ts);
// the block shows its question, then how the command ended. States are kept
// by the block's text, so a block drawn again keeps its result.

import type { RunAction, RunState, RunView } from '../src/host/chatProtocol';
import { format, formatDuration } from './chatLogic';
import { button, el, icon, setLabel, setTip } from './dom';
import { Menu } from './menu';
import { strings, vscode } from './view';

let view: RunView = { mode: 'off', places: [] };
const states = new Map<string, RunState>();
/** Each shell block's text and language. */
const blocks = new WeakMap<HTMLElement, { readonly text: string; readonly language: string }>();

/** Whether the chat's agent has a folder to open a terminal in. */
export function hasTerminal(): boolean {
	return view.places.length > 0;
}

/** Shell blocks show Run unless it is turned off or the chat has no terminal. */
export function setRunView(next: RunView): void {
	view = next;
	document.body.classList.toggle('can-run', next.mode !== 'off');
}

function send(text: string, language: string, action: RunAction, extra: { readonly place?: string; readonly confirmed?: boolean } = {}): void {
	vscode.postMessage({ type: 'runCommand', text, language, action, ...extra });
}

/**
 * Adds Run and its chevron menu to a shell block's header, before Copy. While the block
 * still streams (`ready` false) Run is off, so half a command never runs.
 */
export function addRunButtons(wrapper: HTMLElement, copy: HTMLElement, language: string, text: string, ready: boolean): void {
	const run = button('icon-button code-run', '', () => send(text, language, 'run'), 'play');
	const more = button('icon-button code-run code-more', '', () => toggleMenu(more, { text, language }), 'chevron-down');
	setLabel(run, ready ? strings.run.run : strings.run.streaming);
	setLabel(more, strings.run.more);
	more.setAttribute('aria-haspopup', 'menu');
	more.setAttribute('aria-expanded', 'false');
	run.disabled = more.disabled = !ready;
	copy.before(run, more);
	wrapper.classList.add('runnable');
	blocks.set(wrapper, { text, language });
	const state = states.get(text);
	if (state && ready) {
		show(wrapper, state, false);
	}
}

/** The chevrons' menu: one for every shell block, made on the first click. */
let menu: Menu | undefined;
/** The block the menu is open for, and its chevron. */
let menuBlock: { readonly text: string; readonly language: string; readonly anchor: HTMLElement } | undefined;

/** Opens the chevrons' menu for a block under its chevron `anchor`, or closes it if it is open there. */
function toggleMenu(anchor: HTMLElement, block: { readonly text: string; readonly language: string }): void {
	menu ??= createMenu();
	if (menu.isOpenFrom(anchor)) {
		menu.close();
		return;
	}
	menu.setAnchor(anchor);
	menuBlock = { ...block, anchor };
	menu.open();
}

function createMenu(): Menu {
	const element = el('div', 'run-menu');
	element.id = 'run-menu';
	element.hidden = true;
	document.body.append(element);
	const created: Menu = new Menu({
		element,
		// The chevrons open and close it (toggleMenu), each made its anchor in turn; this one is never shown.
		anchor: el('button'),
		label: strings.run.more,
		tip: setTip,
		onOpen: () => {
			const box = menuBlock!.anchor.getBoundingClientRect();
			element.style.top = `${box.bottom + 4}px`;
			element.style.right = `${Math.max(8, innerWidth - box.right)}px`;
		},
		sections: () => {
			const block = menuBlock!;
			const pick = (action: RunAction, place?: string) => () => {
				created.close();
				send(block.text, block.language, action, place === undefined ? {} : { place });
			};
			return [
				{ rows: [{ icon: 'insert', name: strings.run.insert, run: pick('insert') }, { icon: 'terminal', name: strings.run.newTerminal, run: pick('newTerminal') }] },
				...view.places.length > 1 ? [{ rows: view.places.map(place => ({ icon: 'repo', name: format(strings.run.runIn, place), run: pick('run', place) })) }] : [],
			];
		},
		empty: () => '',
	});
	return created;
}

/** A block's Run changed, as the extension tells it. */
export function setRunState(text: string, state: RunState): void {
	if (state.kind === 'idle') {
		states.delete(text);
	} else {
		states.set(text, state);
	}
	for (const wrapper of document.querySelectorAll<HTMLElement>('.code-block.runnable')) {
		if (blocks.get(wrapper)?.text === text) {
			show(wrapper, state, true);
		}
	}
}

/** Shows `state` in the block; a question takes the focus only as it is asked, not when the block is drawn again. */
function show(wrapper: HTMLElement, state: RunState, asked: boolean): void {
	const block = blocks.get(wrapper)!;
	wrapper.querySelector('.run-status')?.remove();
	wrapper.querySelector('.run-bar')?.remove();
	const header = wrapper.querySelector('.code-header')!;
	const runButton = header.querySelector('.code-run')!;
	if (state.kind === 'running' || state.kind === 'done') {
		const status = el('span', 'run-status');
		if (state.kind === 'running') {
			status.append(icon('loading', 'codicon-modifier-spin'));
			setTip(status, strings.run.running);
		} else if (state.exitCode === 0 || state.exitCode === undefined) {
			status.append(icon('check'));
			status.classList.add('passed');
			setTip(status, format(strings.run.passed, formatDuration(state.ms ?? 0)));
		} else {
			status.append(icon('error'), el('span', undefined, String(state.exitCode)));
			status.classList.add('failed');
			setTip(status, format(strings.run.failed, state.exitCode, formatDuration(state.ms ?? 0)));
			status.append(button('run-send', strings.run.sendOutput, () => vscode.postMessage({ type: 'sendRunOutput', text: block.text })));
		}
		runButton.before(status);
		return;
	}
	if (state.kind !== 'confirm' && state.kind !== 'pick') {
		return;
	}
	const bar = el('div', 'run-bar');
	const actions = el('div', 'permission-actions');
	const cancel = button('secondary', strings.run.cancel, () => setRunState(block.text, { kind: 'idle' }));
	if (state.kind === 'confirm') {
		bar.append(el('div', 'run-question', state.text));
		const place = state.place;
		actions.append(button('primary', strings.run.run, () => send(block.text, block.language, 'run', { confirmed: true, ...place === undefined ? {} : { place } })), cancel);
	} else {
		bar.append(el('div', 'run-question', strings.run.pick));
		const action = state.action;
		actions.append(...view.places.map(place => button('secondary', place, () => {
			// The question goes; the extension says what happens next (a question, Running, or nothing for Insert).
			setRunState(block.text, { kind: 'idle' });
			send(block.text, block.language, action, { place });
		})), cancel);
	}
	bar.append(actions);
	bar.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			event.stopPropagation();
			cancel.click();
		}
	});
	header.after(bar);
	if (asked) {
		actions.querySelector('button')?.focus();
	}
}
