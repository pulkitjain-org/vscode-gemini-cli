/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agents mode's Changes panel (src/host/changesPanel.ts): the agent's changed
// files, each with its changes as a unified diff and Keep and Undo on each.

import type { ChangedFileView, ChangesPanelView, FromChangesPanel, ToChangesPanel } from '../src/host/panelProtocol';
import type { ChangesPanelStrings } from '../src/host/panelStrings';
import { button, el, format, icon, pageStrings } from './panelDom';
import { renderTeam } from './mrPanel';
import { setTip } from './tooltip';
import type { TryChoiceMenu } from './tryChoiceMenu';

declare function acquireVsCodeApi(): { postMessage(message: FromChangesPanel): void; getState(): unknown; setState(state: unknown): void };

const vscode = acquireVsCodeApi();
const strings = pageStrings<ChangesPanelStrings>();
const bar = document.getElementById('bar')!;
const list = document.getElementById('files')!;
/** Files the user folded, by path; kept across updates and reloads. */
const folded = new Set<string>(Array.isArray(vscode.getState()) ? vscode.getState() as string[] : []);

type ChangesMenuModule = typeof import('./changesMenu');
const changesMenuUrl = document.querySelector<HTMLScriptElement>('script[data-changes-menu]')?.dataset.changesMenu;
/** The Try chevron's menu, a chunk of its own loaded on the first click. */
let tryMenu: Promise<TryChoiceMenu> | undefined;

function post(message: FromChangesPanel): void {
	vscode.postMessage(message);
}

function render(view: ChangesPanelView): void {
	bar.replaceChildren();
	list.replaceChildren();
	if (!view.agent) {
		list.append(el('p', 'empty', strings.noAgent));
		return;
	}
	if (view.team) {
		list.append(renderTeam(view.team, post));
	}
	if (!view.files.length) {
		// Once a merge request is open, its panel takes the empty list's place.
		if (!view.team?.mr) {
			list.append(el('p', 'empty', strings.empty));
		}
		return;
	}
	const counts = el('span', 'counts');
	counts.append(
		el('span', 'files', format(view.files.length === 1 ? strings.oneFile : strings.files, view.files.length)),
		el('span', 'added', `+${view.totals.added}`),
		el('span', 'removed', `\u2212${view.totals.removed}`),
	);
	const actions = el('span', 'actions');
	actions.append(
		tip(button('icon-button', '', () => post({ type: 'openAll' }), 'diff-multiple', strings.openAll), strings.openAll),
		button('secondary', strings.undoAll, () => post({ type: 'undoAll' })),
		button('secondary', strings.keepAll, () => post({ type: 'keepAll' })),
	);
	if (view.agent.trying) {
		actions.append(
			tip(button('secondary', strings.takeBack, () => post({ type: 'takeBack' }), 'discard'), strings.takeBackTip),
			tip(button('primary', strings.keepChanges, () => post({ type: 'keepTried' }), 'check'), strings.keepChangesTip),
		);
	} else if (view.agent.branch) {
		const choice = view.agent.tryChoice;
		const [label, hint, iconName] = choice === 'merge' ? [strings.mergeBack, strings.mergeBackTip, 'git-merge'] : choice === 'mr' ? [strings.openMr, strings.openMrTip, 'git-pull-request'] : [strings.tryIn, strings.tryInTip, 'beaker'];
		const agent = view.agent;
		const menu = button('primary try-menu', '', () => {
			// eslint-disable-next-line no-restricted-syntax
			tryMenu ??= (changesMenuUrl ? import(/* webpackIgnore: true */ changesMenuUrl) as Promise<ChangesMenuModule> : Promise.reject(new Error('no menu'))).then(module => module.createChangesMenu(strings.tryChoices, setTip));
			void tryMenu.then(loaded => loaded.toggle(menu, agent.tryChoice ?? 'try', !!agent.mergeRequests, choice => post({ type: 'tryChoice', choice })));
		}, 'chevron-down');
		menu.setAttribute('aria-label', strings.tryMenu);
		actions.append(tip(button('primary', label, () => post({ type: 'mergeBack' }), iconName), hint), tip(menu, strings.tryMenuTip));
	} else {
		const commit = button('primary', strings.commit, () => post({ type: 'commit' }), 'git-commit');
		commit.disabled = !view.agent.canCommit;
		if (view.agent.busy) {
			setTip(commit, strings.working);
		}
		actions.append(commit);
	}
	bar.append(counts, actions);
	for (const file of view.files) {
		list.append(renderFile(file));
	}
}

function renderFile(file: ChangedFileView): HTMLElement {
	const section = el('section', 'file');
	const header = el('div', 'file-header');
	header.tabIndex = 0;
	header.setAttribute('role', 'button');
	header.setAttribute('aria-expanded', String(!folded.has(file.path)));
	const toggle = () => {
		if (folded.has(file.path)) {
			folded.delete(file.path);
		} else {
			folded.add(file.path);
		}
		vscode.setState([...folded]);
		section.classList.toggle('folded', folded.has(file.path));
		header.setAttribute('aria-expanded', String(!folded.has(file.path)));
	};
	header.addEventListener('click', toggle);
	// Only the header itself: Enter on one of its buttons should press that button.
	header.addEventListener('keydown', e => e.target === header && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle()));
	const name = el('span', 'file-name');
	name.append(icon('chevron-down'), el('span', 'name', file.name));
	if (file.dir) {
		const dir = el('span', 'dir', file.dir);
		setTip(dir, file.dir);
		name.append(dir);
	}
	if (file.created) {
		name.append(el('span', 'tag', strings.newFile));
	}
	const counts = el('span', 'counts');
	counts.append(el('span', 'added', `+${file.added}`), el('span', 'removed', `\u2212${file.removed}`));
	const actions = el('span', 'file-actions');
	actions.append(
		tip(button('icon-button', '', () => post({ type: 'openFile', path: file.path }), 'go-to-file', strings.openFile), strings.openFile),
		tip(button('icon-button', '', () => post({ type: 'undoFile', path: file.path }), 'discard', strings.undoFile), strings.undoFile),
		tip(button('icon-button', '', () => post({ type: 'keepFile', path: file.path }), 'check', strings.keepFile), strings.keepFile),
	);
	header.append(name, counts, actions);
	section.append(header);
	section.classList.toggle('folded', folded.has(file.path));
	const body = el('div', 'file-body');
	if (!file.hunks) {
		body.append(el('p', 'note', strings.noDiff));
	}
	for (const hunk of file.hunks ?? []) {
		const block = el('div', 'hunk');
		const code = el('div', 'hunk-lines');
		for (const line of hunk.lines) {
			const row = el('div', `line ${line.kind}`);
			row.append(el('span', 'sign', line.kind === 'add' ? '+' : line.kind === 'del' ? '\u2212' : ' '), el('span', 'text', line.text || ' '));
			code.append(row);
		}
		if (hunk.hidden) {
			code.append(el('div', 'line more', format(strings.hiddenLines, hunk.hidden)));
		}
		const hunkActions = el('div', 'hunk-actions');
		hunkActions.append(
			button('chip', strings.undo, () => post({ type: 'undo', path: file.path, index: hunk.index }), 'discard'),
			button('chip', strings.keep, () => post({ type: 'keep', path: file.path, index: hunk.index }), 'check'),
		);
		block.append(code, hunkActions);
		body.append(block);
	}
	section.append(body);
	return section;
}

/** Gives `node` a themed tooltip in place of the native one; the label stays what screen readers read. */
function tip<T extends HTMLElement>(node: T, text: string): T {
	setTip(node, text);
	return node;
}

window.addEventListener('message', (event: MessageEvent<ToChangesPanel>) => {
	if (event.data.type === 'view') {
		render(event.data.view);
	}
});

post({ type: 'ready' });
