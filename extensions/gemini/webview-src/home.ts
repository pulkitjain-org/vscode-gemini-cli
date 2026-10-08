/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent Home (src/host/agentHome.ts): a composer that starts a new agent,
// cards for the agents at work, and earlier agents to resume.

import type { FromHome, HomeAgent, HomeStrings, HomeView, ToHome } from '../src/host/panelProtocol';
import { Menu } from './menu';
import { button, el, icon, pageStrings } from './panelDom';

declare function acquireVsCodeApi(): { postMessage(message: FromHome): void; getState(): unknown; setState(state: unknown): void };

interface SavedState {
	readonly draft?: string;
	readonly folder?: string;
}

const vscode = acquireVsCodeApi();

const strings = pageStrings<HomeStrings>();
const saved = (vscode.getState() ?? {}) as SavedState;

const form = document.getElementById('composer') as HTMLFormElement;
const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
const workspaceButton = document.getElementById('workspace') as HTMLButtonElement;
const workspaceLabel = workspaceButton.querySelector('span')!;
const ownBranch = document.getElementById('own-branch') as HTMLInputElement;
const ownBranchLabel = document.getElementById('own-branch-label') as HTMLLabelElement;
const start = document.getElementById('start') as HTMLButtonElement;
const helpers = document.getElementById('helpers') as HTMLButtonElement;
const active = document.getElementById('active')!;
const earlier = document.getElementById('earlier')!;

document.getElementById('title')!.textContent = strings.title;
document.getElementById('subtitle')!.textContent = strings.subtitle;
prompt.placeholder = strings.placeholder;
prompt.value = saved.draft ?? '';
prompt.setAttribute('aria-label', strings.title);
ownBranchLabel.querySelector('.switch-label')!.textContent = strings.ownBranch;
ownBranchLabel.title = strings.ownBranchHint;
start.title = strings.start;
helpers.querySelector('span')!.textContent = strings.projectHelpers;
helpers.title = strings.projectHelpersHint;
helpers.addEventListener('click', () => vscode.postMessage({ type: 'projectHelpers' }));
start.setAttribute('aria-label', strings.start);

let view: HomeView | undefined;
/** The folder the next agent starts in. */
let folder = saved.folder ?? '';
let ownBranchTouched = false;

const folderMenu = new Menu({
	element: document.getElementById('workspace-menu')!,
	anchor: workspaceButton,
	label: strings.workspace,
	sections: () => [
		{
			rows: (view?.workspaces ?? []).map(w => ({
				icon: 'folder',
				name: w.name,
				detail: w.description,
				checked: w.folder === folder,
				run: () => {
					pickFolder(w.folder);
					folderMenu.close();
				},
			})),
		},
		{
			rows: [{
				icon: 'add',
				name: strings.addFolder,
				run: () => {
					folderMenu.close();
					vscode.postMessage({ type: 'addFolder' });
				},
			}],
		},
	],
	empty: () => strings.noWorkspace,
});

function save(): void {
	vscode.setState({ draft: prompt.value, folder } satisfies SavedState);
}

function pickFolder(next: string): void {
	folder = next;
	save();
	updateControls();
}

function updateControls(): void {
	const current = view?.workspaces.find(w => w.folder === folder);
	workspaceLabel.textContent = current?.name ?? strings.addFolder;
	const label = current ? `${strings.workspace}: ${current.description}/${current.name}` : strings.workspace;
	workspaceButton.title = label;
	workspaceButton.setAttribute('aria-label', label);
	ownBranchLabel.hidden = !current?.git;
	start.disabled = !prompt.value.trim() || !current;
	folderMenu.render();
}

function render(next: HomeView): void {
	view = next;
	if (!next.workspaces.some(w => w.folder === folder)) {
		folder = next.workspaces[0]?.folder ?? '';
	}
	if (!ownBranchTouched) {
		ownBranch.checked = next.ownBranch;
	}
	updateControls();

	active.replaceChildren();
	active.append(el('h2', undefined, strings.active));
	if (!next.workspaces.length) {
		active.append(el('p', 'muted', strings.noWorkspace));
	} else if (!next.active.length) {
		active.append(el('p', 'muted', strings.noAgents));
	}
	const cards = el('div', 'cards');
	for (const agent of next.active) {
		cards.append(card(agent));
	}
	active.append(cards);

	earlier.replaceChildren();
	earlier.hidden = !next.earlier.length;
	if (next.earlier.length) {
		earlier.append(el('h2', undefined, strings.earlier));
		const rows = el('div', 'earlier');
		for (const agent of next.earlier) {
			const row = el('button', 'earlier-row');
			row.type = 'button';
			row.append(icon('comment-discussion'), el('span', 'title', agent.title), el('span', 'muted', [agent.workspace, agent.branch, agent.updated].filter(Boolean).join(' · ')));
			row.addEventListener('click', () => vscode.postMessage({ type: 'open', id: agent.id }));
			rows.append(row);
		}
		earlier.append(rows);
	}
}

function card(agent: HomeAgent): HTMLElement {
	const node = el('article', `card ${agent.state}`);
	node.tabIndex = 0;
	node.setAttribute('aria-label', `${agent.title}, ${agent.status}`);
	node.addEventListener('click', () => vscode.postMessage({ type: 'open', id: agent.id }));
	node.addEventListener('keydown', e => {
		if ((e.key === 'Enter' || e.key === ' ') && e.target === node) {
			e.preventDefault();
			vscode.postMessage({ type: 'open', id: agent.id });
		}
	});
	const head = el('div', 'card-head');
	head.append(el('span', 'dot'), el('span', 'title', agent.title), el('span', 'muted', agent.updated));
	const status = el('div', 'card-status', agent.status);
	const meta = el('div', 'card-meta muted');
	meta.append(el('span', undefined, agent.workspace));
	if (agent.branch) {
		const branch = el('span', 'branch');
		branch.append(icon('git-branch'), el('span', undefined, agent.branch));
		meta.append(branch);
	}
	if (agent.changes) {
		meta.append(el('span', undefined, agent.changes));
	}
	const actions = el('div', 'card-actions');
	if (agent.state === 'working' || agent.state === 'waiting') {
		actions.append(button('secondary', strings.stop, () => vscode.postMessage({ type: 'stop', id: agent.id }), 'debug-stop'));
	}
	if (agent.changes) {
		actions.append(button('secondary', strings.review, () => vscode.postMessage({ type: 'review', id: agent.id }), 'diff'));
	}
	if (agent.branch && agent.changes && agent.state !== 'working') {
		actions.append(button('secondary', strings.mergeBack, () => vscode.postMessage({ type: 'mergeBack', id: agent.id }), 'git-merge'));
	}
	actions.append(button('primary', strings.open, () => vscode.postMessage({ type: 'open', id: agent.id })));
	node.append(head, status, meta, actions);
	return node;
}

function submit(): void {
	const text = prompt.value.trim();
	if (!text || !folder) {
		return;
	}
	vscode.postMessage({ type: 'start', folder, text, ownBranch: !ownBranchLabel.hidden && ownBranch.checked });
	prompt.value = '';
	save();
	updateControls();
}

form.addEventListener('submit', e => {
	e.preventDefault();
	submit();
});
prompt.addEventListener('keydown', e => {
	if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
		e.preventDefault();
		submit();
	}
});
prompt.addEventListener('input', () => {
	save();
	updateControls();
});
ownBranch.addEventListener('change', () => {
	ownBranchTouched = true;
});

window.addEventListener('message', (event: MessageEvent<ToHome>) => {
	const message = event.data;
	if (message.type === 'view') {
		render(message.view);
	} else if (message.type === 'focus') {
		prompt.focus();
	} else if (message.type === 'startFailed') {
		prompt.value ||= message.text;
		save();
		updateControls();
	}
});

vscode.postMessage({ type: 'ready' });
