/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent Home (src/host/agentHome.ts): a composer that starts a new agent,
// cards for the agents at work, and earlier agents to resume.

import { type Attachment, attachmentLabel } from '../src/acp/attachments';
import type { FromHome, HomeAgent, HomeStrings, HomeView, ToHome } from '../src/host/panelProtocol';
import { attachmentIcon, sameAttachment } from './chatLogic';
import { Menu, type MenuRow } from './menu';
import { modeIcon } from './modeIcon';
import { button, el, icon, pageStrings } from './panelDom';

declare function acquireVsCodeApi(): { postMessage(message: FromHome): void; getState(): unknown; setState(state: unknown): void };

interface SavedState {
	readonly draft?: string;
	readonly folder?: string;
	readonly mode?: string;
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
const plusButton = document.getElementById('plus') as HTMLButtonElement;
const modeButton = document.getElementById('mode') as HTMLButtonElement;
const attachmentList = document.getElementById('attachments')!;
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
plusButton.title = strings.plusMenu;
plusButton.setAttribute('aria-label', strings.plusMenu);

let view: HomeView | undefined;
/** The folder the next agent starts in. */
let folder = saved.folder ?? '';
let ownBranchTouched = false;
/** The approval mode the next agent starts in. */
let mode = saved.mode ?? 'default';
/** Files the next agent's task is sent with. */
let attachments: Attachment[] = [];

/** A row per mode the next agent can start in; picking one closes `menu`. */
function modeRows(menu: () => Menu): MenuRow[] {
	return (view?.modes ?? []).map(choice => ({
		icon: modeIcon(choice.id),
		name: choice.name,
		detail: choice.description,
		checked: choice.id === mode,
		run: () => {
			mode = choice.id;
			save();
			updateControls();
			menu().close();
		},
	}));
}

const plusMenu: Menu = new Menu({
	element: document.getElementById('plus-menu')!,
	anchor: plusButton,
	label: strings.plusMenu,
	sections: () => [
		{ heading: strings.mode, rows: modeRows(() => plusMenu) },
		{
			rows: [{
				icon: 'files',
				name: strings.files,
				detail: strings.filesDetail,
				run: () => {
					plusMenu.close();
					vscode.postMessage({ type: 'pickFiles' });
				},
			}],
		},
	],
	empty: () => '',
});

const modeMenu: Menu = new Menu({
	element: document.getElementById('mode-menu')!,
	anchor: modeButton,
	label: strings.mode,
	sections: () => [{ rows: modeRows(() => modeMenu) }],
	empty: () => '',
});

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
	vscode.setState({ draft: prompt.value, folder, mode } satisfies SavedState);
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
	const currentMode = view?.modes.find(choice => choice.id === mode) ?? view?.modes[0];
	modeButton.parentElement!.hidden = !currentMode;
	if (currentMode) {
		mode = currentMode.id;
		modeButton.querySelector('span')!.textContent = currentMode.name;
		modeButton.querySelector('.codicon')!.className = `codicon codicon-${modeIcon(currentMode.id)}`;
		const label = `${strings.mode}: ${currentMode.name}`;
		modeButton.title = label;
		modeButton.setAttribute('aria-label', label);
	}
	folderMenu.render();
	plusMenu.render();
	modeMenu.render();
}

function renderAttachments(): void {
	attachmentList.replaceChildren(...attachments.map(attachment => {
		const chip = el('span', 'chip attachment');
		const label = attachmentLabel(attachment);
		chip.title = attachment.kind !== 'image' && attachment.path || label;
		chip.append(icon(attachmentIcon(attachment.kind, label)), el('span', undefined, label));
		const remove = button('chip-remove', '', () => {
			attachments = attachments.filter(a => a !== attachment);
			renderAttachments();
			prompt.focus();
		}, 'close', `${strings.remove} ${label}`);
		chip.append(remove);
		return chip;
	}));
	attachmentList.hidden = !attachments.length;
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
	vscode.postMessage({ type: 'start', folder, text, ownBranch: !ownBranchLabel.hidden && ownBranch.checked, mode, attachments });
	// The next task gets a session of its own.
	typingFor = undefined;
	prompt.value = '';
	attachments = [];
	renderAttachments();
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
/** What the extension was last told the user is typing a task for, so it hears once per folder. */
let typingFor: string | undefined;

/** Lets the extension start the agent, and a session for this task, while the user types it. */
function reportTyping(): void {
	const own = !ownBranchLabel.hidden && ownBranch.checked;
	const key = `${folder}\n${own}`;
	if (!prompt.value.trim() || !folder || key === typingFor) {
		return;
	}
	typingFor = key;
	vscode.postMessage({ type: 'typing', folder, ownBranch: own });
}

prompt.addEventListener('input', () => {
	save();
	updateControls();
	reportTyping();
});
ownBranch.addEventListener('change', () => {
	ownBranchTouched = true;
	reportTyping();
});

window.addEventListener('message', (event: MessageEvent<ToHome>) => {
	const message = event.data;
	if (message.type === 'view') {
		render(message.view);
	} else if (message.type === 'focus') {
		prompt.focus();
	} else if (message.type === 'attached') {
		attachments = [...attachments, ...message.attachments.filter(a => !attachments.some(b => sameAttachment(a, b)))];
		renderAttachments();
		prompt.focus();
	} else if (message.type === 'startFailed') {
		prompt.value ||= message.text;
		save();
		updateControls();
	}
});

vscode.postMessage({ type: 'ready' });
