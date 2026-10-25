/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Home (src/host/agentHome.ts): the dashboard GeminiCode opens with. A
// composer that starts a new agent, the team tools' state, what needs the
// user, cards for agents, tickets, merge requests, quality, releases and
// Gemini, and earlier agents to resume.

import { type Attachment, attachmentLabel } from '../src/acp/attachments';
import type { FromHome, HomeAction, HomeAgent, HomeButton, HomeCard, HomeDashboard, HomeRow, HomeStrings, HomeView, ToHome } from '../src/host/panelProtocol';
import { attachmentIcon, sameAttachment } from './chatLogic';
import { Menu, type MenuRow, type MenuSection } from './menu';
import { modeIcon } from './modeIcon';
import { button, el, format, icon, keepFocus, pageStrings } from './panelDom';
import type { CommentBox } from './commentBox';
import type { HomePopups } from './homePopups';
import { letSpellingMenuThrough } from './spellCheck';
import { createPreviewTabs, isPreviewShortcut } from './markdownPreview';
import { toolLogo } from './toolLogos';

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
const plusButton = document.getElementById('plus') as HTMLButtonElement;
const modeButton = document.getElementById('mode') as HTMLButtonElement;
const modelLabel = document.getElementById('model')!;
const fromToolsButton = document.getElementById('from-tools') as HTMLButtonElement;
const attachmentList = document.getElementById('attachments')!;
const active = document.getElementById('active')!;
const earlier = document.getElementById('earlier')!;
const projects = document.getElementById('projects')!;

const title = document.getElementById('title')!;
const subtitle = document.getElementById('subtitle')!;
title.textContent = strings.title;
subtitle.textContent = strings.subtitle;
prompt.placeholder = strings.composerPlaceholder;
prompt.value = saved.draft ?? '';
prompt.setAttribute('aria-label', strings.title);
ownBranchLabel.querySelector('.switch-label')!.textContent = strings.ownBranch;
ownBranchLabel.title = strings.ownBranchHint;
start.title = strings.start;
start.querySelector('span')!.textContent = strings.start;
fromToolsButton.querySelector('span')!.textContent = strings.fromTools;
fromToolsButton.title = strings.fromTools;
const helpers = document.getElementById('helpers') as HTMLButtonElement;
helpers.querySelector('span')!.textContent = strings.projectHelpers;
helpers.title = strings.projectHelpersHint;
helpers.addEventListener('click', () => vscode.postMessage({ type: 'projectHelpers' }));
const indexButton = document.getElementById('index') as HTMLButtonElement;
indexButton.querySelector('span')!.textContent = strings.index;
indexButton.title = strings.indexHint;
const indexState = document.getElementById('index-state') as HTMLButtonElement;
// A database drum: its outline, and a fill the state's class shows full, half or not at all. Static markup, never page data.
indexState.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path class="fill-full" d="M3 4v8.5c0 1.1 2.2 2 5 2s5-.9 5-2V4c0 1.1-2.2 2-5 2S3 5.1 3 4z"/><path class="fill-half" d="M3 8.5v4c0 1.1 2.2 2 5 2s5-.9 5-2v-4c0 1.1-2.2 2-5 2s-5-.9-5-2z"/><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8.5c0 1.1 2.2 2 5 2s5-.9 5-2V4"/></svg>';
for (const button of [indexButton, indexState]) {
	button.addEventListener('click', () => vscode.postMessage({ type: 'openIndex' }));
}
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

/** "From Your Tools...": the tickets and merge requests on the cards, each starting an agent or a review on it. */
const fromToolsMenu: Menu = new Menu({
	element: document.getElementById('from-tools-menu')!,
	anchor: fromToolsButton,
	label: strings.fromTools,
	sections: () => fromToolsSections(),
	empty: () => strings.fromToolsEmpty,
});

function fromToolsSections(): MenuSection[] {
	const cards = view?.dashboard.cards ?? [];
	const rowsOf = (id: HomeCard['id'], tool: 'jira' | 'gitlab', actionOf: (row: HomeRow) => HomeAction | undefined): MenuRow[] =>
		(cards.find(card => card.id === id)?.rows ?? []).flatMap(row => {
			const action = actionOf(row);
			return row.key && action ? [{
				iconElement: () => toolLogo(tool, 14),
				name: `${row.key} ${row.title}`,
				detail: [row.detail, row.pill?.text].filter(Boolean).join(' · '),
				run: () => {
					fromToolsMenu.close();
					run(action);
				},
			}] : [];
		});
	const tickets = rowsOf('tickets', 'jira', row => row.menu?.[0]?.action);
	const mergeRequests = rowsOf('mergeRequests', 'gitlab', row => row.button?.action);
	return [
		...tickets.length ? [{ heading: strings.tickets, rows: tickets }] : [],
		...mergeRequests.length ? [{ heading: strings.mergeRequests, rows: mergeRequests }] : [],
	];
}

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
	const index = current?.index;
	indexState.hidden = !index;
	if (index) {
		indexState.className = `index-state ${index.state}`;
		indexState.title = index.label;
		indexState.setAttribute('aria-label', index.label);
	}
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
	modelLabel.hidden = !view?.model;
	modelLabel.lastElementChild!.textContent = view?.model ?? '';
	folderMenu.render();
	plusMenu.render();
	modeMenu.render();
	fromToolsMenu.render();
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

/** What each part of the page was last drawn from, so a part that hasn't changed is left as it is, keeping hover and focus. */
const drawnFrom = new WeakMap<HTMLElement, string>();

/** Whether `node` was drawn from something other than `data`; it is taken as drawn from `data` from now. */
function changed(node: HTMLElement, data: unknown): boolean {
	const from = JSON.stringify(data) ?? '';
	if (drawnFrom.get(node) === from) {
		return false;
	}
	drawnFrom.set(node, from);
	return true;
}

/** Makes `parent`'s children `nodes`, in order, moving only those out of place, so a focused one stays focused. */
function place(parent: HTMLElement, nodes: readonly HTMLElement[]): void {
	let cursor = parent.firstElementChild;
	for (const node of nodes) {
		if (node === cursor) {
			cursor = cursor.nextElementSibling;
		} else {
			parent.insertBefore(node, cursor);
		}
	}
	while (cursor) {
		const next = cursor.nextElementSibling;
		cursor.remove();
		cursor = next;
	}
}

/** Elements drawn for items, by the items' keys, with what each was drawn from. */
type Drawn = Map<string, { readonly node: HTMLElement; readonly from: string }>;

/** Draws `items` into `parent` by key: an unchanged item keeps its element, a changed one is drawn again from it (`draw`'s `old`). */
function drawKeyed<T extends { readonly id: string }>(parent: HTMLElement, cache: Drawn, items: readonly T[], draw: (item: T, old?: HTMLElement) => HTMLElement): void {
	const kept: Drawn = new Map();
	place(parent, items.map(item => {
		const from = JSON.stringify(item);
		const entry = cache.get(item.id);
		const node = entry?.from === from ? entry.node : draw(item, entry?.node);
		kept.set(item.id, { node, from });
		return node;
	}));
	cache.clear();
	kept.forEach((entry, id) => cache.set(id, entry));
}

const activeCards = el('div', 'cards');
const agentCards: Drawn = new Map();
const dashCards: Drawn = new Map();

function render(next: HomeView): void {
	view = next;
	if (!next.workspaces.some(w => w.folder === folder)) {
		folder = next.workspaces[0]?.folder ?? '';
	}
	if (!ownBranchTouched) {
		ownBranch.checked = next.ownBranch;
	}
	updateControls();

	const note = !next.workspaces.length ? strings.noWorkspace : !next.active.length ? strings.noAgents : '';
	if (changed(active, note)) {
		active.replaceChildren(el('h2', undefined, strings.active), ...note ? [el('p', 'muted', note)] : [], activeCards);
	}
	drawKeyed(activeCards, agentCards, next.active, card);

	if (changed(projects, next.projects ?? null)) {
		renderProjects(next);
	}
	renderDashboard(next.dashboard);
	// The Agents card lists them; the big cards show only while it's hidden.
	active.hidden = next.dashboard.cards.some(c => c.id === 'agents');

	if (!changed(earlier, next.earlier)) {
		return;
	}
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

/** Projects, apart from the agents: each opens its project chat. */
function renderProjects(next: HomeView): void {
	projects.replaceChildren();
	projects.hidden = !next.projects;
	if (!next.projects) {
		return;
	}
	const heading = el('div', 'section-heading');
	const add = button('icon-button', '', () => vscode.postMessage({ type: 'newProject' }), 'add', strings.newProject);
	heading.append(el('h2', undefined, strings.projects), add);
	projects.append(heading);
	if (!next.projects.length) {
		projects.append(el('p', 'muted', strings.noProjects));
		return;
	}
	const rows = el('div', 'earlier');
	for (const project of next.projects) {
		const row = el('button', `earlier-row project-row ${project.state}`);
		row.type = 'button';
		row.append(icon('project'), el('span', 'title', project.title), el('span', 'muted', [project.workspace, project.threads, project.updated].join(' · ')));
		row.addEventListener('click', () => vscode.postMessage({ type: 'open', id: project.id }));
		rows.append(row);
	}
	projects.append(rows);
}

/** What an agent's card's buttons do, and how they are drawn: the message, its label and icon. */
type AgentButton = readonly ['stop' | 'review' | 'mergeBack' | 'open', string, string?];

/**
 * An agent's card, or `old` brought up to date in place. A click anywhere on
 * it opens the agent; from the keyboard, its Open button does, so the card
 * is not itself a control holding others.
 */
function card(agent: HomeAgent, old?: HTMLElement): HTMLElement {
	const node = old ?? el('article');
	if (!old) {
		node.addEventListener('click', () => vscode.postMessage({ type: 'open', id: agent.id }));
		const head = el('div', 'card-head');
		head.append(el('span', 'dot'), el('span', 'title'), el('span', 'muted'));
		node.append(head, el('div', 'card-status'), el('div', 'card-meta muted'), el('div', 'card-actions'));
	}
	node.className = `card ${agent.state}`;
	node.setAttribute('aria-label', `${agent.title}, ${agent.status}`);
	const [head, status, meta, actions] = [...node.children] as HTMLElement[];
	head.children[1].textContent = agent.title;
	head.children[2].textContent = agent.updated;
	status.textContent = agent.status;
	meta.replaceChildren(el('span', undefined, agent.workspace));
	if (agent.branch) {
		const branch = el('span', 'branch');
		branch.append(icon('git-branch'), el('span', undefined, agent.branch));
		meta.append(branch);
	}
	if (agent.changes) {
		meta.append(el('span', undefined, agent.changes));
	}
	// The buttons are drawn again only when which of them show changes.
	const shown: AgentButton[] = [
		...agent.state === 'working' || agent.state === 'waiting' ? [['stop', strings.stop, 'debug-stop'] as const] : [],
		...agent.changes ? [['review', strings.review, 'diff'] as const] : [],
		...agent.branch && agent.changes && agent.state !== 'working' ? [['mergeBack', strings.mergeBack, 'git-merge'] as const] : [],
		['open', strings.open],
	];
	if (changed(actions, shown)) {
		actions.replaceChildren(...shown.map(([type, label, iconName]) => button(type === 'open' ? 'primary' : 'secondary', label, () => vscode.postMessage({ type, id: agent.id }), iconName)));
	}
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
	previewTabs.close();
	attachments = [];
	renderAttachments();
	save();
	updateControls();
}

form.addEventListener('submit', e => {
	e.preventDefault();
	submit();
});
letSpellingMenuThrough(prompt);

type DraftMarkdown = typeof import('./draftMarkdown');
const draftMarkdownUrl = document.querySelector<HTMLScriptElement>('script[data-draft-markdown]')?.dataset.draftMarkdown;
let draftMarkdown: Promise<DraftMarkdown> | undefined;

/** Preview's renderer, a chunk of its own so Home's startup script stays small. */
function loadDraftMarkdown(): Promise<DraftMarkdown> {
	// eslint-disable-next-line no-restricted-syntax
	draftMarkdown ??= draftMarkdownUrl ? import(/* webpackIgnore: true */ draftMarkdownUrl) : Promise.reject(new Error('no renderer'));
	return draftMarkdown;
}

const calloutLabels: Record<string, string> = {
	note: strings.calloutNote, tip: strings.calloutTip, important: strings.calloutImportant, warning: strings.calloutWarning, caution: strings.calloutCaution,
};

const previewTabs = createPreviewTabs({
	input: prompt,
	inputWrap: prompt,
	preview: document.getElementById('preview')!,
	writeTab: document.getElementById('tab-write') as HTMLButtonElement,
	previewTab: document.getElementById('tab-preview') as HTMLButtonElement,
	form,
	strings,
	render: text => loadDraftMarkdown().then(module => module.renderDraft(text, kind => calloutLabels[kind] ?? kind)),
});
// Warm the renderer once Home has settled, so the first Preview is instant.
setTimeout(() => (window.requestIdleCallback ?? setTimeout)(() => void loadDraftMarkdown().catch(() => undefined)), 2000);

prompt.addEventListener('keydown', e => {
	if (!e.isComposing && isPreviewShortcut(e)) {
		e.preventDefault();
		previewTabs.toggle();
		return;
	}
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
	previewTabs.update();
	save();
	updateControls();
	reportTyping();
});
ownBranch.addEventListener('change', () => {
	ownBranchTouched = true;
	reportTyping();
});

// --- The dashboard

const tools = document.getElementById('tools')!;
const stale = document.getElementById('stale')!;
const refreshButton = document.getElementById('refresh') as HTMLButtonElement;
const customizeButton = document.getElementById('customize') as HTMLButtonElement;
const banner = document.getElementById('banner')!;
const quick = document.getElementById('quick')!;
const setup = document.getElementById('setup')!;
const needs = document.getElementById('needs')!;
const cardsSection = document.getElementById('cards')!;
const rowMenuElement = document.getElementById('row-menu')!;

customizeButton.title = strings.customize;
customizeButton.setAttribute('aria-label', strings.customize);
refreshButton.title = strings.refresh;
refreshButton.setAttribute('aria-label', strings.refresh);
refreshButton.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

type HomePopupsModule = typeof import('./homePopups');
const homePopupsUrl = document.querySelector<HTMLScriptElement>('script[data-home-popups]')?.dataset.homePopups;
let homePopups: Promise<HomePopups> | undefined;
/** Show All's popup and Customize, once loaded. */
let popups: HomePopups | undefined;

/** Show All's popup and the Customize menu, a chunk of their own loaded the first time either opens. */
function loadPopups(): Promise<HomePopups> {
	// eslint-disable-next-line no-restricted-syntax
	homePopups ??= (homePopupsUrl ? import(/* webpackIgnore: true */ homePopupsUrl) as Promise<HomePopupsModule> : Promise.reject(new Error('no popups'))).then(module => popups = module.createHomePopups({
		strings,
		post: message => vscode.postMessage(message),
		Menu,
		customizeButton,
		customizeElement: document.getElementById('customize-menu')!,
		dashboard: () => view?.dashboard,
		dashRow,
		groupHeading,
		logo,
		queryText,
	}));
	return homePopups;
}

// Until the chunk is loaded; then the Customize menu opens and closes itself.
customizeButton.addEventListener('click', () => void (popups ? undefined : loadPopups().then(loaded => loaded.openCustomize())));

function run(action: HomeAction): void {
	if (action.kind === 'comment') {
		// Over the popup, if it is open: the list is still there after the comment.
		void loadCommentBox().then(box => box.open(action));
		return;
	}
	// An item opened from the popup leaves it open when it opens elsewhere (a link), and closes it when it opens here.
	if (popups?.listOpen && action.kind !== 'link') {
		popups.closeList();
	}
	vscode.postMessage({ type: 'action', action });
}

type CommentBoxModule = typeof import('./commentBox');
const commentBoxUrl = document.querySelector<HTMLScriptElement>('script[data-comment-box]')?.dataset.commentBox;
let commentBox: Promise<CommentBox> | undefined;

/** The comment box for Jira tickets, a chunk of its own loaded the first time it opens. */
function loadCommentBox(): Promise<CommentBox> {
	// eslint-disable-next-line no-restricted-syntax
	commentBox ??= (commentBoxUrl ? import(/* webpackIgnore: true */ commentBoxUrl) as Promise<CommentBoxModule> : Promise.reject(new Error('no comment box'))).then(module => module.createCommentBox({
		strings,
		post: message => vscode.postMessage(message),
		renderMarkdown: text => loadDraftMarkdown().then(markdown => markdown.renderDraft(text, kind => calloutLabels[kind] ?? kind)),
		toAdf: (text, mentions) => loadDraftMarkdown().then(markdown => markdown.markdownToAdf(text, mentions)),
	}));
	return commentBox;
}

function queryText(text: string): HTMLElement {
	const query = el('span', 'dash-query', text);
	query.title = text;
	return query;
}

/** A heading inside a list, such as Mine or the sprint's name, from the row that starts its group. */
function groupHeading(row: HomeRow): HTMLElement {
	const heading = el('div', 'dash-group');
	heading.append(el('span', undefined, row.group ?? ''));
	if (row.groupQuery) {
		heading.append(el('span', 'dash-query', row.groupQuery));
	}
	return heading;
}

function actionButton(spec: HomeButton, className = 'secondary'): HTMLButtonElement {
	const node = button(spec.primary ? 'primary' : className, spec.label, () => run(spec.action), undefined, spec.title);
	return node;
}

function logo(tool: HomeRow['tool'], size: number): Element {
	if (!tool) {
		return el('span');
	}
	return tool === 'gemini' ? icon('sparkle') : toolLogo(tool, size);
}

/** The "..." menu of a row; moved into the row it opens for. */
let rowMenuItems: readonly HomeButton[] = [];
let rowMenuReturn: HTMLElement | undefined;
const rowMenuAnchor = el('button');
const rowMenu: Menu = new Menu({
	element: rowMenuElement,
	anchor: rowMenuAnchor,
	label: strings.moreActions,
	sections: () => [{ rows: rowMenuItems.map(item => ({ name: item.label, run: () => { rowMenu.close(); run(item.action); } })) }],
	empty: () => '',
	returnFocus: () => rowMenuReturn ?? prompt,
});

function openRowMenu(anchor: HTMLElement, items: readonly HomeButton[]): void {
	if (rowMenu.isOpen && rowMenuReturn === anchor) {
		rowMenu.close();
		return;
	}
	rowMenuItems = items;
	rowMenuReturn = anchor;
	anchor.parentElement!.append(rowMenuElement);
	rowMenu.open();
}

function renderDashboard(dash: HomeDashboard): void {
	title.textContent = dash.greeting;
	subtitle.textContent = dash.context;
	stale.hidden = !dash.stale;
	stale.textContent = dash.stale ?? '';
	// Each part is drawn again only when what it shows changed: Home gets a new view every moment while agents work.
	if (changed(tools, dash.tools)) {
		tools.replaceChildren(...dash.tools.map(tool => {
			const node = el('span', `dash-tool ${tool.tone}`);
			node.title = tool.label;
			node.setAttribute('role', 'img');
			node.setAttribute('aria-label', tool.label);
			node.append(toolLogo(tool.id, 18));
			node.addEventListener('click', () => run({ kind: 'command', command: 'gemini.connections' }));
			return node;
		}));
	}
	refreshButton.classList.toggle('spinning', dash.refreshing);
	banner.hidden = !dash.banner;
	if (changed(banner, dash.banner ?? '')) {
		banner.replaceChildren(...dash.banner ? [icon('warning'), el('span', undefined, dash.banner)] : []);
	}

	if (changed(quick, dash.quickActions)) {
		quick.replaceChildren(...dash.quickActions.map(action => {
			const node = button('dash-quick-action', '', () => run(action.action));
			node.append(action.tool ? toolLogo(action.tool, 14) : icon(action.icon ?? 'play'), el('span', undefined, action.label));
			return node;
		}));
	}

	setup.hidden = !dash.setup;
	if (changed(setup, dash.setup ?? null) && dash.setup) {
		setup.replaceChildren(el('h2', undefined, strings.getStarted));
		const steps = el('ol', 'dash-steps');
		dash.setup.forEach((step, i) => {
			const item = el('li', `dash-step${step.done ? ' done' : ''}`);
			const mark = el('span', 'dash-step-mark', step.done ? '' : String(i + 1));
			if (step.done) {
				mark.append(icon('check'));
			}
			const text = el('div', 'dash-step-text');
			text.append(el('strong', undefined, step.title), el('span', 'muted', step.detail));
			item.append(mark, text);
			if (step.button && !step.done) {
				item.append(actionButton(step.button));
			}
			steps.append(item);
		});
		setup.append(steps);
	}

	needs.hidden = !dash.needs.length;
	if (changed(needs, [dash.needs, dash.needsQuery])) {
		needs.replaceChildren();
		if (dash.needs.length) {
			const head = el('div', 'dash-card-head');
			const query = el('span', 'dash-query', dash.needsQuery);
			query.title = dash.needsQuery;
			head.append(el('span', 'dot warn'), el('h3', undefined, strings.needsYou), query);
			const rows = el('div', 'dash-rows');
			for (const need of dash.needs) {
				rows.append(dashRow({ tool: need.tool, title: need.title, detail: need.detail, ...need.pill ? { pill: need.pill } : {}, button: need.button }));
			}
			needs.append(head, rows);
		}
	}

	drawKeyed(cardsSection, dashCards, dash.cards, dashCard);
	popups?.update(dash);
}

function dashCard(card: HomeCard): HTMLElement {
	const node = el('article', `dash-card${card.stale ? ' stale' : ''}`);
	node.dataset.card = card.id;
	const head = el('div', 'dash-card-head');
	head.append(card.tool ? logo(card.tool, 16) : icon(card.icon ?? 'circle'), el('h3', undefined, card.title));
	if (card.link) {
		head.append(button('link-button', card.link.label, () => run(card.link!.action)));
	}
	if (card.query) {
		const query = el('span', 'dash-query', card.query);
		query.title = card.query;
		head.append(query);
	}
	node.append(head);
	if (card.connect) {
		node.classList.add('unconnected');
		node.append(el('p', 'muted', card.connect.text), actionButton(card.connect.button));
		return node;
	}
	const rows = el('div', 'dash-rows');
	for (const row of card.rows) {
		if (row.group) {
			rows.append(groupHeading(row));
		}
		rows.append(dashRow(row));
	}
	node.append(rows);
	if (card.note) {
		node.append(el('p', 'dash-note muted', card.note));
	}
	if (card.total) {
		node.append(button('link-button dash-show-all', format(strings.showAll, card.total), () => void loadPopups().then(loaded => loaded.showList(card))));
	}
	return node;
}

/** A card's row; `inList` for Show All's popup, which has room for the repository. */
function dashRow(row: HomeRow, inList = false): HTMLElement {
	const node = el('div', 'dash-row');
	if (row.tool) {
		node.append(logo(row.tool, 14));
	} else if (row.icon) {
		node.append(icon(row.icon));
	}
	if (row.type) {
		const type = icon(row.type.icon);
		type.classList.add('dash-type', row.type.color);
		type.title = row.type.name;
		type.removeAttribute('aria-hidden');
		type.setAttribute('role', 'img');
		type.setAttribute('aria-label', row.type.name);
		node.append(type);
	}
	if (row.key) {
		node.append(el('span', 'dash-key', row.key));
	}
	if (row.repo && inList) {
		const repo = el('span', 'dash-repo', row.repo.slice(row.repo.lastIndexOf('/') + 1));
		repo.title = row.repo;
		node.append(repo);
	}
	const name = row.open ? button('dash-row-title', row.title, () => run(row.open!)) : el('span', 'dash-row-title', row.title);
	name.title = row.title;
	node.append(name);
	if (row.detail) {
		node.append(el('span', 'dash-row-detail', row.detail));
	}
	if (row.bar !== undefined) {
		const track = el('span', 'dash-row-bar');
		const fill = el('span', 'dash-row-bar-fill');
		fill.style.width = `${Math.round(Math.min(1, Math.max(0, row.bar)) * 100)}%`;
		track.append(fill);
		node.append(track);
	}
	if (row.pill) {
		node.append(el('span', `dash-pill ${row.pill.tone}`, row.pill.text));
	}
	if (row.button) {
		node.append(actionButton(row.button));
	}
	if (row.link) {
		node.append(button('link-button', row.link.label, () => run(row.link!.action)));
	}
	if (row.menu?.length) {
		const wrap = el('span', 'dash-row-more');
		const more = button('icon-button', '', () => openRowMenu(more, row.menu!), 'ellipsis', strings.moreActions);
		wrap.append(more);
		node.append(wrap);
	}
	return node;
}

window.addEventListener('message', (event: MessageEvent<ToHome>) => {
	const message = event.data;
	if (message.type === 'view') {
		// What changed is drawn again; focus, and the caret in a field, stay where they were.
		keepFocus(document.body, () => render(message.view));
	} else if (message.type === 'focus') {
		prompt.focus();
	} else if (message.type === 'spellCheck') {
		prompt.spellcheck = message.on;
	} else if (message.type === 'attached') {
		attachments = [...attachments, ...message.attachments.filter(a => !attachments.some(b => sameAttachment(a, b)))];
		renderAttachments();
		prompt.focus();
	} else if (message.type === 'commented' || message.type === 'commentPeople' || message.type === 'commentOptions' || message.type === 'commentFiles') {
		void commentBox?.then(box => box.onMessage(message));
	} else if (message.type === 'startFailed') {
		prompt.value ||= message.text;
		save();
		updateControls();
	}
});

vscode.postMessage({ type: 'ready' });
