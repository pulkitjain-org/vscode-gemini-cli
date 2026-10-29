/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// An agent's Files page (src/host/agentFilesPage.ts): a search, New File and
// Recents on the left, the agent's folder as a tree on the right. Beside an
// open file the page is narrow and shows only its tree, whose close button
// then closes the page; wide, that button hides the tree.

import { fileIcon } from '../src/acp/agentFiles';
import type { FileRow, FilesStrings, FilesView, FromFiles, ToFiles, TreeEntry } from '../src/host/agentFilesProtocol';
import { button, el, icon, pageStrings } from './panelDom';
import { setTip } from './tooltip';

declare function acquireVsCodeApi(): {
	postMessage(message: FromFiles): void;
	getState(): SavedState | undefined;
	setState(state: SavedState): void;
};

interface SavedState {
	readonly open: readonly string[];
	readonly treeHidden: boolean;
}

const vscode = acquireVsCodeApi();
const strings = pageStrings<FilesStrings>();
const page = document.getElementById('page')!;
/** Narrow, beside an open file: the tree alone. */
const narrow = matchMedia('(max-width: 479px)');
const searchDelayMs = 80;

let view: FilesView | undefined;
/** Each listed folder's entries. */
const listed = new Map<string, readonly TreeEntry[]>();
/** The folders open in the tree. */
const open = new Set<string>(vscode.getState()?.open ?? []);
let treeHidden = vscode.getState()?.treeHidden ?? false;
let query = '';
let found: readonly FileRow[] | undefined;
let lastSearch = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const home = el('section', 'files-home');
const tree = el('section', 'files-tree');
const searchBox = el('label', 'files-search');
const searchInput = el('input');
searchInput.type = 'search';
searchInput.placeholder = strings.search;
searchInput.setAttribute('aria-label', strings.search);
searchBox.append(icon('search'), searchInput);
const list = el('div', 'files-list');
const showTree = button('icon-button files-show-tree', '', () => setTreeHidden(false), 'layout-sidebar-right');
setTip(showTree, strings.showTree);
showTree.setAttribute('aria-label', strings.showTree);
home.append(showTree, searchBox, button('files-row files-new', strings.newFile, () => vscode.postMessage({ type: 'newFile' }), 'new-file'), list);
tree.setAttribute('aria-label', strings.tree);
page.append(home, tree);

function save(): void {
	vscode.setState({ open: [...open], treeHidden });
}

function setTreeHidden(hidden: boolean): void {
	treeHidden = hidden;
	save();
	render();
}

function fileButton(file: FileRow): HTMLButtonElement {
	const row = button('files-row', '', () => vscode.postMessage({ type: 'open', path: file.path }), file.icon);
	row.append(el('span', 'files-name', file.name));
	if (file.folder) {
		row.append(el('span', 'files-folder', file.folder));
	}
	setTip(row, file.folder ? `${file.folder}/${file.name}` : file.name);
	return row;
}

function renderList(): void {
	const files = query ? found ?? [] : view?.recents ?? [];
	const heading = query ? [] : [el('h2', 'files-heading', strings.recents)];
	const empty = !files.length && (query ? found !== undefined : true) ? [el('p', 'files-empty', query ? strings.noMatches : strings.noRecents)] : [];
	list.replaceChildren(...heading, ...files.map(fileButton), ...empty);
}

function entryRows(folder: string, depth: number): HTMLElement[] {
	const entries = listed.get(folder);
	if (!entries) {
		return [];
	}
	if (!entries.length) {
		return [el('p', 'files-empty files-tree-empty', strings.emptyFolder)];
	}
	return entries.flatMap(entry => {
		const isOpen = entry.folder && open.has(entry.path);
		const row = button(`files-row tree-row${entry.ignored ? ' ignored' : ''}`, '', () => entry.folder ? toggle(entry) : vscode.postMessage({ type: 'open', path: entry.path }), entry.folder ? (isOpen ? 'folder-opened' : 'folder') : fileIcon(entry.name));
		row.style.paddingLeft = `${8 + depth * 14}px`;
		row.append(el('span', 'files-name', entry.name));
		if (entry.folder) {
			row.setAttribute('aria-expanded', String(isOpen));
		}
		return [row, ...isOpen ? entryRows(entry.path, depth + 1) : []];
	});
}

function toggle(entry: TreeEntry): void {
	if (open.has(entry.path)) {
		open.delete(entry.path);
	} else {
		open.add(entry.path);
		if (!listed.has(entry.path)) {
			vscode.postMessage({ type: 'list', folder: entry.path, ignored: entry.ignored });
		}
	}
	save();
	renderTree();
}

function renderTree(): void {
	if (!view) {
		return;
	}
	const close = button('icon-button files-close-tree', '', () => narrow.matches ? vscode.postMessage({ type: 'close' }) : setTreeHidden(true), narrow.matches ? 'close' : 'layout-sidebar-right-off');
	const label = narrow.matches ? strings.closeTree : strings.hideTree;
	setTip(close, label);
	close.setAttribute('aria-label', label);
	const header = el('div', 'files-tree-header');
	header.append(el('span', 'files-root', view.root.name), close);
	const rows = el('div', 'files-tree-rows');
	rows.append(...entryRows(view.root.path, 0));
	tree.replaceChildren(header, rows);
}

function render(): void {
	document.body.classList.toggle('tree-hidden', treeHidden && !narrow.matches);
	renderList();
	renderTree();
}

searchInput.addEventListener('input', () => {
	query = searchInput.value.trim();
	found = undefined;
	clearTimeout(searchTimer);
	if (query) {
		searchTimer = setTimeout(() => vscode.postMessage({ type: 'search', requestId: ++lastSearch, query }), searchDelayMs);
	}
	renderList();
});

narrow.addEventListener('change', render);

window.addEventListener('message', (event: MessageEvent<ToFiles>) => {
	const message = event.data;
	switch (message.type) {
		case 'view':
			view = message.view;
			render();
			break;
		case 'entries': {
			listed.set(message.folder, message.entries);
			// Folders opened before a reload are listed again as they come into view.
			for (const entry of message.entries) {
				if (entry.folder && open.has(entry.path) && !listed.has(entry.path)) {
					vscode.postMessage({ type: 'list', folder: entry.path, ignored: entry.ignored });
				}
			}
			renderTree();
			break;
		}
		case 'found':
			if (message.requestId === lastSearch) {
				found = message.files;
				renderList();
			}
			break;
		case 'changed':
			for (const folder of message.folders) {
				if (listed.has(folder)) {
					const parent = [...listed.values()].flat().find(entry => entry.path === folder);
					vscode.postMessage({ type: 'list', folder, ignored: parent?.ignored });
				}
			}
			break;
	}
});

vscode.postMessage({ type: 'ready' });
