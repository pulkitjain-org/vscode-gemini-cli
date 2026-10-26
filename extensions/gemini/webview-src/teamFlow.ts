/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The team flows' page (src/host/teamFlows.ts): Open Merge Request, Move
// Ticket and Log Time, Review, and Checks.
// The host holds the state and re-renders with `state`; what the user types
// goes back with `set`, without a re-render, so typing is never interrupted.

import type { TargetChoice } from '../src/acp/teamFlowLogic';
import type { ChecksView, FlowPerson, FlowPill, FlowTool, FromTeamFlow, MoveTicketView, OpenMrView, ReviewCommentView, ReviewThreadView, ReviewView, TeamFlowState, TeamFlowStrings, ToTeamFlow } from '../src/host/teamFlowProtocol';
import { Menu } from './menu';
import { button, el, format, icon, keepFocus, pageStrings } from './panelDom';
import { selectMenu } from './selectMenu';
import { toolLogo } from './toolLogos';
import { setTip } from './tooltip';

declare function acquireVsCodeApi(): { postMessage(message: FromTeamFlow): void };

const vscode = acquireVsCodeApi();
const strings = pageStrings<TeamFlowStrings>();
const root = document.getElementById('flow')!;
/** Menus of the current render, disposed with it. */
let disposables: { dispose(): void }[] = [];
/** The last description and comment revisions shown, so a re-render keeps what the user typed. */
const shown = new Map<string, { rev: number; text: string }>();

function set(field: string, value: unknown): void {
	vscode.postMessage({ type: 'set', field, value });
}

function act(action: string, value?: unknown): void {
	vscode.postMessage({ type: 'act', action, value });
}

function logo(tool: FlowTool | 'people' | 'review', size = 14): Element {
	return tool === 'people' ? icon('organization') : tool === 'review' ? icon('comment-discussion') : toolLogo(tool, size);
}

function pill(p: FlowPill | undefined): HTMLElement | undefined {
	return p ? el('span', `pill ${p.tone}`, p.text) : undefined;
}

function checkbox(label: string | Node, checked: boolean, onChange: (on: boolean) => void, hint?: string): HTMLElement {
	const row = el('label', 'flow-check');
	const box = el('input');
	box.type = 'checkbox';
	box.checked = checked;
	box.dataset.focusKey = `check:${typeof label === 'string' ? label : label.textContent}`;
	box.addEventListener('change', () => onChange(box.checked));
	const text = el('span', 'flow-check-text');
	text.append(label);
	if (hint) {
		text.append(el('span', 'hint', hint));
	}
	row.append(box, text);
	return row;
}

/** A text field that reports each change; `rev` lets the host replace what the user typed (a regenerated description). */
function textField(field: string, value: string, options: { multiline?: boolean; placeholder?: string; rev?: number; mono?: boolean; onInput?: (text: string) => void } = {}): HTMLInputElement | HTMLTextAreaElement {
	const input = options.multiline ? el('textarea', 'flow-input') : el('input', 'flow-input');
	// Found again by its field when the page is drawn again, so the caret stays where the user types.
	input.dataset.focusKey = field;
	if (input instanceof HTMLInputElement) {
		input.type = 'text';
	}
	if (options.mono) {
		input.classList.add('mono');
	}
	const previous = shown.get(field);
	const rev = options.rev ?? 0;
	input.value = previous && previous.rev === rev ? previous.text : value;
	shown.set(field, { rev, text: input.value });
	input.placeholder = options.placeholder ?? '';
	input.addEventListener('input', () => {
		shown.set(field, { rev, text: input.value });
		set(field, input.value);
		options.onInput?.(input.value);
	});
	return input;
}

/** A themed single choice over `choices`. */
function choice(label: string, value: string, choices: readonly { readonly value: string; readonly text: string }[], onChange: (value: string) => void): HTMLElement {
	const select = el('select');
	for (const c of choices) {
		const option = el('option', undefined, c.text);
		option.value = c.value;
		select.append(option);
	}
	select.value = value;
	select.addEventListener('change', () => onChange(select.value));
	const menu = selectMenu(select, label);
	disposables.push(menu);
	return menu.element;
}

/** Chips for the chosen people and Add..., which opens a themed menu with search. */
function people(chosen: readonly FlowPerson[], members: readonly FlowPerson[], onChange: (ids: number[]) => void): HTMLElement {
	const box = el('div', 'flow-people');
	box.append(el('span', 'flow-people-label', strings.reviewers));
	const ids = chosen.map(p => p.id);
	for (const person of chosen) {
		const chip = el('span', 'chip person');
		chip.append(el('span', undefined, `@${person.username}`), button('chip-remove', '', () => onChange(ids.filter(id => id !== person.id)), 'close', person.name));
		box.append(chip);
	}
	const anchor = button('link', strings.addReviewer, () => undefined);
	const list = el('div', 'flow-menu');
	list.hidden = true;
	const holder = el('span', 'flow-menu-holder');
	holder.append(anchor, list);
	const menu: Menu = new Menu({
		element: list,
		anchor,
		label: strings.reviewers,
		search: () => strings.searchPeople,
		sections: () => [{
			rows: members.map(m => ({
				name: m.name,
				detail: `@${m.username}`,
				checked: ids.includes(m.id),
				run: () => {
					menu.close();
					onChange(ids.includes(m.id) ? ids.filter(id => id !== m.id) : [...ids, m.id]);
				},
			})),
		}],
		empty: () => strings.noPeople,
	});
	disposables.push(menu);
	box.append(holder);
	return box;
}

function dialog(tool: FlowTool, title: string, subtitle?: Node | string): { box: HTMLElement; body: HTMLElement; foot: HTMLElement } {
	const box = el('div', 'flow-dialog');
	const head = el('header', 'flow-head');
	const tile = el('span', 'flow-tile');
	tile.append(toolLogo(tool, 22));
	const titles = el('div', 'flow-titles');
	titles.append(el('h1', undefined, title));
	if (subtitle) {
		const sub = el('div', 'flow-subtitle');
		sub.append(subtitle);
		titles.append(sub);
	}
	head.append(tile, titles, button('icon-button', '', () => act('close'), 'close', strings.close));
	const body = el('div', 'flow-body');
	const foot = el('footer', 'flow-foot');
	box.append(head, body, foot);
	return { box, body, foot };
}

function heading(text: string, end?: Node): HTMLElement {
	const h = el('div', 'flow-heading');
	h.append(el('h2', undefined, text));
	if (end) {
		h.append(end);
	}
	return h;
}

/** Draws the page for `state`. Focus, and the caret in a field, stay where they were: a description that arrives while the user types the title doesn't interrupt them. */
function render(state: TeamFlowState): void {
	keepFocus(root, () => draw(state));
}

function draw(state: TeamFlowState): void {
	disposables.forEach(d => d.dispose());
	disposables = [];
	root.replaceChildren();
	if (state.loading || !state.view) {
		const p = el('div', 'flow-loading');
		p.append(icon('loading'), el('span', undefined, state.loading ?? ''));
		p.querySelector('.codicon')?.classList.add('codicon-modifier-spin');
		root.append(p);
		if (state.error) {
			root.append(el('div', 'flow-error', state.error));
		}
		return;
	}
	const view = state.view;
	const part = view.kind === 'openMr' ? openMr(view)
		: view.kind === 'moveTicket' ? moveTicket(view)
			: view.kind === 'review' ? review(view)
				: checks(view);
	if (state.error) {
		part.body.prepend(el('div', 'flow-error', state.error));
	}
	if (state.busy) {
		const busy = el('span', 'flow-busy');
		busy.append(icon('loading'), el('span', undefined, state.busy));
		busy.querySelector('.codicon')?.classList.add('codicon-modifier-spin');
		part.foot.prepend(busy);
		part.box.querySelectorAll<HTMLButtonElement>('.flow-foot button, .flow-actions button').forEach(b => b.disabled = true);
	}
	root.append(part.box);
}

// --- Open Merge Request

/** Branches GitLab found for the target menu's search, beyond those the view lists. */
let searchedBranches: TargetChoice[] = [];
/** The target menu of the current render, redrawn when searched branches arrive. */
let targetMenu: Menu | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

/** The target branch as a button that opens a themed menu with search: suggested, recent, release, then the rest. */
function targetPicker(view: OpenMrView): HTMLElement {
	const anchor = button('flow-target-button', '', () => undefined);
	anchor.append(icon('git-merge'), el('span', 'mono', view.target ?? strings.searchBranches), icon('chevron-down'));
	setTip(anchor, view.target ?? strings.searchBranches);
	const list = el('div', 'flow-menu');
	list.hidden = true;
	const holder = el('span', 'flow-menu-holder');
	holder.append(anchor, list);
	let lastQuery = '';
	const menu: Menu = new Menu({
		element: list,
		anchor,
		label: strings.targetHeading,
		search: () => strings.searchBranches,
		sections: query => {
			if (query !== lastQuery) {
				lastQuery = query;
				clearTimeout(searchTimer);
				if (query.trim() && view.moreTargets) {
					searchTimer = setTimeout(() => act('searchTargets', query.trim()), 300);
				}
			}
			const row = (t: TargetChoice, detail?: string) => ({
				name: t.branch,
				...detail ? { detail } : {},
				checked: t.branch === view.target,
				run: () => {
					menu.close();
					act('target', t.branch);
				},
			});
			const all = [...view.targets, ...searchedBranches.filter(b => !view.targets.some(t => t.branch === b.branch))];
			const suggested = all.filter(t => t.suggested || t.projectDefault);
			const recent = all.filter(t => t.recent && !suggested.includes(t));
			const releases = all.filter(t => t.release && !suggested.includes(t) && !recent.includes(t));
			const rest = all.filter(t => !suggested.includes(t) && !recent.includes(t) && !releases.includes(t));
			return [
				{ heading: strings.targetSuggested, rows: suggested.map(t => row(t, t.fixVersion ? format(strings.fixVersion, t.fixVersion) : t.projectDefault ? strings.projectDefault : undefined)) },
				{ heading: strings.targetRecent, rows: recent.map(t => row(t)) },
				{ heading: strings.targetRelease, rows: releases.map(t => row(t)) },
				{ heading: strings.targetOther, rows: rest.map(t => row(t)) },
			].filter(section => section.rows.length);
		},
		empty: () => strings.noBranches,
	});
	targetMenu = menu;
	disposables.push(menu, { dispose: () => targetMenu === menu ? targetMenu = undefined : undefined });
	return holder;
}

function openMr(view: OpenMrView): ReturnType<typeof dialog> {
	const route = el('span', 'flow-route');
	const source = el('span', 'mono flow-source', view.source);
	setTip(source, view.source);
	route.append(source);
	if (!view.reviewOf) {
		route.append(icon('arrow-right'), targetPicker(view));
	}
	route.append(el('span', 'muted end', view.project));
	const d = dialog('gitlab', strings.openMr, route);
	if (view.reviewOf) {
		const reviewOf = view.reviewOf;
		d.body.append(el('div', 'flow-note', format(strings.reviewerBranch, reviewOf.iid)));
		d.foot.append(el('span', 'grow'),
			button('secondary', format(strings.openIn, 'GitLab'), () => act('openReviewed'), 'link-external'),
			button('secondary', format(strings.fixMr, reviewOf.iid), () => act('fixReviewed')),
			button('primary', strings.openReview, () => act('openReview')));
		return d;
	}
	if (view.unusualTarget) {
		const warn = el('div', 'flow-banner warn');
		warn.append(icon('warning'), el('span', undefined, view.unusualTarget));
		d.body.append(warn);
	}
	if (view.existing) {
		const note = el('div', 'flow-note');
		note.append(el('span', undefined, format(strings.existingMr, view.existing.iid)), button('link', format(strings.openIn, 'GitLab'), () => act('openExisting'), 'link-external'));
		d.body.append(note);
	}
	d.body.append(heading(strings.title), textField('title', view.title));
	const regenerate = button('link', strings.regenerate, () => act('regenerate'), 'sparkle');
	regenerate.disabled = view.generating;
	d.body.append(heading(strings.description, regenerate));
	const description = textField('description', view.description, { multiline: true, rev: view.descriptionRev }) as HTMLTextAreaElement;
	description.rows = 12;
	description.disabled = view.generating;
	if (view.generating) {
		description.placeholder = strings.generating;
	}
	d.body.append(description);
	d.body.append(view.describedFor && view.target ? el('p', 'hint warn', format(strings.describedFor, view.describedFor, view.target)) : el('p', 'hint', strings.descriptionHint));
	d.body.append(heading(strings.attachments), el('p', 'hint', strings.attachmentsHint));
	for (const a of view.attachments) {
		const label = el('span', 'flow-attachment');
		label.append(icon(a.icon), ...(a.tools ?? []).map(t => toolLogo(t, 13)), el('span', undefined, a.name));
		d.body.append(checkbox(label, a.checked, on => set(`attach:${a.id}`, on), a.detail));
	}
	d.body.append(button('link', strings.addFile, () => act('addFile'), 'add'));
	const options = el('div', 'flow-options');
	if (view.ticket) {
		const jira = el('span');
		jira.append(document.createTextNode(format(strings.updateJira, '')), toolLogo('jira', 13), document.createTextNode(` ${view.ticket.key}`));
		options.append(checkbox(jira, view.updateJira, on => set('updateJira', on), strings.updateJiraHint));
	}
	options.append(checkbox(strings.deleteBranch, view.deleteBranch, on => set('deleteBranch', on)), checkbox(strings.draft, view.draft, on => set('draft', on)));
	d.body.append(options, people(view.reviewers, view.members, ids => act('reviewers', ids)));
	const submit = button('primary', strings.openMr, () => act('submit'));
	submit.disabled = !view.target;
	d.foot.append(el('span', 'hint', format(strings.pushesAs, view.host, view.account)), el('span', 'grow'),
		button('secondary', strings.cancel, () => act('close')), submit);
	return d;
}

// --- Move Ticket and Log Time

function moveTicket(view: MoveTicketView): ReturnType<typeof dialog> {
	const sub = el('span', 'flow-route');
	sub.append(button('link', view.key, () => act('open')), el('span', undefined, view.summary), el('span', `pill ${view.statusTone}`, view.status));
	const d = dialog('jira', view.mode === 'log' ? strings.logTime : strings.moveTicket, sub);
	if (view.done) {
		const done = el('div', 'flow-done');
		done.append(icon('pass-filled'), el('span', undefined, view.done));
		d.body.append(done);
		d.foot.append(el('span', 'grow'), button('primary', strings.close, () => act('close')));
		return d;
	}
	let logOn = view.logTime;
	if (view.mode === 'move') {
		d.body.append(heading(strings.moveTo));
		if (!view.transitions.length) {
			d.body.append(el('p', 'hint', strings.noMoves));
		}
		const list = el('div', 'flow-list');
		for (const t of view.transitions) {
			const row = el('label', `flow-radio${t.id === view.selected ? ' on' : ''}`);
			const radio = el('input');
			radio.type = 'radio';
			radio.name = 'transition';
			radio.checked = t.id === view.selected;
			radio.addEventListener('change', () => act('select', t.id));
			row.append(radio, el('span', `pill ${t.tone}`, t.to));
			if (t.name !== t.to) {
				row.append(el('span', 'muted', t.name));
			}
			list.append(row);
		}
		d.body.append(list);
		const selected = view.transitions.find(t => t.id === view.selected);
		for (const field of selected?.fields ?? []) {
			const label = field.required ? format(strings.fieldNeeded, field.name) : field.name;
			d.body.append(heading(label));
			const value = view.fieldValues[field.id] ?? '';
			d.body.append(field.allowed
				? choice(label, value, [{ value: '', text: strings.choose }, ...field.allowed.map(a => ({ value: a.id, text: a.name }))], v => set(`field:${field.id}`, v))
				: textField(`field:${field.id}`, value));
		}
		if (selected) {
			d.body.append(checkbox(strings.addComment, view.addComment, on => set('addComment', on)));
			const comment = textField('comment', view.comment, { multiline: true, rev: view.commentRev, onInput: () => set('commentEdited', true) }) as HTMLTextAreaElement;
			comment.rows = 4;
			comment.disabled = view.generating;
			if (view.generating) {
				comment.placeholder = strings.generating;
			}
			d.body.append(comment, el('p', 'hint', `${strings.commentHint} ${view.visibility ? format(strings.visibleTo, view.visibility) : strings.everyone}`));
		}
	}
	const log = el('div', 'flow-log');
	const fields = el('div', 'flow-log-fields');
	const spent = textField('spent', view.spent, { placeholder: strings.timeSpentPlaceholder }) as HTMLInputElement;
	const bad = el('span', 'hint error', strings.badTime);
	bad.hidden = true;
	spent.addEventListener('input', () => {
		bad.hidden = !spent.value.trim() || /^(\d+(\.\d+)?\s*[wdhm]\s*)+$/i.test(spent.value.trim());
	});
	const date = el('input', 'flow-input');
	date.type = 'date';
	date.value = view.date;
	date.addEventListener('change', () => set('date', date.value));
	const spentBox = el('label', 'flow-field');
	spentBox.append(el('span', undefined, strings.timeSpent), spent);
	const dateBox = el('label', 'flow-field');
	dateBox.append(el('span', undefined, strings.date), date);
	fields.append(spentBox, dateBox);
	const workComment = textField('workComment', view.workComment, { placeholder: strings.workComment });
	log.append(fields, bad, workComment);
	if (view.mode === 'move') {
		log.hidden = !logOn;
		d.body.append(checkbox(strings.logTime, view.logTime, on => {
			logOn = on;
			log.hidden = !on;
			set('logTime', on);
			submit.replaceChildren(el('span', undefined, on ? strings.moveAndLog : strings.move));
		}, view.logged ? `${strings.logTimeHint} ${view.logged}.` : strings.logTimeHint));
	} else {
		d.body.append(heading(strings.logTime), el('p', 'hint', view.logged ? `${strings.logTimeHint} ${view.logged}.` : strings.logTimeHint));
	}
	d.body.append(log);
	const submit = button('primary', view.mode === 'log' ? strings.logIt : logOn ? strings.moveAndLog : strings.move, () => act('submit'));
	d.foot.append(el('span', 'grow'), button('secondary', strings.cancel, () => act('close')), submit);
	return d;
}

// --- Review

const kindNames: Record<string, () => string> = { bug: () => strings.kindBug, shouldFix: () => strings.kindShouldFix, nit: () => strings.kindNit, question: () => strings.kindQuestion };
const kindTones: Record<string, string> = { bug: 'error', shouldFix: 'warn', nit: 'muted', question: 'info' };

function spinner(text: string): HTMLElement {
	const row = el('span', 'flow-spinner');
	row.append(icon('loading'), el('span', undefined, text));
	row.querySelector('.codicon')?.classList.add('codicon-modifier-spin');
	return row;
}

/** A file and line, shortened, with the full path in its tooltip. */
function where(short: string, full: string | undefined): HTMLElement {
	const node = el('span', 'mono muted flow-where', short);
	if (full) {
		setTip(node, full);
	}
	return node;
}

function commentCard(c: ReviewCommentView, view: ReviewView, sync: () => void): HTMLElement {
	const card = el('div', `flow-finding${c.by === 'you' ? ' mine' : ''}`);
	const top = el('div', 'flow-finding-top');
	const box = el('input');
	box.type = 'checkbox';
	box.checked = c.checked;
	box.dataset.finding = c.by;
	box.addEventListener('change', () => {
		set(`check:${c.id}`, box.checked);
		sync();
	});
	top.append(box, c.by === 'you' ? el('span', 'pill info', strings.you) : el('span', `pill ${kindTones[c.kind ?? 'shouldFix']}`, kindNames[c.kind ?? 'shouldFix']()));
	top.append(c.where ? where(c.where, c.path) : el('span', 'muted', strings.generalComment));
	if (c.lineChanged) {
		const changed = el('span', 'pill warn', strings.lineChanged);
		setTip(changed, strings.lineChangedHint);
		top.append(changed);
	}
	top.append(el('span', 'grow'));
	if (c.where) {
		top.append(button('link', strings.openDiff, () => act('openDiff', c.id)));
	}
	if (c.by === 'you') {
		const remove = button('icon-button', '', () => act('deleteComment', c.id), 'trash');
		setTip(remove, strings.deleteComment);
		top.append(remove);
	}
	card.append(top);
	if (c.title && c.by === 'gemini') {
		card.append(el('div', 'flow-finding-title', c.title));
	}
	const comment = textField(`comment:${c.id}`, c.comment, { multiline: true, rev: view.rev }) as HTMLTextAreaElement;
	comment.rows = Math.min(6, Math.max(2, Math.ceil(c.comment.length / 90)));
	card.append(comment);
	if (c.suggestion) {
		const s = c.suggestion;
		const block = el('div', 'flow-suggestion');
		if (s.old) {
			block.append(el('pre', 'flow-suggestion-old', s.old));
		}
		const text = textField(`suggestion:${c.id}`, s.text, { multiline: true, rev: view.rev, mono: true }) as HTMLTextAreaElement;
		text.classList.add('flow-suggestion-new');
		text.rows = Math.min(10, Math.max(1, s.text.split('\n').length));
		block.append(text);
		const row = el('div', 'flow-suggestion-row');
		row.append(checkbox(strings.includeSuggestion, s.include, on => set(`include:${c.id}`, on)));
		if (s.by === 'gemini') {
			row.append(el('span', 'pill muted', strings.byGemini));
		}
		row.append(el('span', 'grow'), button('link', strings.removeSuggestion, () => act('removeSuggestion', c.id)));
		block.append(row, el('p', 'hint', strings.suggestionHint));
		card.append(block);
	}
	if (c.canSuggest || c.suggesting || c.suggestNote) {
		const actions = el('div', 'flow-finding-actions');
		if (c.suggesting) {
			actions.append(spinner(strings.suggesting));
		} else if (c.canSuggest) {
			if (!c.suggestion) {
				actions.append(button('link', strings.addSuggestion, () => act('addSuggestion', c.id), 'add'));
			}
			if (view.agentId) {
				actions.append(button('link', c.suggestion?.by === 'gemini' ? strings.askSuggestionAgain : strings.askSuggestion, () => act('askSuggestion', c.id), 'sparkle'));
			}
		}
		if (c.suggestNote) {
			actions.append(el('span', 'hint', c.suggestNote));
		}
		card.append(actions);
	}
	return card;
}

function threadCard(t: ReviewThreadView, view: ReviewView, sync: () => void): HTMLElement {
	const card = el('div', 'flow-thread');
	const top = el('div', 'flow-finding-top');
	top.append(el('strong', undefined, t.notes[0]?.author ?? ''), t.where ? where(t.where, t.path) : el('span', 'muted', strings.generalComment));
	if (t.outdated) {
		top.append(el('span', 'pill warn', strings.outdated));
	} else if (t.removedLine) {
		top.append(el('span', 'pill muted', strings.removedLine));
	}
	top.append(el('span', 'grow'), button('link', t.onLine ? strings.openDiff : format(strings.openIn, 'GitLab'), () => act('openThread', t.id), t.onLine ? undefined : 'link-external'));
	card.append(top);
	for (const note of t.notes.slice(-3)) {
		const n = el('div', 'flow-thread-note');
		n.append(el('span', 'muted', [note.author, note.when].filter(Boolean).join(' · ')), el('div', 'flow-thread-body', note.body));
		card.append(n);
	}
	const reply = t.reply;
	if (reply) {
		const box = el('div', 'flow-finding mine');
		const head = el('div', 'flow-finding-top');
		const tick = el('input');
		tick.type = 'checkbox';
		tick.checked = reply.checked;
		tick.dataset.reply = '1';
		tick.addEventListener('change', () => {
			set(`rcheck:${reply.id}`, tick.checked);
			sync();
		});
		head.append(tick, el('span', `pill ${reply.by === 'you' ? 'info' : 'muted'}`, reply.by === 'you' ? strings.yourReply : strings.geminiReply), el('span', 'grow'));
		if (t.resolvable) {
			head.append(checkbox(strings.resolveThread, reply.resolve, on => set(`resolve:${reply.id}`, on)));
		}
		const remove = button('icon-button', '', () => act('deleteReply', reply.id), 'trash');
		setTip(remove, strings.deleteReply);
		head.append(remove);
		const text = textField(`reply:${reply.id}`, reply.text, { multiline: true, rev: view.rev }) as HTMLTextAreaElement;
		text.rows = 2;
		box.append(head, text);
		card.append(box);
	} else {
		const actions = el('div', 'flow-finding-actions');
		actions.append(button('link', strings.reply, () => act('reply', t.id), 'reply'));
		if (t.resolvable) {
			actions.append(button('link', strings.resolve, () => act('resolve', t.id), 'check'));
		}
		card.append(actions);
	}
	return card;
}

function review(view: ReviewView): ReturnType<typeof dialog> {
	const sub = el('span', 'flow-route');
	sub.append(el('span', undefined, view.mr.author), el('span', 'mono', view.mr.source), icon('arrow-right'), el('span', 'mono', view.mr.target));
	if (view.mr.head) {
		sub.append(el('span', 'mono muted', view.mr.head));
	}
	sub.append(button('link', format(strings.openIn, 'GitLab'), () => act('openGitLab'), 'link-external'));
	const d = dialog('gitlab', `!${view.mr.iid} ${view.mr.title}`, sub);
	d.box.classList.add('wide');
	if (view.moved) {
		const banner = el('div', 'flow-banner warn');
		banner.append(icon('git-commit'), el('span', 'grow', view.moved), button('secondary small', strings.refresh, () => act('refresh'), 'refresh'));
		d.body.append(banner);
	}
	const columns = el('div', 'flow-columns');
	const main = el('div', 'flow-main');
	const side = el('aside', 'flow-side');
	columns.append(main, side);
	d.body.append(columns);
	const actions = el('div', 'flow-actions');
	const hint = el('p', 'hint');
	const postRequest = button('primary wide', '', () => act('post', 'request'));
	const postOnly = button('secondary wide', '', () => act('post', 'comments'));
	const approve = button('secondary wide', '', () => act('post', 'approve'), 'check');
	const syncPost = () => {
		const ticked = [...d.box.querySelectorAll<HTMLInputElement>('input[data-finding], input[data-reply]')].filter(b => b.checked);
		const gemini = ticked.filter(b => b.dataset.finding === 'gemini').length;
		const you = ticked.filter(b => b.dataset.finding === 'you').length;
		const replies = ticked.filter(b => b.dataset.reply).length;
		const n = ticked.length;
		hint.textContent = format(strings.yourReviewHint, gemini, you, replies);
		postRequest.replaceChildren(el('span', undefined, n === 1 ? strings.postAndRequestOne : format(strings.postAndRequestMany, n)));
		postOnly.replaceChildren(el('span', undefined, n === 1 ? strings.postOne : format(strings.postMany, n)));
		approve.replaceChildren(icon('check'), el('span', undefined, view.approvedByMe && !n ? strings.approved : !n ? strings.approve : n === 1 ? strings.postAndApproveOne : format(strings.postAndApproveMany, n)));
		postRequest.disabled = postOnly.disabled = !n || view.state === 'preparing';
		approve.disabled = view.state === 'preparing' || (view.approvedByMe && !n);
	};
	if (view.state === 'preparing' || view.state === 'reviewing') {
		const row = el('div', 'flow-finding-actions');
		row.append(spinner(view.state === 'preparing' ? strings.preparing : strings.reviewing));
		if (view.state === 'reviewing') {
			row.append(el('span', 'grow'), button('link', strings.readAgain, () => act('readAgain'), 'refresh'));
		}
		main.append(row);
	}
	if (view.summary) {
		const summary = el('p', 'flow-summary');
		summary.append(toolLogoSpark(), el('strong', undefined, `${strings.geminiReview} `), document.createTextNode(view.summary));
		main.append(summary);
	}
	if (view.state === 'unparsed') {
		main.append(el('div', 'flow-note', strings.unparsed), button('secondary', strings.readAgain, () => act('readAgain'), 'refresh'));
	} else if (view.state === 'ready' && !view.comments.length) {
		main.append(el('p', 'hint', strings.noFindings));
	}
	for (const c of view.comments) {
		main.append(commentCard(c, view, syncPost));
	}
	if (view.state !== 'preparing') {
		main.append(button('flow-add', strings.addReviewComment, () => act('addComment'), 'add'));
	}
	if (view.threads.length || view.resolvedThreads) {
		main.append(heading(strings.threads, el('span', 'hint', format(strings.threadCounts, view.threads.filter(t => !t.reply).length, view.resolvedThreads))));
		for (const t of view.threads) {
			main.append(threadCard(t, view, syncPost));
		}
	}
	for (const row of view.side) {
		const line = el('div', 'flow-side-row');
		const label = el('span', 'flow-side-label');
		label.append(logo(row.tool), el('strong', undefined, row.label));
		if (row.detail) {
			label.append(el('span', 'muted', row.detail));
		}
		line.append(label);
		const p = pill(row.pill);
		if (p) {
			line.append(p);
		}
		side.append(line);
	}
	side.append(el('h2', undefined, strings.yourReview));
	actions.append(postRequest, postOnly, approve);
	side.append(hint, actions);
	if (view.done) {
		const done = el('div', 'flow-done');
		done.append(icon('pass-filled'), el('span', undefined, view.done));
		side.append(done);
	}
	if (view.files.length) {
		side.append(el('h2', 'quiet', strings.files));
		for (const file of view.files) {
			const row = button('flow-file', '', () => act('openFile', file.path));
			const name = el('span', 'name');
			if (file.dir) {
				name.append(el('span', 'dir', file.dir));
			}
			name.append(document.createTextNode(file.name));
			row.append(name);
			if (file.comments) {
				const count = el('span', 'count');
				count.append(icon('comment'), el('span', undefined, String(file.comments)));
				row.append(count);
			}
			row.append(el('span', 'added', `+${file.added}`), el('span', 'removed', `\u2212${file.removed}`));
			setTip(row, file.path);
			side.append(row);
		}
		if (view.moreFiles) {
			side.append(el('p', 'hint', format(strings.moreFiles, view.moreFiles)));
		}
	}
	if (view.agentGone) {
		d.foot.append(button('secondary', strings.askGeminiAgain, () => act('askAgain'), 'sparkle'));
	} else if (view.agentId) {
		d.foot.append(button('secondary', strings.openAgent, () => act('openAgent')));
	}
	syncPost();
	return d;
}

function toolLogoSpark(): HTMLElement {
	const spark = icon('sparkle');
	spark.classList.add('accent');
	return spark;
}

// --- Checks

function checks(view: ChecksView): ReturnType<typeof dialog> {
	// The title names the branch; the line under it says where the checks run and what the setup did.
	const sub = el('span', 'flow-route');
	if (view.where) {
		sub.append(el('span', 'mono muted', [view.where, view.setup].filter(Boolean).join(' · ')));
	} else {
		sub.append(el('span', undefined, view.agentTitle));
	}
	const d = dialog(view.rows.some(r => r.tool === 'snyk' && r.state !== 'off') ? 'snyk' : 'sonar', `${strings.checksTitle}: ${view.branch ?? view.agentTitle}`, sub);
	const rows = el('div', 'flow-list boxed');
	for (const row of view.rows) {
		const line = el('div', `flow-target ${row.state}`);
		const label = el('span', 'flow-target-name');
		label.append(toolLogo(row.tool, 15), el('strong', undefined, row.name), el('span', 'muted', row.detail));
		line.append(label, el('span', 'grow'));
		if (row.state === 'running') {
			const spin = icon('loading');
			spin.classList.add('codicon-modifier-spin');
			line.append(spin);
		}
		const p = pill(row.pill);
		if (p) {
			line.append(p);
		}
		rows.append(line);
	}
	d.body.append(rows);
	if (view.sent) {
		const done = el('div', 'flow-done');
		done.append(icon('pass-filled'), el('span', undefined, view.sent));
		d.body.append(done);
	}
	for (const f of view.findings) {
		const card = el('div', 'flow-finding compact');
		const top = el('div', 'flow-finding-top');
		const box = el('input');
		box.type = 'checkbox';
		box.checked = f.checked;
		box.dataset.finding = f.id;
		box.addEventListener('change', () => {
			set(`check:${f.id}`, box.checked);
			syncFix();
		});
		top.append(box, toolLogo(f.source === 'sonar' ? 'sonar' : 'snyk', 13), el('span', `pill ${f.severity === 'critical' || f.severity === 'high' || f.severity === 'blocker' ? 'error' : f.severity === 'medium' || f.severity === 'major' ? 'warn' : 'muted'}`, f.severity),
			el('span', 'flow-finding-title', f.title), el('span', 'grow'), button('secondary small', strings.fix, () => act('fix', f.id)));
		card.append(top);
		const meta = el('div', 'muted mono small');
		meta.textContent = [f.where, f.fix].filter(Boolean).join(' · ');
		card.append(meta);
		d.body.append(card);
	}
	// Without an agent on the branch, Fix starts one there.
	const allLabel = view.agentId ? strings.fixAll : strings.fixAllNew;
	const chosenLabel = view.agentId ? strings.fixChosen : strings.fixChosenNew;
	const fixAll = button('primary', allLabel, () => act('fixAll'));
	const syncFix = () => {
		const n = [...d.body.querySelectorAll<HTMLInputElement>('input[data-finding]')].filter(b => b.checked).length;
		fixAll.replaceChildren(el('span', undefined, n === view.findings.length ? allLabel : format(chosenLabel, n)));
		fixAll.disabled = !n;
	};
	syncFix();
	if (!view.findings.length && view.rows.every(r => r.state !== 'running')) {
		d.body.append(el('p', 'hint', strings.noIssues));
	}
	if (!view.agentId && view.findings.length) {
		d.foot.append(el('span', 'hint', strings.fixNote));
	}
	d.foot.append(el('span', 'grow'), button('secondary', strings.runAgain, () => act('again'), 'refresh'), fixAll);
	return d;
}

window.addEventListener('message', (event: MessageEvent<ToTeamFlow>) => {
	if (event.data.type === 'state') {
		render(event.data.state);
	} else if (event.data.type === 'branches') {
		const known = new Set(searchedBranches.map(b => b.branch));
		searchedBranches = [...searchedBranches, ...event.data.branches.filter(b => !known.has(b.branch))];
		targetMenu?.render();
	}
});

vscode.postMessage({ type: 'ready' });
