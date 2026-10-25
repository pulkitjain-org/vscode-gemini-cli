/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Index page (src/host/indexPage.ts): each workspace's index, and the
// documentation attached to it, with the Add Docs popup.

import type { DocsRefresh, DocsScope } from '../src/acp/docs/docsProtocol';
import type { DocsSourceView, DocsSuggestionView, FromIndexPage, IndexPageStrings, IndexPageView, IndexWorkspaceView, SkippedFileView, ToIndexPage } from '../src/host/indexProtocol';
import { button, el, format, icon, pageStrings } from './panelDom';
import { selectMenu, type SelectMenu } from './selectMenu';
import { setTip } from './tooltip';

declare function acquireVsCodeApi(): { postMessage(message: FromIndexPage): void };

const vscode = acquireVsCodeApi();
const strings = pageStrings<IndexPageStrings>();
const defaultMaxPages = Number(document.querySelector<HTMLScriptElement>('script[data-max-pages]')?.dataset.maxPages ?? 500);
const page = document.getElementById('page')!;
let view: IndexPageView | undefined;
let folderMenu: SelectMenu | undefined;

function post(message: FromIndexPage): void {
	vscode.postMessage(message);
}

/** A button with a themed tooltip instead of the system's. */
function tipped<T extends HTMLElement>(node: T, tip: string): T {
	setTip(node, tip);
	return node;
}

function iconButton(name: string, tip: string, onClick: () => void): HTMLButtonElement {
	const node = button('icon-button', '', onClick, name);
	node.setAttribute('aria-label', tip);
	return tipped(node, tip);
}

function section(title: string, hint: string | HTMLElement, action?: HTMLElement): HTMLElement {
	const node = el('section', 'settings-section');
	const header = el('div', 'section-header');
	const text = el('div');
	const hintNode = typeof hint === 'string' ? el('p', 'hint', hint) : hint;
	text.append(el('h2', undefined, title), hintNode);
	header.append(text);
	if (action) {
		header.append(action);
	}
	node.append(header);
	return node;
}

function switchButton(on: boolean, label: string, onChange: (on: boolean) => void): HTMLButtonElement {
	const toggle = el('button', `switch${on ? ' on' : ''}`);
	toggle.type = 'button';
	toggle.setAttribute('role', 'switch');
	toggle.setAttribute('aria-checked', String(on));
	toggle.setAttribute('aria-label', label);
	toggle.addEventListener('click', () => {
		toggle.classList.toggle('on');
		toggle.setAttribute('aria-checked', String(!on));
		onChange(!on);
	});
	return tipped(toggle, label);
}

const stateLabels = () => ({ ready: strings.indexed, building: strings.indexing, paused: strings.paused, none: strings.notIndexed, failed: strings.failed });

function workspaceRow(workspace: IndexWorkspaceView): HTMLElement {
	const row = el('div', `row index-row state-${workspace.state}`);
	const dot = el('span', `index-dot ${workspace.state}`);
	dot.setAttribute('aria-hidden', 'true');
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	title.append(el('span', 'name', workspace.name), el('span', `tag index-tag ${workspace.state}`, stateLabels()[workspace.state]));
	main.append(title, el('div', 'row-detail', workspace.readOnly ? `${workspace.detail} · ${strings.readOnly}` : workspace.detail));
	if (workspace.progress !== undefined) {
		const bar = el('div', 'index-bar');
		const fill = el('i');
		fill.style.width = `${Math.round(workspace.progress * 100)}%`;
		bar.append(fill);
		bar.setAttribute('role', 'progressbar');
		bar.setAttribute('aria-valuenow', String(Math.round(workspace.progress * 100)));
		main.append(bar);
	}
	if (workspace.untrusted) {
		const problem = el('div', 'row-problem');
		problem.append(icon('warning'), el('span', undefined, strings.untrusted));
		main.append(problem);
	}
	row.append(dot, main);
	const folder = workspace.folder;
	if (workspace.untrusted) {
		row.append(button('secondary', strings.trust, () => post({ type: 'trust', folder }), 'shield'));
	}
	switch (workspace.state) {
		case 'ready':
			if (workspace.skipped) {
				row.append(button('link-button', strings.skippedFiles, () => openSkipped(folder, workspace.name)));
			}
			row.append(button('secondary', strings.rebuild, () => post({ type: 'rebuild', folder }), 'refresh'));
			break;
		case 'building':
			row.append(button('secondary', strings.pause, () => post({ type: 'pause', folder }), 'debug-pause'));
			break;
		case 'paused':
			row.append(button('secondary', strings.resume, () => post({ type: 'resume', folder }), 'debug-continue'));
			break;
		case 'failed':
			row.append(button('secondary', strings.rebuild, () => post({ type: 'rebuild', folder }), 'refresh'));
			break;
		case 'none':
			row.append(button('secondary', strings.indexNow, () => post({ type: 'build', folder }), 'database'));
			break;
	}
	if (workspace.state !== 'none') {
		row.append(iconButton('trash', strings.removeIndex, () => post({ type: 'remove', folder })));
	}
	row.append(iconButton('folder-opened', strings.reveal, () => post({ type: 'reveal', folder })));
	return row;
}

function sourceRow(source: DocsSourceView): HTMLElement {
	const row = el('div', `row docs-row${source.attached ? '' : ' off'}`);
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	title.append(el('span', 'name', source.title), el('span', 'tag subtle mono', source.url.replace(/^https?:\/\//, '')));
	if (source.fetching) {
		const chip = el('span', 'tag index-tag building');
		const spinner = icon('loading');
		spinner.classList.add('codicon-modifier-spin');
		chip.append(spinner, el('span', undefined, ` ${strings.fetching}`));
		title.append(chip);
	} else if (source.error) {
		title.append(el('span', 'tag index-tag failed', strings.failed));
	}
	main.append(title, el('div', 'row-detail', source.detail));
	if (source.error) {
		const problem = el('div', 'row-problem');
		problem.append(icon('error'), el('span', undefined, source.error));
		main.append(problem);
	}
	row.append(switchButton(source.attached, strings.attach, attached => post({ type: 'attach', id: source.id, attached })), main);
	if (source.error && !source.fetching) {
		row.append(button('secondary', strings.retry, () => post({ type: 'refreshSource', id: source.id }), 'refresh'));
	} else {
		const refresh = iconButton('refresh', strings.refreshSource, () => post({ type: 'refreshSource', id: source.id }));
		refresh.disabled = source.fetching;
		row.append(refresh);
	}
	row.append(
		iconButton('link-external', strings.openPage, () => post({ type: 'openUrl', url: source.url })),
		iconButton('trash', strings.removeSource, () => post({ type: 'removeSource', id: source.id })),
	);
	return row;
}

function suggestionRow(suggestion: DocsSuggestionView): HTMLElement {
	const row = el('div', 'row suggestion-row');
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	title.append(el('span', 'name', suggestion.version ? `${suggestion.title} ${suggestion.version.replace(/^[\^~>=<\s]+/, '')}` : suggestion.title), el('span', 'tag subtle mono', suggestion.url.replace(/^https?:\/\//, '')));
	main.append(title);
	row.append(main,
		button('secondary', strings.add, () => openAdd(suggestion.url)),
		button('link-button', strings.dismiss, () => post({ type: 'dismissSuggestion', url: suggestion.url })));
	return row;
}

function render(next: IndexPageView): void {
	view = next;
	const header = el('header', 'settings-header');
	const text = el('div');
	text.append(el('h1', undefined, strings.title), el('p', 'hint', strings.subtitle));
	header.append(text, switchButton(next.enabled, strings.enable, enabled => post({ type: 'setEnabled', enabled })));
	if (!next.enabled) {
		page.replaceChildren(header, el('p', 'empty index-off', strings.off));
		return;
	}

	const workspaces = section(strings.workspaces, strings.workspacesHint);
	const workspaceRows = el('div', 'rows');
	workspaceRows.append(...next.workspaces.map(workspaceRow));
	if (!next.workspaces.length) {
		workspaceRows.append(el('p', 'empty', strings.noWorkspaces));
	}
	workspaces.append(workspaceRows);

	const parts: HTMLElement[] = [header, workspaces];
	if (!next.docsEnabled) {
		const docs = section(strings.docs, strings.docsOff);
		parts.push(docs);
	} else {
		const hint = el('p', 'hint');
		const [before, after] = strings.docsHint.split('{0}');
		const select = el('select', 'select');
		for (const folder of next.folders) {
			const option = el('option', undefined, folder.name);
			option.value = folder.folder;
			option.selected = folder.folder === next.docsFolder;
			select.append(option);
		}
		select.addEventListener('change', () => post({ type: 'docsFolder', folder: select.value }));
		folderMenu?.dispose();
		folderMenu = selectMenu(select, strings.workspaces);
		hint.append(before ?? '', folderMenu.element, after ?? '');
		const add = button('primary', strings.addDocs, () => openAdd(), 'add');
		add.disabled = !next.folders.length;
		const docs = section(strings.docs, hint, add);
		const rows = el('div', 'rows');
		rows.append(...next.sources.map(sourceRow));
		if (!next.sources.length) {
			rows.append(el('p', 'empty', strings.noDocs));
		}
		docs.append(rows);
		parts.push(docs);
		if (next.suggestions.length) {
			const suggestions = section(strings.suggestions, format(strings.suggestionsHint, next.manifests.join(', ')));
			const list = el('div', 'rows');
			list.append(...next.suggestions.map(suggestionRow));
			suggestions.append(list);
			parts.push(suggestions);
		}
	}
	// Re-rendering replaces every element; keep keyboard focus on the same control.
	const focused = document.activeElement instanceof HTMLElement && page.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent : undefined;
	page.replaceChildren(...parts);
	if (focused) {
		[...page.querySelectorAll<HTMLElement>('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent) === focused)?.focus();
	}
}

// --- The Add Docs popup

let dialog: HTMLDialogElement | undefined;
let urlInput: HTMLInputElement;
let problem: HTMLElement;
let submit: HTMLButtonElement;
let pagesInput: HTMLInputElement;
let refreshSelect: HTMLSelectElement;
let refreshMenu: SelectMenu | undefined;
let folderList: HTMLElement;
let checkTimer: ReturnType<typeof setTimeout> | undefined;

function radio(name: string, value: string, label: string, checked: boolean, hint?: string): HTMLElement {
	const row = el('label', 'index-radio');
	const input = el('input');
	input.type = 'radio';
	input.name = name;
	input.value = value;
	input.checked = checked;
	const text = el('span');
	text.append(el('span', undefined, label));
	if (hint) {
		text.append(el('small', undefined, hint));
	}
	row.append(input, text);
	return row;
}

function field(label: string, control: HTMLElement, id?: string): HTMLElement {
	const node = el('div', 'index-field');
	const caption = el('label', undefined, label);
	if (id) {
		caption.htmlFor = id;
	}
	node.append(caption, control);
	return node;
}

function buildDialog(): HTMLDialogElement {
	const node = el('dialog', 'index-dialog');
	node.setAttribute('aria-label', strings.addTitle);
	const form = el('form');
	form.method = 'dialog';
	const head = el('div', 'index-dialog-head');
	const heading = el('div');
	heading.append(el('h2', undefined, strings.addTitle), el('p', 'hint', strings.addSubtitle));
	head.append(heading, iconButton('close', strings.close, () => node.close()));

	urlInput = el('input', 'index-input mono');
	urlInput.id = 'docs-url';
	urlInput.type = 'url';
	urlInput.required = true;
	urlInput.placeholder = strings.addressPlaceholder;
	urlInput.spellcheck = false;
	problem = el('div', 'row-problem index-problem');
	problem.hidden = true;
	urlInput.addEventListener('input', () => {
		clearTimeout(checkTimer);
		checkTimer = setTimeout(() => post({ type: 'checkUrl', url: urlInput.value }), 300);
	});

	const scopes = el('div', 'index-radios');
	scopes.setAttribute('role', 'radiogroup');
	scopes.append(
		radio('scope', 'page', strings.scopePage, false),
		radio('scope', 'prefix', strings.scopePrefix, true, strings.scopePrefixHint),
		radio('scope', 'site', strings.scopeSite, false),
	);

	pagesInput = el('input', 'index-input');
	pagesInput.id = 'docs-pages';
	pagesInput.type = 'number';
	pagesInput.min = '1';
	pagesInput.max = '5000';
	pagesInput.value = String(defaultMaxPages);
	const pages = el('div', 'index-inline');
	pages.append(pagesInput, el('span', 'hint', strings.pagesUnit));

	refreshSelect = el('select', 'select');
	refreshSelect.id = 'docs-refresh';
	for (const [value, label] of [['', strings.refreshDefault], ['daily', strings.refreshDaily], ['weekly', strings.refreshWeekly], ['manual', strings.refreshManual]] as const) {
		const option = el('option', undefined, label);
		option.value = value;
		refreshSelect.append(option);
	}
	refreshMenu = selectMenu(refreshSelect, strings.refresh);
	const pair = el('div', 'index-pair');
	pair.append(field(strings.upTo, pages, 'docs-pages'), field(strings.refresh, refreshMenu.element, 'docs-refresh'));

	folderList = el('div', 'index-checks');
	const urlField = field(strings.address, urlInput, 'docs-url');
	urlField.append(problem);

	submit = el('button', 'primary');
	submit.type = 'submit';
	submit.textContent = strings.addAndFetch;
	const cancel = button('secondary', strings.cancel, () => node.close());
	const foot = el('div', 'index-dialog-foot');
	foot.append(cancel, submit);

	form.append(head, urlField, field(strings.what, scopes), pair, field(strings.attachTo, folderList), el('p', 'hint index-fine', strings.fine), foot);
	form.addEventListener('submit', event => {
		event.preventDefault();
		const folders = [...folderList.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value);
		const scope = (form.querySelector<HTMLInputElement>('input[name="scope"]:checked')?.value ?? 'prefix') as DocsScope;
		submit.disabled = true;
		post({ type: 'addDocs', request: { url: urlInput.value, scope, maxPages: Number(pagesInput.value), ...refreshSelect.value ? { refresh: refreshSelect.value as DocsRefresh } : {}, folders } });
	});
	node.append(form);
	document.body.append(node);
	return node;
}

function openAdd(url?: string): void {
	dialog ??= buildDialog();
	urlInput.value = url ?? '';
	problem.hidden = true;
	submit.disabled = false;
	folderList.replaceChildren(...(view?.folders ?? []).map(folder => {
		const label = el('label', 'index-check');
		const input = el('input');
		input.type = 'checkbox';
		input.value = folder.folder;
		input.checked = folder.folder === view?.docsFolder;
		label.append(input, el('span', undefined, folder.name));
		return label;
	}));
	refreshSelect.value = '';
	refreshMenu?.sync();
	dialog.showModal();
	urlInput.focus();
}

// --- The Files Left Out popup

/** Rows drawn per reason; filtering finds the rest. */
const maxRowsPerGroup = 300;
/** Index All Anyway adds each file; more than this is a job for a pattern. */
const maxIncludeAll = 50;

let skippedDialog: HTMLDialogElement | undefined;
let skippedTitle: HTMLElement;
let skippedCount: HTMLElement;
let skippedFilter: HTMLInputElement;
let skippedBody: HTMLElement;
let skipped: { folder: string; files: readonly SkippedFileView[]; included: Set<string> } | undefined;

function buildSkippedDialog(): HTMLDialogElement {
	const node = el('dialog', 'index-dialog index-skipped');
	const head = el('div', 'index-dialog-head');
	const heading = el('div');
	skippedTitle = el('h2');
	skippedCount = el('p', 'hint');
	heading.append(skippedTitle, skippedCount);
	head.append(heading, iconButton('close', strings.close, () => node.close()));
	node.setAttribute('aria-labelledby', 'skipped-title');
	skippedTitle.id = 'skipped-title';
	skippedFilter = el('input', 'index-input');
	skippedFilter.type = 'search';
	skippedFilter.placeholder = strings.skippedFilter;
	skippedFilter.setAttribute('aria-label', strings.skippedFilter);
	skippedFilter.addEventListener('input', () => renderSkipped());
	skippedBody = el('div', 'index-skipped-body');
	const foot = el('div', 'index-dialog-foot');
	foot.append(
		button('secondary', strings.openIgnoreFile, () => skipped && post({ type: 'openIgnoreFile', folder: skipped.folder }), 'go-to-file'),
		button('secondary', strings.editInclude, () => post({ type: 'editInclude' }), 'settings-gear'),
		button('primary', strings.close, () => node.close()),
	);
	node.append(head, el('p', 'hint index-skipped-hint', strings.skippedHint), skippedFilter, skippedBody, foot);
	document.body.append(node);
	return node;
}

function openSkipped(folder: string, name: string): void {
	skippedDialog ??= buildSkippedDialog();
	skipped = { folder, files: [], included: new Set() };
	skippedTitle.textContent = format(strings.skippedTitle, name);
	skippedCount.textContent = '';
	skippedFilter.value = '';
	const loading = el('p', 'empty');
	const spinner = icon('loading');
	spinner.classList.add('codicon-modifier-spin');
	loading.append(spinner, el('span', undefined, ` ${strings.skippedLoading}`));
	skippedBody.replaceChildren(loading);
	skippedDialog.showModal();
	post({ type: 'skipped', folder });
}

function include(paths: readonly string[]): void {
	if (!skipped || !paths.length) {
		return;
	}
	for (const file of paths) {
		skipped.included.add(file);
	}
	post({ type: 'include', folder: skipped.folder, paths });
	renderSkipped();
}

function renderSkipped(): void {
	if (!skipped) {
		return;
	}
	const query = skippedFilter.value.trim().toLowerCase();
	const files = query ? skipped.files.filter(f => f.path.toLowerCase().includes(query) || f.reason.toLowerCase().includes(query)) : skipped.files;
	skippedCount.textContent = format(strings.skippedCount, skipped.files.length.toLocaleString());
	if (!files.length) {
		skippedBody.replaceChildren(el('p', 'empty', skipped.files.length ? strings.skippedNone : strings.skippedNone));
		return;
	}
	const groups = new Map<string, SkippedFileView[]>();
	for (const file of files) {
		const list = groups.get(file.reason) ?? [];
		list.push(file);
		groups.set(file.reason, list);
	}
	const sections: HTMLElement[] = [];
	for (const [reason, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
		const section = el('section', 'index-skipped-group');
		const header = el('div', 'index-skipped-group-head');
		const title = el('div');
		title.append(el('span', 'name', reason), el('span', 'hint', ` \u00b7 ${format(strings.skippedGroup, list.length.toLocaleString())}`));
		header.append(title);
		const includable = list.filter(f => f.includable && !skipped!.included.has(f.path));
		if (includable.length && includable.length <= maxIncludeAll) {
			header.append(button('secondary', strings.indexAllAnyway, () => include(includable.map(f => f.path))));
		} else if (includable.length > maxIncludeAll) {
			header.append(el('span', 'hint index-skipped-note', strings.tooManyForAll));
		}
		const rows = el('div', 'rows');
		for (const file of list.slice(0, maxRowsPerGroup)) {
			const row = el('div', 'row index-skipped-row');
			row.append(el('span', 'index-skipped-path mono', file.path));
			if (skipped.included.has(file.path)) {
				row.append(el('span', 'tag index-tag ready', strings.included));
			} else if (file.includable) {
				row.append(button('link-button', strings.indexAnyway, () => include([file.path])));
			} else {
				row.append(el('span', 'tag subtle', strings.neverIndexed));
			}
			rows.append(row);
		}
		if (list.length > maxRowsPerGroup) {
			rows.append(el('p', 'empty', format(strings.skippedMore, (list.length - maxRowsPerGroup).toLocaleString())));
		}
		section.append(header, rows);
		sections.push(section);
	}
	skippedBody.replaceChildren(...sections);
}

window.addEventListener('message', (event: MessageEvent<ToIndexPage>) => {
	const message = event.data;
	switch (message.type) {
		case 'view':
			render(message.view);
			break;
		case 'urlProblem':
			if (dialog && message.url === urlInput.value) {
				problem.replaceChildren(icon('error'), el('span', undefined, message.problem ?? ''));
				problem.hidden = !message.problem;
				submit.disabled = !!message.problem;
			}
			break;
		case 'added':
			dialog?.close();
			break;
		case 'openAdd':
			openAdd(message.url);
			break;
		case 'skippedList':
			if (skipped?.folder === message.folder) {
				skipped = { folder: message.folder, files: message.files, included: skipped.included };
				renderSkipped();
			}
			break;
	}
});

post({ type: 'ready' });
