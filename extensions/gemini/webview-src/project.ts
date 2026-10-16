/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A project chat's own parts (Projects preview): the New thread dialog and the
// side panel. Neither exists in other chats, and nothing here runs while
// typing or streaming: the dialog is built when opened, and the panel only
// when the extension sends it, after a burst of thread changes settles.

import { branchNameFrom } from '../src/acp/branchNames';
import type { ParentProject, ProjectPanel } from '../src/host/chatProtocol';
import { format } from './chatLogic';
import { button, el, icon, onIntent, setLabel } from './dom';
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
	const prefix = panel?.defaults?.branchPrefix;
	const branchFrom = (value: string) => prefix !== undefined ? branchNameFrom(value, prefix) : branchNameFrom(value);
	branch.placeholder = branchFrom('');
	branch.spellcheck = false;
	// The branch follows the title until the user types one of their own.
	let branchEdited = false;
	title.addEventListener('input', () => {
		if (!branchEdited) {
			branch.value = title.value.trim() ? branchFrom(title.value) : '';
		}
	});
	branch.addEventListener('input', () => branchEdited = !!branch.value.trim());
	const model = input('new-thread-model', 'select');
	model.append(new Option(text.defaultModel, ''));
	for (const choice of state.settings.model?.available ?? []) {
		model.append(new Option(choice.name, choice.id));
	}
	// The project's defaults, from its settings.
	const threadModel = panel?.defaults?.threadModel;
	if (threadModel && [...model.options].some(option => option.value === threadModel)) {
		model.value = threadModel;
	}
	const plan = el('input');
	plan.id = 'new-thread-plan';
	plan.type = 'checkbox';
	plan.checked = !!panel?.defaults?.planFirst;

	// A project with several repositories: the ones the thread works in, all by default.
	const repoBoxes = (panel?.repos ?? []).map(key => {
		const box = el('input');
		box.type = 'checkbox';
		box.checked = true;
		box.value = key;
		box.id = `new-thread-repo-${key}`;
		return box;
	});
	const repos = el('fieldset', 'new-thread-repos');
	if (repoBoxes.length) {
		repos.append(el('legend', undefined, text.reposLabel));
		for (const box of repoBoxes) {
			const row = el('label', 'new-thread-repo');
			row.htmlFor = box.id;
			row.append(box, el('span', 'repo-pill', box.value));
			repos.append(row);
		}
		repos.append(el('p', 'new-thread-hint', text.reposHint));
	}

	const pair = el('div', 'new-thread-pair');
	pair.append(field(repoBoxes.length ? text.branchLabelShared : text.branchLabel, branch), field(text.modelLabel, model, 'new-thread-model-field'));
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

	form.append(head, field(text.titleLabel, title), field(text.briefLabel, brief), ...repoBoxes.length ? [repos] : [], pair, el('p', 'new-thread-hint', text.worktreeHint), planRow, foot);
	const chosen = () => repoBoxes.filter(box => box.checked).map(box => box.value);
	const updateStart = () => start.disabled = !!repoBoxes.length && !chosen().length;
	repoBoxes.forEach(box => box.addEventListener('change', updateStart));
	form.addEventListener('submit', event => {
		event.preventDefault();
		if (!title.value.trim() || !brief.value.trim() || (repoBoxes.length && !chosen().length)) {
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
				...(repoBoxes.length ? { repos: chosen() } : {}),
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
		document.body.append(aside, panelSash(text.title));
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
	const heading = el('div', 'panel-heading');
	const gear = button('icon-button', '', () => vscode.postMessage({ type: 'openProjectSettings' }), 'settings-gear');
	setLabel(gear, strings.project?.settings.open ?? '');
	heading.append(el('h3', undefined, text.title), gear);
	threads.append(heading);
	const shown = rows.filter(([count]) => count > 0);
	if (!shown.length) {
		threads.append(el('p', 'panel-row panel-empty', text.noThreads));
	}
	for (const [count, kind, label] of shown) {
		const row = el('p', 'panel-row');
		row.append(el('span', `panel-dot state-${kind}`), el('span', undefined, format(label, String(count))));
		threads.append(row);
	}
	// Each thread, to open its chat; its card in the chat may have scrolled far up.
	if (next.threads.length) {
		const list = el('div', 'panel-threads');
		for (const thread of next.threads) {
			const row = el('button', 'panel-thread');
			row.type = 'button';
			row.title = thread.title;
			row.append(el('span', `panel-dot state-${thread.state}`), el('span', 'panel-thread-title', thread.title));
			row.addEventListener('click', () => vscode.postMessage({ type: 'threadAction', thread: thread.id, action: 'open' }));
			onIntent(row, () => vscode.postMessage({ type: 'prepareThread', thread: thread.id }));
			list.append(row);
		}
		threads.append(list);
	}
	const context = el('section', 'panel-section');
	context.append(el('h3', undefined, text.context));
	context.append(el('p', 'panel-row', next.conductor ? format(text.conductorTracks, String(next.conductor.openTracks)) : text.noConductor));
	if (next.repos?.length) {
		context.append(el('p', 'panel-row', format(text.repos, next.repos.join(', '))));
	}
	if (next.model) {
		const name = state.settings.model?.available.find(choice => choice.id === next.model)?.name ?? next.model;
		context.append(el('p', 'panel-row', format(text.model, name)));
	}
	aside.replaceChildren(threads, context);
}

/** Panel widths the sash allows: the chat keeps at least 520 px. */
const minPanelWidth = 200;
const maxPanelWidth = 600;

/** The panel's left edge, dragged (or moved with the arrow keys) to resize it, as a VS Code sash is. */
function panelSash(label: string): HTMLElement {
	const sash = el('div', 'project-panel-sash');
	sash.setAttribute('role', 'separator');
	sash.setAttribute('aria-orientation', 'vertical');
	sash.setAttribute('aria-label', label);
	sash.tabIndex = 0;
	const width = () => document.getElementById('project-panel')?.getBoundingClientRect().width ?? 280;
	const resize = (next: number) => {
		const clamped = Math.round(Math.max(minPanelWidth, Math.min(next, maxPanelWidth, window.innerWidth - 520)));
		document.body.style.setProperty('--gemini-panel-width', `${clamped}px`);
		sash.setAttribute('aria-valuenow', String(clamped));
	};
	sash.addEventListener('pointerdown', event => {
		event.preventDefault();
		sash.setPointerCapture(event.pointerId);
		sash.classList.add('active');
		const startX = event.clientX;
		const startWidth = width();
		const move = (moved: PointerEvent) => resize(startWidth + startX - moved.clientX);
		const end = () => {
			sash.classList.remove('active');
			sash.removeEventListener('pointermove', move);
		};
		sash.addEventListener('pointermove', move);
		sash.addEventListener('pointerup', end, { once: true });
		sash.addEventListener('pointercancel', end, { once: true });
	});
	sash.addEventListener('keydown', event => {
		const step = event.shiftKey ? 40 : 10;
		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			resize(width() + (event.key === 'ArrowLeft' ? step : -step));
		}
	});
	// Double-click restores the default width, as a VS Code sash does.
	sash.addEventListener('dblclick', () => document.body.style.removeProperty('--gemini-panel-width'));
	return sash;
}

/** A project thread's bar at the top of its chat, leading back to the project chat. */
export function showParentProject(parent: ParentProject): void {
	let bar = document.getElementById('parent-project');
	if (!bar) {
		bar = el('nav', 'parent-project');
		bar.id = 'parent-project';
		document.body.prepend(bar);
		document.body.classList.add('has-parent-project');
	}
	const back = el('button', 'parent-project-link');
	back.type = 'button';
	back.append(icon('arrow-left'), el('span', undefined, parent.action));
	back.addEventListener('click', () => vscode.postMessage({ type: 'openParentProject' }));
	bar.setAttribute('aria-label', parent.label);
	const name = el('span', 'parent-project-name');
	name.append(icon('project'), el('span', undefined, parent.label));
	bar.replaceChildren(back, name);
}
