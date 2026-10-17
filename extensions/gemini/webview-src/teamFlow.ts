/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The team flows' page (src/host/teamFlows.ts): Open Merge Request, Move
// Ticket and Log Time, Review, Merge Release Branch Forward, and Checks.
// The host holds the state and re-renders with `state`; what the user types
// goes back with `set`, without a re-render, so typing is never interrupted.

import type { ChecksView, FlowPerson, FlowPill, FlowTool, FromTeamFlow, MoveTicketView, OpenMrView, ReleaseView, ReviewView, TeamFlowState, TeamFlowStrings, ToTeamFlow } from '../src/host/teamFlowProtocol';
import { Menu } from './menu';
import { button, el, format, icon, pageStrings } from './panelDom';
import { selectMenu } from './selectMenu';
import { toolLogo } from './toolLogos';

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

function render(state: TeamFlowState): void {
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
				: view.kind === 'release' ? release(view)
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

function openMr(view: OpenMrView): ReturnType<typeof dialog> {
	const route = el('span', 'flow-route');
	route.append(el('span', 'mono', view.source), icon('arrow-right'));
	if (view.step === 'details' && view.target) {
		route.append(el('span', 'mono accent', view.target), button('link', strings.change, () => act('back')));
	}
	route.append(el('span', 'muted end', view.project));
	const d = dialog('gitlab', strings.openMr, route);
	if (view.existing) {
		const note = el('div', 'flow-note');
		note.append(el('span', undefined, format(strings.existingMr, view.existing.iid)), button('link', format(strings.openIn, 'GitLab'), () => act('openExisting'), 'link-external'));
		d.body.append(note);
	}
	if (view.step === 'target') {
		d.body.append(heading(strings.targetHeading), el('p', 'hint', strings.targetHint));
		const list = el('div', 'flow-list');
		for (const t of view.targets) {
			const row = el('label', `flow-radio${t.branch === view.target ? ' on' : ''}`);
			const radio = el('input');
			radio.type = 'radio';
			radio.name = 'target';
			radio.checked = t.branch === view.target;
			radio.addEventListener('change', () => act('target', t.branch));
			row.append(radio, el('span', 'mono', t.branch));
			if (t.suggested) {
				row.append(el('span', 'pill info', view.ticket ? `${strings.suggested} ${view.ticket.fixVersions.join(', ')}`.trim() : strings.suggested));
			} else if (t.release) {
				row.append(el('span', 'pill muted', strings.release));
			}
			list.append(row);
		}
		d.body.append(list);
		d.foot.append(el('span', 'hint', format(strings.pushesAs, view.host, view.account)), el('span', 'grow'),
			button('secondary', strings.cancel, () => act('close')), button('primary', strings.next, () => act('next')));
		return d;
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
	d.body.append(description, el('p', 'hint', strings.descriptionHint));
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
	d.foot.append(el('span', 'hint', format(strings.pushesAs, view.host, view.account)), el('span', 'grow'),
		button('secondary', strings.back, () => act('back')), button('primary', strings.openMr, () => act('submit')));
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

function review(view: ReviewView): ReturnType<typeof dialog> {
	const sub = el('span', 'flow-route');
	sub.append(el('span', undefined, view.mr.author), el('span', 'mono', view.mr.source), icon('arrow-right'), el('span', 'mono', view.mr.target), button('link', format(strings.openIn, 'GitLab'), () => act('openGitLab'), 'link-external'));
	const d = dialog('gitlab', `!${view.mr.iid} ${view.mr.title}`, sub);
	d.box.classList.add('wide');
	const columns = el('div', 'flow-columns');
	const main = el('div', 'flow-main');
	const side = el('aside', 'flow-side');
	columns.append(main, side);
	d.body.append(columns);
	if (view.state === 'preparing' || view.state === 'reviewing') {
		const p = el('div', 'flow-loading');
		p.append(icon('loading'), el('span', undefined, view.state === 'preparing' ? strings.preparing : strings.reviewing));
		p.querySelector('.codicon')?.classList.add('codicon-modifier-spin');
		main.append(p);
	} else {
		if (view.summary) {
			const summary = el('p', 'flow-summary');
			summary.append(toolLogoSpark(), el('strong', undefined, `${strings.geminiReview} `), document.createTextNode(view.summary));
			main.append(summary);
		}
		if (view.state === 'unparsed') {
			main.append(el('div', 'flow-note', strings.unparsed), button('secondary', strings.readAgain, () => act('readAgain'), 'refresh'));
		} else if (!view.findings.length) {
			main.append(el('p', 'hint', strings.noFindings));
		}
		for (const f of view.findings) {
			const card = el('div', 'flow-finding');
			const top = el('div', 'flow-finding-top');
			const box = el('input');
			box.type = 'checkbox';
			box.checked = f.checked;
			box.addEventListener('change', () => {
				set(`check:${f.id}`, box.checked);
				syncPost();
			});
			box.dataset.finding = f.id;
			top.append(box, el('span', `pill ${kindTones[f.kind]}`, kindNames[f.kind]()));
			if (f.file) {
				top.append(el('span', 'mono muted', `${f.file}${f.line ? `:${f.line}` : ''}`));
			}
			top.append(el('span', 'grow'));
			if (f.file) {
				top.append(button('link', strings.openDiff, () => act('openDiff', f.id)));
			}
			const comment = textField(`comment:${f.id}`, f.comment, { multiline: true, rev: view.findingsRev }) as HTMLTextAreaElement;
			comment.rows = Math.min(6, Math.max(2, Math.ceil(f.comment.length / 90)));
			card.append(top, el('div', 'flow-finding-title', f.title), comment);
			main.append(card);
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
	const actions = el('div', 'flow-actions');
	side.append(el('h2', undefined, strings.yourReview));
	const hint = el('p', 'hint');
	const postRequest = button('primary wide', '', () => act('post', 'request'));
	const postOnly = button('secondary wide', '', () => act('post', 'comments'));
	const approve = button('secondary wide', view.approvedByMe ? strings.approved : strings.approve, () => act('post', 'approve'), 'check');
	approve.disabled = view.approvedByMe;
	const syncPost = () => {
		const n = [...main.querySelectorAll<HTMLInputElement>('input[data-finding]')].filter(b => b.checked).length;
		hint.textContent = format(strings.yourReviewHint, n);
		postRequest.replaceChildren(el('span', undefined, format(strings.postAndRequest, n)));
		postOnly.replaceChildren(el('span', undefined, format(strings.post, n)));
		postRequest.disabled = postOnly.disabled = !n || view.state !== 'ready' && view.state !== 'unparsed';
	};
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
			const row = el('div', 'flow-file');
			row.append(el('span', 'name', file.path.split('/').pop() ?? file.path), el('span', 'added', `+${file.added}`), el('span', 'removed', `\u2212${file.removed}`));
			row.title = file.path;
			side.append(row);
		}
	}
	if (view.agentId) {
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

// --- Merge Release Branch Forward

function release(view: ReleaseView): ReturnType<typeof dialog> {
	const d = dialog('gitlab', strings.releaseTitle);
	d.body.append(heading(strings.from));
	const from = choice(strings.from, view.source ?? '', view.sources.map(s => ({ value: s, text: s })), value => act('source', value));
	from.classList.add('mono');
	d.body.append(from);
	d.body.append(heading(strings.into), el('p', 'hint', strings.intoHint));
	const list = el('div', 'flow-list boxed');
	let ticked = 0;
	for (const t of view.targets) {
		const row = el('div', 'flow-target');
		const box = el('input');
		box.type = 'checkbox';
		box.checked = t.ticked;
		box.disabled = view.started || t.behind === 0;
		if (t.ticked) {
			ticked++;
		}
		box.addEventListener('change', () => {
			set(`tick:${t.branch}`, box.checked);
			ticked += box.checked ? 1 : -1;
			submit.replaceChildren(el('span', undefined, format(strings.openMrs, ticked)));
			submit.disabled = !ticked;
		});
		const name = el('label', 'flow-target-name');
		name.append(box, el('span', 'mono', t.branch));
		if (t.behind !== undefined) {
			name.append(el('span', 'muted', t.behind ? format(strings.behind, t.behind) : strings.upToDate));
		}
		row.append(name, el('span', 'grow'));
		if (t.result) {
			const result = el('span', `flow-result ${t.result.tone}`, t.result.text);
			row.append(result);
			if (t.result.url) {
				row.append(button('link', format(strings.openIn, 'GitLab'), () => act('openUrl', t.result!.url), 'link-external'));
			}
			if (t.result.agentId) {
				row.append(button('secondary small', strings.openAgent, () => act('openAgent', t.result!.agentId)));
			}
			if (t.result.canPush) {
				row.append(button('primary small', strings.pushResolution, () => act('push', t.branch)));
			}
		} else if (t.checking) {
			row.append(el('span', 'muted', strings.checking));
		} else if (t.clean === false) {
			const c = el('span', 'pill warn', format(strings.conflicts, t.conflicts.length));
			c.title = t.conflicts.join('\n');
			row.append(c);
		} else if (t.clean && t.behind) {
			const ok = el('span', 'pill ok');
			ok.append(icon('check'), el('span', undefined, strings.mergesCleanly));
			row.append(ok);
		}
		list.append(row);
	}
	d.body.append(list);
	const what = el('div', 'flow-note');
	what.append(el('strong', undefined, strings.whatHappens), el('p', undefined, strings.whatHappensText));
	d.body.append(what);
	if (view.tickets.length) {
		const shownTickets = view.tickets.slice(0, 3).join(', ') + (view.tickets.length > 3 ? ` +${view.tickets.length - 3}` : '');
		d.body.append(checkbox(format(strings.addTickets, (view.source ?? '').replace(/^.*\//, '')), view.addTickets, on => set('addTickets', on), shownTickets));
	}
	d.body.append(people(view.reviewers, view.members, ids => act('reviewers', ids)));
	const submit = button('primary', format(strings.openMrs, ticked), () => act('submit'));
	submit.disabled = !ticked || view.started || view.fetching;
	d.foot.append(el('span', 'grow'), button('secondary', view.started ? strings.close : strings.cancel, () => act('close')), submit);
	return d;
}

// --- Checks

function checks(view: ChecksView): ReturnType<typeof dialog> {
	const sub = el('span', 'flow-route');
	sub.append(el('span', undefined, view.agentTitle));
	if (view.branch) {
		sub.append(el('span', 'mono muted', view.branch));
	}
	const d = dialog(view.rows.some(r => r.tool === 'snyk' && r.state !== 'off') ? 'snyk' : 'sonar', strings.checksTitle, sub);
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
	const fixAll = button('primary', strings.fixAll, () => act('fixAll'));
	const syncFix = () => {
		const n = [...d.body.querySelectorAll<HTMLInputElement>('input[data-finding]')].filter(b => b.checked).length;
		fixAll.replaceChildren(el('span', undefined, n === view.findings.length ? strings.fixAll : format(strings.fixChosen, n)));
		fixAll.disabled = !n;
	};
	syncFix();
	if (!view.findings.length && view.rows.every(r => r.state !== 'running')) {
		d.body.append(el('p', 'hint', strings.noIssues));
	}
	d.foot.append(el('span', 'grow'), button('secondary', strings.runAgain, () => act('again'), 'refresh'), fixAll);
	return d;
}

window.addEventListener('message', (event: MessageEvent<ToTeamFlow>) => {
	if (event.data.type === 'state') {
		render(event.data.state);
	}
});

vscode.postMessage({ type: 'ready' });
