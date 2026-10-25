/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Project settings: a popup over the project chat with a
// General and a Memory tab, and Save and Cancel. Nothing is saved until Save;
// the extension's refreshes (a finished draft, an added file) keep the user's
// unsaved edits. Built when opened, so it costs nothing while chatting.

import type { ProjectRepoView, ProjectSettingsView } from '../src/host/chatProtocol';
import { format } from './chatLogic';
import { button, el, icon, setLabel } from './dom';
import { toneOf } from './repoTones';
import { selectMenu, type SelectMenu } from './selectMenu';
import { draftOf, mergeRefresh, saveOf, threadTokens, unsavedChanges, withRepo, type SettingsDraft } from './settingsLogic';
import { state, strings, vscode } from './view';

type Tab = 'general' | 'memory';

interface Open {
	readonly dialog: HTMLDialogElement;
	readonly body: HTMLElement;
	readonly heading: HTMLElement;
	readonly note: HTMLElement;
	readonly cancel: HTMLButtonElement;
	readonly tabs: Map<Tab, HTMLButtonElement>;
	view: ProjectSettingsView;
	draft: SettingsDraft;
	tab: Tab;
	/** The Memory tab was shown, so a draft of Gemini's counts as reviewed when saved. */
	sawMemory: boolean;
	/** Cancel was pressed with unsaved changes: the footer asks before discarding. */
	confirming: boolean;
	/** Parts of the Memory tab that follow the text as it is typed. */
	counter?: HTMLElement;
	tokens?: HTMLElement;
	redraft?: HTMLButtonElement;
}

let open: Open | undefined;
/** The General tab's model menu, redrawn with the tab. */
let modelMenu: SelectMenu | undefined;

/** Opens Project settings with `view`, or, while open, takes in what changed. */
export function showProjectSettings(view: ProjectSettingsView, show: boolean): void {
	if (open) {
		open.draft = mergeRefresh(open.view, view, open.draft);
		open.view = view;
		render();
		return;
	}
	if (show) {
		build(view);
	}
}

/** The folder Add repository picked. */
export function pickedRepository(repo: ProjectRepoView): void {
	if (open) {
		open.draft = withRepo(open.draft, repo);
		render();
	}
}

function build(view: ProjectSettingsView): void {
	const text = strings.project?.settings;
	if (!text) {
		return;
	}
	const dialog = el('dialog', 'project-settings');
	dialog.setAttribute('aria-labelledby', 'project-settings-heading');
	const head = el('div', 'project-settings-head');
	const heading = el('h2');
	heading.id = 'project-settings-heading';
	const close = button('icon-button', '', () => tryClose(), 'close');
	setLabel(close, text.cancel);
	head.append(heading, close);

	const nav = el('div', 'project-settings-nav');
	nav.setAttribute('role', 'tablist');
	const tabs = new Map<Tab, HTMLButtonElement>();
	for (const [tab, label, iconName] of [['general', text.general, 'settings-gear'], ['memory', text.memory, 'book']] as const) {
		const tabButton = button('project-settings-tab', label, () => {
			if (open) {
				open.tab = tab;
				render();
			}
		}, iconName);
		tabButton.setAttribute('role', 'tab');
		tabs.set(tab, tabButton);
		nav.append(tabButton);
	}
	const body = el('div', 'project-settings-body');
	body.setAttribute('role', 'tabpanel');
	const main = el('div', 'project-settings-main');
	main.append(nav, body);

	const foot = el('div', 'permission-actions project-settings-foot');
	const note = el('span', 'project-settings-note');
	const cancel = button('secondary', text.cancel, () => tryClose());
	const save = button('primary', text.save, () => {
		if (open) {
			vscode.postMessage({ type: 'saveProjectSettings', settings: saveOf(open.draft, open.sawMemory && !!open.view.draftedAt) });
			finish();
		}
	});
	foot.append(note, cancel, save);

	dialog.append(head, main, foot);
	// Escape asks first when there are unsaved changes, as Cancel does.
	dialog.addEventListener('cancel', event => {
		event.preventDefault();
		tryClose();
	});
	dialog.addEventListener('close', () => {
		modelMenu?.dispose();
		modelMenu = undefined;
		dialog.remove();
		open = undefined;
	});
	document.body.append(dialog);
	open = { dialog, body, heading, note, cancel, tabs, view, draft: draftOf(view), tab: 'general', sawMemory: false, confirming: false };
	render();
	dialog.showModal();
	// The name field, rather than the close button the dialog would focus first.
	document.getElementById('project-settings-name')?.focus();
}

function tryClose(): void {
	if (!open) {
		return;
	}
	if (open.confirming || !unsavedChanges(open.view, open.draft)) {
		finish();
		return;
	}
	open.confirming = true;
	updateFoot();
}

function finish(): void {
	open?.dialog.close();
}

/** Redraws the heading, the tabs and the shown tab; typing updates only the parts that follow it. */
function render(): void {
	const text = strings.project?.settings;
	if (!open || !text) {
		return;
	}
	open.heading.textContent = format(text.title, open.draft.name.trim() || open.view.name);
	for (const [tab, tabButton] of open.tabs) {
		tabButton.classList.toggle('selected', tab === open.tab);
		tabButton.setAttribute('aria-selected', String(tab === open.tab));
	}
	if (open.tab === 'memory') {
		open.sawMemory = true;
	}
	open.counter = open.tokens = open.redraft = undefined;
	modelMenu?.dispose();
	modelMenu = undefined;
	open.body.replaceChildren(...open.tab === 'general' ? general(open) : memory(open));
	updateFoot();
}

function changed(next: Partial<SettingsDraft>, redraw = false): void {
	if (!open) {
		return;
	}
	open.draft = { ...open.draft, ...next };
	open.confirming = false;
	if (redraw) {
		render();
	} else {
		updateFoot();
	}
}

function updateFoot(): void {
	const text = strings.project?.settings;
	if (!open || !text) {
		return;
	}
	const count = unsavedChanges(open.view, open.draft);
	open.note.replaceChildren();
	open.note.classList.toggle('confirming', open.confirming);
	if (open.confirming) {
		open.note.append(el('span', undefined, text.discard));
		open.note.append(button('link-button', text.keepEditing, () => {
			if (open) {
				open.confirming = false;
				updateFoot();
			}
		}));
	} else if (count) {
		open.note.append(el('span', 'project-settings-dot'), el('span', undefined, `${count === 1 ? text.unsavedOne : format(text.unsaved, count)} · ${text.appliesWhen}`));
	} else {
		open.note.append(el('span', undefined, text.appliesWhen));
	}
	open.cancel.replaceChildren(el('span', undefined, open.confirming ? text.discardConfirm : text.cancel));
	open.cancel.classList.toggle('danger', open.confirming);
	if (open.counter) {
		open.counter.textContent = `${open.draft.instructions.length.toLocaleString()} / ${open.view.maxChars.toLocaleString()}`;
	}
	if (open.tokens) {
		open.tokens.textContent = format(text.tokens, threadTokens(open.draft).toLocaleString());
	}
	if (open.redraft) {
		// A draft would replace the text, so it waits for edits to be saved or discarded.
		open.redraft.disabled = !!open.view.drafting || open.draft.instructions !== open.view.instructions;
	}
}

function general(current: Open): HTMLElement[] {
	const text = strings.project!.settings;
	const { draft, view } = current;
	const stats = el('div', 'settings-stats');
	const stat = (value: string, label: string) => {
		const box = el('div', 'settings-stat');
		box.append(el('strong', undefined, value), el('span', undefined, label));
		return box;
	};
	stats.append(
		stat(String(view.stats.open), text.statOpen),
		stat(String(view.stats.merged), text.statMerged),
		stat(`+${view.stats.added.toLocaleString()} \u2212${view.stats.removed.toLocaleString()}`, text.statLines),
		stat(String(draft.repos.length), text.statRepos),
	);

	const name = settingsInput('project-settings-name');
	name.value = draft.name;
	name.addEventListener('input', () => {
		changed({ name: name.value });
		if (open) {
			open.heading.textContent = format(text.title, name.value.trim() || open.view.name);
		}
	});

	const repos = el('div', 'settings-list');
	draft.repos.forEach((repo, i) => {
		const row = el('div', 'settings-list-row');
		const label = el('span', 'settings-repo');
		label.append(toneOf(el('span', 'repo-pill', repo.key), repo.key), el('span', 'settings-muted', repo.label));
		row.append(label);
		if (i === 0) {
			row.append(el('span', 'settings-muted settings-small', text.mainRepo));
		} else {
			const remove = button('icon-button', '', () => changed({ repos: (open?.draft.repos ?? []).filter(each => each.folder !== repo.folder) }, true), 'close');
			setLabel(remove, format(text.removeRepo, repo.key));
			row.append(remove);
		}
		repos.append(row);
	});
	const addRow = el('div', 'settings-list-row settings-list-actions');
	addRow.append(button('link-button', text.addRepo, () => vscode.postMessage({ type: 'projectSettingsAction', action: 'pickRepository' }), 'add'));
	repos.append(addRow);

	const model = settingsInput('project-settings-model', 'select');
	model.append(new Option(strings.project!.dialog.defaultModel, ''));
	for (const choice of state.settings.model?.available ?? []) {
		model.append(new Option(choice.name, choice.id));
	}
	if (draft.defaults.threadModel && ![...model.options].some(option => option.value === draft.defaults.threadModel)) {
		model.append(new Option(draft.defaults.threadModel, draft.defaults.threadModel));
	}
	model.value = draft.defaults.threadModel ?? '';
	model.addEventListener('change', () => changed({ defaults: { ...open!.draft.defaults, ...model.value ? { threadModel: model.value } : { threadModel: undefined } } }));
	const plan = el('input');
	plan.id = 'project-settings-plan';
	plan.type = 'checkbox';
	plan.checked = draft.defaults.planFirst;
	plan.addEventListener('change', () => changed({ defaults: { ...open!.draft.defaults, planFirst: plan.checked } }));
	const prefix = settingsInput('project-settings-prefix');
	prefix.value = draft.defaults.branchPrefix;
	prefix.spellcheck = false;
	prefix.addEventListener('input', () => changed({ defaults: { ...open!.draft.defaults, branchPrefix: prefix.value } }));

	const defaults = el('div', 'settings-rows');
	defaults.append(
		settingRow(text.threadModel, undefined, (modelMenu = selectMenu(model, text.threadModel)).element, 'project-settings-model'),
		settingRow(text.planFirst, text.planFirstHint, plan),
		settingRow(text.branchPrefix, text.branchPrefixHint, prefix),
	);
	const sections = [
		stats,
		section(text.nameLabel, text.nameHint, name),
		section(text.reposLabel, text.reposHint, repos),
		section(text.defaultsLabel, undefined, defaults),
	];
	if (view.stats.merged) {
		// The extension asks first, with what it would remove and the space it frees.
		const cleanUp = el('div');
		cleanUp.append(button('link-button', text.cleanUp, () => vscode.postMessage({ type: 'projectSettingsAction', action: 'cleanUp' }), 'trash'));
		sections.push(section(text.cleanUpLabel, text.cleanUpHint, cleanUp));
	}
	return sections;
}

function memory(current: Open): HTMLElement[] {
	const text = strings.project!.settings;
	const { draft, view } = current;
	const many = draft.repos.length > 1;

	const area = settingsInput('project-settings-instructions', 'textarea');
	area.rows = 9;
	area.maxLength = view.maxChars;
	area.value = draft.instructions;
	area.readOnly = !!view.drafting;
	area.placeholder = view.drafting ? text.drafting : '';
	area.addEventListener('input', () => changed({ instructions: area.value }));
	const status = el('div', 'settings-draft');
	if (view.drafting) {
		status.classList.add('note');
		status.append(icon('loading', 'codicon-modifier-spin'), el('span', undefined, text.drafting));
	} else if (view.draftError) {
		status.classList.add('note', 'error');
		status.append(icon('warning'), el('span', undefined, format(text.draftFailed, view.draftError)));
	} else if (view.draftedAt) {
		status.classList.add('note');
		status.append(icon('sparkle'), el('span', undefined, format(text.drafted, new Date(view.draftedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }))));
	}
	const redraft = button('link-button', view.draftedAt || draft.instructions.trim() ? text.redraft : text.draft, () => vscode.postMessage({ type: 'projectSettingsAction', action: 'draft' }), 'sparkle');
	current.redraft = redraft;
	status.append(redraft);
	const counter = el('div', 'settings-counter');
	current.counter = counter;
	const instructions = el('div', 'settings-field');
	instructions.append(status, area, counter);

	const files = el('div', 'settings-list settings-files');
	const header = el('div', 'settings-list-row settings-files-head');
	header.append(el('span', undefined, text.fileColumn), el('span', undefined, text.coordinatorColumn), el('span', undefined, text.threadsColumn), el('span'));
	files.append(header);
	if (!draft.files.length) {
		files.append(el('div', 'settings-list-row settings-muted', text.noFiles));
	}
	for (const file of draft.files) {
		const row = el('div', 'settings-list-row settings-file');
		const name = button('link-button settings-file-name', file.name, () => vscode.postMessage({ type: 'projectSettingsAction', action: 'openFile', name: file.name }));
		const toggle = (role: 'coordinator' | 'threads', label: string) => {
			const box = el('input');
			box.type = 'checkbox';
			box.checked = file[role];
			setLabel(box, `${file.name}: ${label}`);
			box.addEventListener('change', () => changed({ files: currentFiles().map(each => each.name === file.name ? { ...each, [role]: box.checked } : each) }));
			const cell = el('span', 'settings-file-toggle');
			cell.append(box);
			return cell;
		};
		const remove = button('icon-button', '', () => changed({ files: currentFiles().filter(each => each.name !== file.name), removedFiles: [...currentRemoved(), file.name] }, true), 'close');
		setLabel(remove, format(text.removeFile, file.name));
		row.append(name, toggle('coordinator', text.coordinatorColumn), toggle('threads', text.threadsColumn), remove);
		files.append(row);
	}
	const actions = el('div', 'settings-list-row settings-list-actions');
	actions.append(
		button('link-button', text.addFiles, () => vscode.postMessage({ type: 'projectSettingsAction', action: 'addFiles' }), 'add'),
		button('link-button', text.newFile, () => vscode.postMessage({ type: 'projectSettingsAction', action: 'newFile' }), 'new-file'),
		el('span', 'settings-muted settings-small settings-path', view.memoryFolder),
	);
	files.append(actions);

	const rules = el('div', 'settings-rules');
	for (const repo of view.repoRules) {
		const line = el('div');
		line.append(toneOf(el('span', 'repo-pill', repo.key), repo.key), el('span', 'settings-muted', repo.files.length ? repo.files.join(' · ') : text.noRules));
		rules.append(line);
	}
	const tokens = el('div', 'settings-muted settings-small settings-tokens');
	current.tokens = tokens;

	return [
		section(many ? text.connectLabel : text.instructionsLabel, many ? text.connectHint : text.instructionsHint, instructions),
		section(text.filesLabel, text.filesHint, files),
		section(text.alsoRead, text.alsoReadHint, rules),
		tokens,
	];
}

function currentFiles(): SettingsDraft['files'] {
	return open?.draft.files ?? [];
}

function currentRemoved(): readonly string[] {
	return open?.draft.removedFiles ?? [];
}

function settingsInput<K extends 'input' | 'textarea' | 'select' = 'input'>(id: string, tag: K = 'input' as K): HTMLElementTagNameMap[K] {
	const node = el(tag, 'new-thread-input');
	node.id = id;
	return node;
}

function section(title: string, hint: string | undefined, content: HTMLElement): HTMLElement {
	const wrap = el('section', 'settings-section');
	const heading = el('h3', undefined, title);
	if (content.id) {
		const label = el('label', undefined, title);
		label.htmlFor = content.id;
		heading.replaceChildren(label);
	}
	wrap.append(heading);
	if (hint) {
		wrap.append(el('p', 'settings-muted settings-small', hint));
	}
	wrap.append(content);
	return wrap;
}

function settingRow(title: string, hint: string | undefined, control: HTMLElement, forId = control.id): HTMLElement {
	const row = el('div', 'settings-row');
	const label = el('label');
	label.htmlFor = forId;
	label.append(el('span', undefined, title));
	if (hint) {
		label.append(el('span', 'settings-muted settings-small', hint));
	}
	row.append(label, control);
	return row;
}
