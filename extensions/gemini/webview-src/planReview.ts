/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Plan Review's page (src/host/planReviewPage.ts): an agent's plan rendered
// section by section. Clicking a section (or Enter on it) edits its Markdown
// in place, while the agent isn't working; the + in its margin, or Comment
// over selected text, adds a comment. Comments
// show in a panel beside the plan, or under their sections in a narrow
// column, and the footer sends them all to Gemini or builds the plan. The
// Markdown is rendered by the chunk Agent Home's Preview loads
// (draftMarkdown.js), so this page carries no Markdown parser.

import { planSections, type PlanComment, type PlanSection } from '../src/acp/planReview';
import type { FromPlan, PlanStrings, PlanView, ToPlan } from '../src/host/planReviewProtocol';
import { button, el, format, icon, pageStrings } from './panelDom';
import { setTip } from './tooltip';

declare function acquireVsCodeApi(): { postMessage(message: FromPlan): void };

const vscode = acquireVsCodeApi();
const strings = pageStrings<PlanStrings>();
const page = document.getElementById('page')!;
const markdownUrl = document.querySelector<HTMLScriptElement>('script[data-draft-markdown]')?.dataset.draftMarkdown;

let view: PlanView | undefined;
let renderMarkdown: ((text: string) => Node[]) | undefined;
/**
 * The section being edited: what is typed so far, and the section's text it
 * began from, which the host checks the file still has before saving.
 * `conflict`: the agent changed the section meanwhile, and `original` is its
 * new text; `showNew` shows it.
 */
let editing: { section: string; text: string; original: string; conflict?: boolean; showNew?: boolean } | undefined;
/** The section a new comment is being written on, and what it quotes. */
let commenting: { section: string; quote: string; text: string } | undefined;
/** A comment whose text is being changed. */
let changing: { id: string; text: string } | undefined;
let saving = false;
/** Shown until the user does something next; `errorText` is an edit that couldn't be saved. */
let error = '';
let errorText: string | undefined;
/** A new view came while the user was typing: it is drawn when they finish. */
let pending = false;
let selectionButton: HTMLElement | undefined;

function post(message: FromPlan): void {
	error = '';
	errorText = undefined;
	vscode.postMessage(message);
}

window.addEventListener('message', (event: MessageEvent<ToPlan>) => {
	const message = event.data;
	switch (message.type) {
		case 'view':
			view = message.view;
			if (typing()) {
				pending = true;
			} else {
				render();
			}
			return;
		case 'saved':
			saving = false;
			return;
		case 'error':
			saving = false;
			error = message.message;
			errorText = message.text;
			render();
			return;
		case 'conflict':
			saving = false;
			// Back in the editor, unless the user is busy with another edit: then the text shows in the banner.
			if (!editing || editing.section === message.section || editing.text === editing.original) {
				editing = { section: message.section, text: message.mine, original: message.theirs, conflict: true };
				render();
				focusEditor();
			} else {
				error = strings.conflict;
				errorText = message.mine;
				render();
			}
			return;
	}
});

/** Whether the user is typing in a section or a comment, which a redraw would interrupt. */
function typing(): boolean {
	const active = document.activeElement as HTMLTextAreaElement | null;
	return !!active && active.tagName === 'TEXTAREA' && !active.readOnly && page.contains(active);
}

/** Sections aren't edited while the agent works: it may be changing them. */
function locked(): boolean {
	return !!view && (view.revising || view.busy);
}

function focusEditor(): void {
	page.querySelector<HTMLTextAreaElement>('.plan-editor textarea')?.focus();
}

function done(): void {
	if (pending) {
		pending = false;
	}
	render();
}

async function loadMarkdown(): Promise<void> {
	if (!markdownUrl) {
		return;
	}
	try {
		// eslint-disable-next-line no-restricted-syntax
		const module = await import(/* webpackIgnore: true */ markdownUrl) as { renderDraft(text: string, label: (kind: string) => string): Node[] };
		renderMarkdown = text => module.renderDraft(text, kind => kind.charAt(0).toUpperCase() + kind.slice(1));
		render();
	} catch {
		// The plan shows as text.
	}
}

function render(): void {
	if (!view) {
		return;
	}
	hideSelectionButton();
	const sections = planSections(view.markdown);
	const open = view.comments.filter(comment => !comment.sentAt);
	page.replaceChildren(header(view, open.length), ...banner(view), body(view, sections), footer(view, open.length));
}

function header(v: PlanView, open: number): HTMLElement {
	const head = el('header', 'plan-head');
	const file = button('plan-file', v.file, () => post({ type: 'openSource' }), 'markdown');
	setTip(file, strings.openSource);
	head.append(el('h1', 'plan-title', v.title), file);
	if (v.agent) {
		head.append(pill('plan', format(strings.from, v.agent)));
	}
	head.append(el('span', 'spacer'));
	if (saving) {
		head.append(pill('', strings.saving));
	} else if (v.edited.length) {
		head.append(pill('', v.edited.length === 1 ? strings.editedOne : format(strings.editedMany, v.edited.length)));
	}
	if (v.comments.length) {
		head.append(pill('cm', open === 1 || (!open && v.comments.length === 1) ? strings.commentsOne : format(strings.commentsMany, open || v.comments.length)));
	}
	return head;
}

function pill(tone: string, text: string): HTMLElement {
	const node = el('span', `plan-pill${tone ? ` ${tone}` : ''}`);
	if (tone === 'plan') {
		node.append(el('span', 'plan-dot'));
	}
	node.append(el('span', undefined, text));
	return node;
}

function banner(v: PlanView): HTMLElement[] {
	const nodes: HTMLElement[] = [];
	if (error) {
		const node = el('div', 'plan-banner error');
		node.append(el('span', 'plan-banner-text', error));
		if (errorText !== undefined) {
			const kept = errorText;
			const area = el('textarea', 'plan-kept');
			area.readOnly = true;
			area.value = kept;
			area.rows = Math.min(12, kept.split('\n').length + 1);
			node.append(button('secondary', strings.copyText, () => void navigator.clipboard.writeText(kept), 'copy'), area);
		}
		nodes.push(node);
	}
	if (v.revising) {
		const node = el('div', 'plan-banner');
		node.append(el('span', 'plan-spin'), el('span', undefined, strings.revising));
		nodes.push(node);
	} else if (v.comments.some(comment => comment.sentAt)) {
		const node = el('div', 'plan-banner ok');
		const text = v.changed.length === 1 ? strings.revisedOne : v.changed.length ? format(strings.revisedMany, v.changed.length) : strings.revisedNone;
		node.append(icon('check'), el('span', 'plan-banner-text', text),
			button('secondary', strings.showChanges, () => post({ type: 'showChanges' })),
			button('secondary', strings.clearSent, () => post({ type: 'clearSent' })));
		nodes.push(node);
	}
	return nodes;
}

function body(v: PlanView, sections: readonly PlanSection[]): HTMLElement {
	const node = el('div', 'plan-body');
	const sheet = el('article', 'plan-sheet');
	if (!sections.length) {
		sheet.append(el('p', 'plan-empty', v.missing ? strings.missing : strings.empty));
	}
	for (const section of sections) {
		sheet.append(sectionNode(v, section));
	}
	if (editing && !sections.some(section => section.id === editing!.section)) {
		// The section went while it was being edited: the editor stays, and Done says so, keeping the text.
		sheet.append(sectionNode(v, { id: editing.section, markdown: editing.original, opening: '', start: 0, end: 0 }));
	}
	sheet.addEventListener('mouseup', () => setTimeout(offerSelection, 0));
	node.append(sheet, rail(v, sections));
	return node;
}

function sectionNode(v: PlanView, section: PlanSection): HTMLElement {
	const comments = v.comments.filter(comment => comment.section === section.id);
	const node = el('section', 'plan-sec');
	node.dataset.section = section.id;
	node.classList.toggle('has-cm', comments.some(comment => !comment.sentAt));
	node.classList.toggle('edited', v.edited.includes(section.id));
	node.classList.toggle('changed', v.changed.includes(section.id));
	if (v.changed.includes(section.id)) {
		node.append(el('span', 'plan-changed-tag', strings.changedTag));
	} else if (comments.length) {
		const count = el('span', 'plan-count');
		count.append(icon('comment'), el('span', undefined, String(comments.length)));
		node.append(count);
	}
	const add = button('plan-add', '', () => startComment(section.id, section.opening || section.heading || ''), 'add');
	setTip(add, strings.addTip);
	node.append(add);
	if (editing?.section === section.id) {
		node.append(editor());
	} else {
		const content = el('div', 'plan-content');
		content.append(...renderMarkdown ? renderMarkdown(section.markdown) : [el('pre', 'plan-source', section.markdown)]);
		content.tabIndex = 0;
		content.setAttribute('role', 'button');
		content.setAttribute('aria-disabled', String(locked()));
		content.addEventListener('click', event => {
			// A link, or the end of a text selection, is not a request to edit.
			if (!(event.target as HTMLElement).closest('a') && !String(getSelection() ?? '').trim()) {
				startEdit(section);
			}
		});
		content.addEventListener('keydown', event => {
			if ((event.key === 'Enter' || event.key === ' ') && event.target === content) {
				event.preventDefault();
				startEdit(section);
			}
		});
		setTip(content, locked() ? strings.editBusy : strings.editTip);
		node.append(content);
	}
	// Under the section: its comments, for a narrow column, and the box for a new one.
	const inline = el('div', 'plan-inline');
	for (const comment of comments) {
		inline.append(commentCard(comment, false));
	}
	if (commenting?.section === section.id) {
		inline.append(commentBox());
	}
	node.append(inline);
	return node;
}

/** Edits `section`; an edit open on another section is saved first, not dropped. */
function startEdit(section: PlanSection): void {
	if (locked() || editing?.section === section.id) {
		return;
	}
	saveEdit();
	editing = { section: section.id, text: section.markdown, original: section.markdown };
	render();
	focusEditor();
}

/** Closes the editor, saving what changed. */
function saveEdit(): void {
	const edit = editing;
	editing = undefined;
	if (edit && edit.text !== edit.original) {
		saving = true;
		post({ type: 'saveSection', section: edit.section, markdown: edit.text, original: edit.original });
	}
}

function editor(): HTMLElement {
	const box = el('div', 'plan-editor');
	const edit = editing!;
	if (edit.conflict) {
		const notice = el('div', 'plan-conflict');
		notice.append(el('span', undefined, strings.conflict), button('link-button', edit.showNew ? strings.hideNew : strings.showNew, () => {
			edit.showNew = !edit.showNew;
			render();
			focusEditor();
		}));
		box.append(notice);
		if (edit.showNew) {
			box.append(el('pre', 'plan-source plan-theirs', edit.original));
		}
	}
	const area = el('textarea');
	area.value = edit.text;
	area.rows = Math.min(30, Math.max(4, area.value.split('\n').length + 1));
	area.spellcheck = true;
	area.addEventListener('input', () => {
		edit.text = area.value;
	});
	const save = () => {
		if (!locked()) {
			saveEdit();
			done();
		}
	};
	const cancel = () => {
		editing = undefined;
		done();
	};
	area.addEventListener('keydown', event => {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			save();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			cancel();
		}
	});
	const saveButton = button('primary', strings.save, save);
	// Kept open while the agent works, with what is typed; saved once its turn ends.
	saveButton.disabled = locked();
	if (saveButton.disabled) {
		setTip(saveButton, strings.editBusy);
	}
	const row = el('div', 'plan-row');
	row.append(el('span', 'plan-hint', strings.editHint), button('secondary', strings.cancel, cancel), saveButton);
	box.append(area, row);
	return box;
}

/** Opens the box for a new comment; an edit open meanwhile stays open. */
function startComment(section: string, quote: string): void {
	commenting = { section, quote, text: '' };
	render();
	page.querySelector<HTMLTextAreaElement>('.plan-comment-box textarea')?.focus();
}

function commentBox(): HTMLElement {
	const box = el('div', 'plan-comment-box');
	if (commenting!.quote) {
		box.append(el('div', 'plan-quote', commenting!.quote));
	}
	const area = el('textarea');
	area.placeholder = strings.commentPlaceholder;
	area.rows = 3;
	area.value = commenting!.text;
	area.addEventListener('input', () => {
		commenting!.text = area.value;
	});
	const add = () => {
		const text = area.value.trim();
		if (text) {
			post({ type: 'addComment', section: commenting!.section, quote: commenting!.quote, text });
		}
		commenting = undefined;
		done();
	};
	const cancel = () => {
		commenting = undefined;
		done();
	};
	area.addEventListener('keydown', event => {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			add();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			cancel();
		}
	});
	const row = el('div', 'plan-row');
	row.append(el('span', 'plan-hint', strings.addHint), button('secondary', strings.cancel, cancel), button('primary', strings.addComment, add));
	box.append(area, row);
	return box;
}

function commentCard(comment: PlanComment, inRail: boolean): HTMLElement {
	const card = el('div', `plan-cm${comment.sentAt ? ' sent' : ''}`);
	card.dataset.comment = comment.id;
	const where = format(strings.onSection, comment.heading ?? comment.quote);
	card.append(el('div', 'plan-cm-on', comment.sentAt ? `${where} · ${strings.sent}` : where));
	if (changing?.id === comment.id) {
		const area = el('textarea');
		area.value = changing.text;
		area.rows = 3;
		area.addEventListener('input', () => {
			changing!.text = area.value;
		});
		const save = () => {
			const text = area.value.trim();
			if (text) {
				post({ type: 'editComment', id: comment.id, text });
			}
			changing = undefined;
			done();
		};
		area.addEventListener('keydown', event => {
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				save();
			} else if (event.key === 'Escape') {
				changing = undefined;
				done();
			}
		});
		const row = el('div', 'plan-row');
		row.append(button('secondary', strings.cancel, () => {
			changing = undefined;
			done();
		}), button('primary', strings.save, save));
		card.append(area, row);
		return card;
	}
	const text = el('div', 'plan-cm-text', comment.text);
	card.append(text);
	if (!comment.sentAt) {
		const actions = el('div', 'plan-cm-acts');
		actions.append(button('link-button', strings.edit, () => {
			changing = { id: comment.id, text: comment.text };
			render();
			// The card clicked: the same comment shows both in the panel and, hidden in a wide column, under its section.
			page.querySelector<HTMLTextAreaElement>(`${inRail ? '.plan-rail' : '.plan-inline'} .plan-cm[data-comment="${CSS.escape(comment.id)}"] textarea`)?.focus();
		}), button('link-button', strings.delete, () => post({ type: 'deleteComment', id: comment.id })));
		card.append(actions);
	}
	if (inRail) {
		// From the panel, a click (or Enter) shows the section it is about.
		const show = () => page.querySelector(`.plan-sec[data-section="${CSS.escape(comment.section)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
		text.tabIndex = 0;
		text.setAttribute('role', 'button');
		text.addEventListener('click', show);
		text.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				show();
			}
		});
		setTip(text, strings.showSection);
	}
	return card;
}

function rail(v: PlanView, sections: readonly PlanSection[]): HTMLElement {
	const node = el('aside', 'plan-rail');
	const open = v.comments.filter(comment => !comment.sentAt).length;
	const head = el('div', 'plan-rail-head');
	head.append(el('span', undefined, strings.commentsHead), el('span', undefined, open ? format(strings.toSend, open) : v.comments.length ? strings.allSent : ''));
	node.append(head);
	// In the plan's order.
	const order = new Map(sections.map((section, i) => [section.id, i]));
	const sorted = [...v.comments].sort((a, b) => (order.get(a.section) ?? 1e9) - (order.get(b.section) ?? 1e9) || a.createdAt - b.createdAt);
	for (const comment of sorted) {
		node.append(commentCard(comment, true));
	}
	if (!v.comments.length) {
		node.append(el('p', 'plan-rail-empty', strings.addTip));
	}
	return node;
}

function footer(v: PlanView, open: number): HTMLElement {
	const foot = el('footer', 'plan-foot');
	foot.append(el('span', 'plan-foot-text', strings.foot));
	const build = button(open ? 'secondary' : 'primary', '', () => post({ type: 'build' }), 'play');
	build.append(el('span', 'wide', strings.build), el('span', 'short', strings.buildShort));
	build.disabled = !v.canBuild || v.busy;
	if (build.disabled) {
		setTip(build, strings.buildBusy);
	}
	const send = button(open ? 'primary' : 'secondary', '', () => post({ type: 'send' }), 'comment-discussion');
	send.append(el('span', 'wide', strings.send), el('span', 'short', strings.sendShort));
	if (open) {
		send.append(el('span', 'plan-n', String(open)));
	}
	send.disabled = !open;
	foot.append(build, send);
	return foot;
}

/** Comment over text selected in one section, quoting it. */
function offerSelection(): void {
	hideSelectionButton();
	const selection = getSelection();
	const text = String(selection ?? '').trim();
	if (!selection || !text || selection.rangeCount === 0) {
		return;
	}
	const range = selection.getRangeAt(0);
	const start = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest<HTMLElement>('.plan-sec');
	const end = (range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement)?.closest<HTMLElement>('.plan-sec');
	if (!start || start !== end || !start.dataset.section) {
		return;
	}
	const box = range.getBoundingClientRect();
	const section = start.dataset.section;
	selectionButton = button('plan-select-comment', strings.comment, () => {
		getSelection()?.removeAllRanges();
		startComment(section, text.length > 160 ? `${text.slice(0, 160)}…` : text);
	}, 'comment');
	selectionButton.style.top = `${Math.max(4, box.top + scrollY - 34)}px`;
	selectionButton.style.left = `${Math.max(4, box.left + scrollX)}px`;
	document.body.append(selectionButton);
}

function hideSelectionButton(): void {
	selectionButton?.remove();
	selectionButton = undefined;
}

document.addEventListener('mousedown', event => {
	if (selectionButton && !selectionButton.contains(event.target as Node)) {
		hideSelectionButton();
	}
});

void loadMarkdown();
post({ type: 'ready' });
