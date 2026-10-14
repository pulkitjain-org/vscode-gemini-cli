/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A project chat's own parts (Projects preview): the New thread dialog and the
// side panel. Neither exists in other chats, and nothing here runs while
// typing or streaming: the dialog is built when opened, and the panel only
// when the extension sends it, after a burst of thread changes settles.

import { branchNameFrom } from '../src/acp/branchNames';
import type { ProjectPanel } from '../src/host/chatProtocol';
import { format } from './chatLogic';
import { el, icon, setLabel } from './dom';
import { state, strings, vscode } from './view';

let panel: ProjectPanel | undefined;

/** Opens the New thread dialog; the thread starts when the user picks Start thread. */
export function openNewThread(): void {
	const project = strings.project;
	if (!project || document.querySelector('.new-thread')) {
		return;
	}
	const text = project.dialog;
	const dialog = el('dialog', 'new-thread');
	dialog.setAttribute('aria-labelledby', 'new-thread-heading');
	const form = el('form');
	form.method = 'dialog';

	const head = el('div', 'new-thread-head');
	const heading = el('h2', undefined, panel?.name ? format(text.title, panel.name) : project.newThread);
	heading.id = 'new-thread-heading';
	const close = el('button', 'icon-button');
	close.type = 'button';
	close.append(icon('close'));
	setLabel(close, text.close);
	close.addEventListener('click', () => dialog.close());
	head.append(heading, close);

	const title = input('new-thread-title', 'input');
	title.required = true;
	const brief = input('new-thread-brief', 'textarea');
	brief.required = true;
	brief.rows = 5;
	brief.placeholder = text.briefPlaceholder;
	const branch = input('new-thread-branch', 'input');
	branch.placeholder = branchNameFrom('');
	branch.spellcheck = false;
	// The branch follows the title until the user types one of their own.
	let branchEdited = false;
	title.addEventListener('input', () => {
		if (!branchEdited) {
			branch.value = title.value.trim() ? branchNameFrom(title.value) : '';
		}
	});
	branch.addEventListener('input', () => branchEdited = !!branch.value.trim());
	const model = input('new-thread-model', 'select');
	model.append(new Option(text.defaultModel, ''));
	for (const choice of state.settings.model?.available ?? []) {
		model.append(new Option(choice.name, choice.id));
	}
	const plan = el('input');
	plan.id = 'new-thread-plan';
	plan.type = 'checkbox';

	const pair = el('div', 'new-thread-pair');
	pair.append(field(text.branchLabel, branch), field(text.modelLabel, model, 'new-thread-model-field'));
	const planRow = el('div', 'new-thread-plan');
	const planLabel = el('label');
	planLabel.htmlFor = plan.id;
	planLabel.append(el('strong', undefined, text.planFirst), el('span', 'new-thread-hint', text.planFirstHint));
	planRow.append(plan, planLabel);

	const foot = el('div', 'permission-actions new-thread-foot');
	const cancel = el('button', 'secondary', text.cancel);
	cancel.type = 'button';
	cancel.addEventListener('click', () => dialog.close());
	const start = el('button', 'primary', text.start);
	start.type = 'submit';
	foot.append(el('span', 'new-thread-hint', text.startsAtOnce), cancel, start);

	form.append(head, field(text.titleLabel, title), field(text.briefLabel, brief), pair, el('p', 'new-thread-hint', text.worktreeHint), planRow, foot);
	form.addEventListener('submit', event => {
		event.preventDefault();
		if (!title.value.trim() || !brief.value.trim()) {
			return;
		}
		vscode.postMessage({
			type: 'startThread',
			thread: {
				title: title.value.trim(),
				brief: brief.value.trim(),
				...(branch.value.trim() ? { branch: branch.value.trim() } : {}),
				...(model.value ? { model: model.value } : {}),
				planFirst: plan.checked,
			},
		});
		dialog.close();
	});
	// Enter in the brief starts a new line; Cmd/Ctrl+Enter starts the thread from anywhere.
	form.addEventListener('keydown', event => {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			form.requestSubmit();
		}
	});
	dialog.addEventListener('close', () => dialog.remove());
	dialog.append(form);
	document.body.append(dialog);
	dialog.showModal();
	title.focus();
}

function input<K extends 'input' | 'textarea' | 'select'>(id: string, tag: K): HTMLElementTagNameMap[K] {
	const node = el(tag, 'new-thread-input');
	node.id = id;
	return node;
}

function field(label: string, control: HTMLElement, className = ''): HTMLElement {
	const wrap = el('div', `new-thread-field ${className}`.trim());
	const name = el('label', undefined, label);
	name.htmlFor = control.id;
	wrap.append(name, control);
	return wrap;
}

/** Shows the side panel; the page makes room for it only when the view is wide enough. */
export function showProjectPanel(next: ProjectPanel): void {
	const text = strings.project?.panel;
	if (!text) {
		return;
	}
	panel = next;
	let aside = document.getElementById('project-panel');
	if (!aside) {
		aside = el('aside', 'project-panel');
		aside.id = 'project-panel';
		document.body.append(aside);
		document.body.classList.add('has-project-panel');
	}
	aside.setAttribute('aria-label', text.title);
	const counts = next.counts;
	const rows: [number, string, string][] = [
		[counts.working, 'working', text.working],
		[counts.waiting, 'waiting', text.waiting],
		[counts.planned, 'planned', text.planned],
		[counts.done, 'done', text.done],
		[counts.merged, 'merged', text.merged],
	];
	const threads = el('section', 'panel-section');
	threads.append(el('h3', undefined, text.title));
	const shown = rows.filter(([count]) => count > 0);
	if (!shown.length) {
		threads.append(el('p', 'panel-row panel-empty', text.noThreads));
	}
	for (const [count, kind, label] of shown) {
		const row = el('p', 'panel-row');
		row.append(el('span', `panel-dot state-${kind}`), el('span', undefined, format(label, String(count))));
		threads.append(row);
	}
	const context = el('section', 'panel-section');
	context.append(el('h3', undefined, text.context));
	context.append(el('p', 'panel-row', next.conductor ? format(text.conductorTracks, String(next.conductor.openTracks)) : text.noConductor));
	if (next.model) {
		const name = state.settings.model?.available.find(choice => choice.id === next.model)?.name ?? next.model;
		context.append(el('p', 'panel-row', format(text.model, name)));
	}
	aside.replaceChildren(threads, context);
}
