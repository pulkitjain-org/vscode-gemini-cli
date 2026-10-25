/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Fork dialog (Fork Agent): what the fork starts with, where it works,
// its name, model and first message. Built when opened, from what the
// extension worked out (`src/host/chat/chatFork.ts`); it looks like the New
// thread dialog and shares its styles.

import { branchNameFrom } from '../src/acp/branchNames';
import type { ForkContext } from '../src/acp/chatTranscript';
import type { ForkView } from '../src/host/chatProtocol';
import { format, formatTokens } from './chatLogic';
import { el, icon, setLabel } from './dom';
import { selectMenu } from './selectMenu';
import { state, strings, vscode } from './view';

/** Above this many tokens a whole session carries a warning: every turn of the fork sends all of it. */
const largeSession = 200_000;

/** Opens the Fork dialog; the fork starts when the user picks Fork. */
export function openForkDialog(view: ForkView): void {
	const text = strings.fork;
	if (!text || document.querySelector('.new-thread')) {
		return;
	}
	const dialog = el('dialog', 'new-thread fork-dialog');
	dialog.setAttribute('aria-labelledby', 'fork-heading');
	const form = el('form');
	form.method = 'dialog';

	const head = el('div', 'new-thread-head');
	const heading = el('h2', undefined, format(text.title, view.parentTitle));
	heading.id = 'fork-heading';
	const close = el('button', 'icon-button');
	close.type = 'button';
	close.append(icon('close'));
	setLabel(close, text.close);
	close.addEventListener('click', () => dialog.close());
	head.append(heading, close);
	form.append(head);
	if (view.fromHere) {
		form.append(el('p', 'new-thread-hint', format(text.fromHereNote, firstLine(view.fromHere.answered))));
	}

	const title = input('fork-title', 'input');
	title.required = true;
	title.value = view.title;
	form.append(field(text.name, title));

	// What it starts with: the cheaper choices are for large sessions.
	const contexts = el('fieldset', 'fork-choices');
	contexts.append(el('legend', undefined, text.context));
	const choices: readonly { readonly id: ForkContext; readonly name: string; readonly hint: string; readonly tokens?: number; readonly why?: string }[] = [
		{ id: 'whole', name: text.whole, hint: view.tokens.whole > largeSession ? `${text.wholeHint} ${text.wholeLarge}` : text.wholeHint, tokens: view.tokens.whole },
		{ id: 'compact', name: text.compact, hint: text.compactHint, tokens: view.tokens.compact, why: view.compactWhy },
		{ id: 'conversation', name: text.conversation, hint: text.conversationHint, tokens: view.tokens.conversation },
	];
	const contextRadios = choices.map(choice => {
		const radio = choiceRow(contexts, 'fork-context', choice.id, choice.name, choice.tokens === undefined ? choice.why ?? '' : choice.hint, choice.tokens === undefined ? undefined : format(text.tokens, formatTokens(choice.tokens)));
		radio.disabled = choice.tokens === undefined;
		radio.checked = choice.id === view.context && !radio.disabled;
		return radio;
	});
	form.append(contexts);

	// Where it works: a branch of its own off the parent's, or the parent's folder.
	const places = el('fieldset', 'fork-choices');
	places.append(el('legend', undefined, text.where));
	const branch = input('fork-branch', 'input');
	branch.value = view.branch;
	branch.spellcheck = false;
	// Named after the fork until the user types a branch of their own, as in the New thread dialog.
	let branchEdited = !view.branchFollowsName;
	title.addEventListener('input', () => {
		if (!branchEdited && title.value.trim()) {
			branch.value = branchNameFrom(title.value);
		}
	});
	branch.addEventListener('input', () => branchEdited = !!branch.value.trim());
	let ownBranch: HTMLInputElement | undefined;
	if (view.git) {
		ownBranch = choiceRow(places, 'fork-place', 'branch', view.parentBranch ? format(text.ownBranch, view.parentBranch) : text.ownBranchPlain, text.ownBranchHint);
		ownBranch.checked = true;
		const branchField = field(text.branch, branch, 'fork-branch-field');
		places.append(branchField);
		if (view.branchOnly) {
			// A thread's fork is a new thread of the project: two threads in one folder would change the same files.
			places.append(el('p', 'new-thread-hint', text.threadHint));
		} else {
			const same = choiceRow(places, 'fork-place', 'same', text.sameFolder, text.sameFolderHint);
			const update = () => branch.disabled = !ownBranch!.checked;
			ownBranch.addEventListener('change', update);
			same.addEventListener('change', update);
		}
	} else {
		places.append(el('p', 'new-thread-hint', text.noGit));
	}
	form.append(places);

	const model = input('fork-model', 'select');
	model.append(new Option(text.sameModel, ''));
	for (const choice of state.settings.model?.available ?? []) {
		model.append(new Option(choice.name, choice.id));
	}
	const modelMenu = selectMenu(model, text.model);
	form.append(field(text.model, modelMenu.element, 'new-thread-model-field', 'fork-model'));

	const message = input('fork-message', 'textarea');
	message.rows = 3;
	message.placeholder = text.messagePlaceholder;
	form.append(field(text.message, message));

	const foot = el('div', 'permission-actions new-thread-foot');
	const cancel = el('button', 'secondary', text.cancel);
	cancel.type = 'button';
	cancel.addEventListener('click', () => dialog.close());
	const start = el('button', 'primary', text.start);
	start.type = 'submit';
	foot.append(cancel, start);
	form.append(foot);

	form.addEventListener('submit', event => {
		event.preventDefault();
		const context = contextRadios.find(radio => radio.checked)?.value as ForkContext | undefined;
		if (!title.value.trim() || !context) {
			return;
		}
		const own = !!ownBranch?.checked;
		vscode.postMessage({
			type: 'fork',
			fork: {
				title: title.value.trim(),
				context,
				ownBranch: own,
				...(own && branch.value.trim() ? { branch: branch.value.trim() } : {}),
				...(model.value ? { model: model.value } : {}),
				...(message.value.trim() ? { message: message.value.trim() } : {}),
				...(view.fromHere?.before ? { before: view.fromHere.before } : {}),
			},
		});
		dialog.close();
	});
	// Enter in the message starts a new line; Cmd/Ctrl+Enter forks from anywhere.
	form.addEventListener('keydown', event => {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			form.requestSubmit();
		}
	});
	dialog.addEventListener('close', () => {
		modelMenu.dispose();
		dialog.remove();
	});
	dialog.append(form);
	document.body.append(dialog);
	dialog.showModal();
	title.select();
}

/** A radio button with its name, a hint under it, and a figure at the end; returns the radio. */
function choiceRow(parent: HTMLElement, name: string, value: string, label: string, hint: string, end?: string): HTMLInputElement {
	const radio = el('input');
	radio.type = 'radio';
	radio.name = name;
	radio.value = value;
	radio.id = `${name}-${value}`;
	const row = el('label', 'fork-choice');
	row.htmlFor = radio.id;
	const words = el('span', 'fork-choice-text');
	words.append(el('strong', undefined, label), el('span', 'new-thread-hint', hint));
	row.append(radio, words);
	if (end) {
		row.append(el('span', 'fork-choice-end', end));
	}
	parent.append(row);
	return radio;
}

function input<K extends 'input' | 'textarea' | 'select'>(id: string, tag: K): HTMLElementTagNameMap[K] {
	const node = el(tag, 'new-thread-input');
	node.id = id;
	return node;
}

function field(label: string, control: HTMLElement, className = '', forId = control.id): HTMLElement {
	const wrap = el('div', `new-thread-field ${className}`.trim());
	const name = el('label', undefined, label);
	name.htmlFor = forId;
	wrap.append(name, control);
	return wrap;
}

/** A prompt's first line, short enough for one line of the dialog. */
function firstLine(text: string): string {
	const line = text.split('\n').map(part => part.trim()).find(Boolean) ?? '';
	return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}
