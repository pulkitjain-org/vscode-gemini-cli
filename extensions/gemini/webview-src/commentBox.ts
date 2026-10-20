/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Home's comment box for a Jira ticket, a chunk of its own that Home loads
// the first time the box opens, so Home's startup script stays small. The
// comment is Markdown, shown in Preview as Jira will show it, with a toolbar
// for Jira's formatting, @ to mention people who can see the ticket, files to
// attach (picked, dropped or pasted) and who may see it. The extension posts
// it as Jira rich text through Jira's REST API (teamTools.ts, jira_rich_comment).

import type { AdfDocument, CommentMention } from '../src/acp/jiraAdf';
import type { FromHome, HomeAction, HomeStrings, ToHome } from '../src/host/panelProtocol';
import { attachmentIcon, carriesFiles, fileUris } from './chatLogic';
import { continueList, insertBlock, insertLink, mentionAt, toggleLinePrefix, toggleWrap, type TextEdit } from './markdownEdit';
import { createPreviewTabs, isPreviewShortcut } from './markdownPreview';
import { applyTextEdit, button, el, format, icon, readFileBase64 } from './panelDom';
import { toolLogo } from './toolLogos';
import { setTip } from './tooltip';

/** What the box needs from Home. */
export interface CommentBoxHost {
	readonly strings: HomeStrings;
	post(message: FromHome): void;
	/** Preview's renderer, Home's own. */
	renderMarkdown(text: string): Promise<Node[]>;
	/** The comment as Jira rich text, from the same chunk as Preview's renderer. */
	toAdf(text: string, mentions: readonly CommentMention[]): Promise<AdfDocument>;
}

export interface CommentBox {
	open(action: Extract<HomeAction, { kind: 'comment' }>): void;
	/** The extension's answers for the box: people, visibility choices, files, and how the post went. */
	onMessage(message: Extract<ToHome, { type: 'commented' | 'commentPeople' | 'commentOptions' | 'commentFiles' }>): void;
}

const mac = /Mac/.test(navigator.platform);

export function createCommentBox(host: CommentBoxHost): CommentBox {
	const strings = host.strings;
	const commentDialog = el('dialog', 'dash-comment-dialog');
	const commentForm = el('form', 'dash-comment-body');
	const commentHead = el('div', 'dash-card-head dash-list-head');
	const commentTitle = el('h2');
	commentTitle.id = 'dash-comment-title';
	commentDialog.setAttribute('aria-labelledby', commentTitle.id);
	const commentSummary = el('p', 'dash-comment-summary muted');
	const commentEditor = el('div', 'dash-comment-editor');
	const commentTop = el('div', 'dash-comment-top');
	const commentTabs = el('div', 'composer-tabs dash-comment-tabs');
	commentTabs.setAttribute('role', 'tablist');
	const commentWriteTab = el('button', 'composer-tab');
	const commentPreviewTab = el('button', 'composer-tab');
	for (const tab of [commentWriteTab, commentPreviewTab]) {
		tab.type = 'button';
		tab.setAttribute('role', 'tab');
	}
	commentTabs.append(commentWriteTab, commentPreviewTab);
	// Write is the tab in front until Preview is picked; the tabs' helper marks it from then on.
	commentWriteTab.setAttribute('aria-selected', 'true');
	commentPreviewTab.setAttribute('aria-selected', 'false');
	commentPreviewTab.tabIndex = -1;
	const commentToolbar = el('div', 'dash-comment-toolbar');
	commentToolbar.setAttribute('role', 'toolbar');
	commentToolbar.setAttribute('aria-label', strings.commentFormatting);
	commentTop.append(commentTabs, commentToolbar);
	const commentText = el('textarea', 'dash-comment-text');
	commentText.rows = 8;
	commentText.placeholder = strings.commentPlaceholder;
	commentText.setAttribute('aria-label', strings.commentPlaceholder);
	const commentPreview = el('div', 'composer-preview markdown dash-comment-preview');
	commentPreview.tabIndex = 0;
	commentPreview.hidden = true;
	const commentPeople = el('div', 'dash-comment-people');
	commentPeople.setAttribute('role', 'listbox');
	commentPeople.hidden = true;
	commentEditor.append(commentTop, commentText, commentPreview, commentPeople);
	const commentFiles = el('div', 'attachments dash-comment-files');
	const commentError = el('p', 'dash-comment-error');
	commentError.setAttribute('role', 'alert');
	const commentVisibility = el('select', 'dash-comment-visibility');
	commentVisibility.setAttribute('aria-label', strings.commentVisibleTo);
	const commentVisibilityLabel = el('label', 'dash-comment-visible');
	commentVisibilityLabel.append(icon('lock'), el('span', undefined, strings.commentVisibleTo), commentVisibility);
	const commentCancel = button('secondary', strings.cancel, () => commentDialog.close());
	const commentPost = el('button', 'primary', strings.commentPost);
	commentPost.type = 'submit';
	const commentBar = el('div', 'dash-comment-bar');
	commentBar.append(commentVisibilityLabel, el('span', 'spacer'), commentCancel, commentPost);
	const commentNote = el('p', 'dash-comment-note muted');
	commentForm.append(commentHead, commentSummary, commentEditor, commentFiles, commentError, commentBar, commentNote);
	commentDialog.append(commentForm);
	document.body.append(commentDialog);
	const toast = el('div', 'dash-toast');
	toast.setAttribute('role', 'status');
	toast.hidden = true;
	document.body.append(toast);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	/** A file to attach: on disk, or pasted or dropped without a path. */
	type CommentFile = { readonly name: string; readonly size: number } & ({ readonly kind: 'path'; readonly path: string } | { readonly kind: 'data'; readonly data: string });

	/** What was written for a ticket, kept while Home is open, so closing the box loses nothing. */
	interface CommentDraft {
		text: string;
		mentions: CommentMention[];
		files: CommentFile[];
		visibility?: string;
	}

	/** Files read here to send with the comment, at most: bigger ones go by the paperclip, as paths. */
	const maxPastedBytes = 20 * 1024 * 1024;
	let commentKey: string | undefined;
	let commentPosting = false;
	let commentDefaultRole: string | undefined;
	const commentDrafts = new Map<string, CommentDraft>();

	function commentDraft(): CommentDraft | undefined {
		if (!commentKey) {
			return undefined;
		}
		let draft = commentDrafts.get(commentKey);
		if (!draft) {
			draft = { text: '', mentions: [], files: [] };
			commentDrafts.set(commentKey, draft);
		}
		return draft;
	}

	const commentPreviewTabs = createPreviewTabs({
		input: commentText,
		inputWrap: commentText,
		preview: commentPreview,
		writeTab: commentWriteTab,
		previewTab: commentPreviewTab,
		form: commentEditor,
		strings,
		render: text => host.renderMarkdown(text),
	});

	/** Applies a toolbar or shortcut edit, as one step the user can undo. */
	function editComment(edit: (value: string, start: number, end: number) => TextEdit): void {
		commentPreviewTabs.close();
		commentText.focus();
		applyTextEdit(commentText, edit(commentText.value, commentText.selectionStart, commentText.selectionEnd));
	}

	/** An @ at the caret, after a space when it follows a word, so the people list opens. */
	function startMention(value: string, start: number, end: number): TextEdit {
		const text = start > 0 && !/\s/.test(value[start - 1]) ? ' @' : '@';
		return { start, end, text, selectionStart: start + text.length, selectionEnd: start + text.length };
	}

	/** Keys as this platform writes them: ⌘B on a Mac, Ctrl+B elsewhere. */
	const keys = (key: string, shift = false) => mac ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;
	/** A themed tooltip and the accessible name: the name, with the keys that do the same when there are some. */
	const tip = (node: HTMLElement, label: string, detail = label) => {
		node.setAttribute('aria-label', label);
		setTip(node, detail);
		return node;
	};
	const withKeys = (label: string, key: string, shift = false) => format(strings.commentShortcut, label, keys(key, shift));

	/** Each button: its icon, its name, its tooltip, and what it does. */
	const commentTools: readonly (readonly [string, string, string, () => void] | 'gap')[] = [
		['bold', strings.commentBold, withKeys(strings.commentBold, 'B'), () => editComment((v, s, e) => toggleWrap(v, s, e, '**'))],
		['italic', strings.commentItalic, withKeys(strings.commentItalic, 'I'), () => editComment((v, s, e) => toggleWrap(v, s, e, '_'))],
		['strike', strings.commentStrike, withKeys(strings.commentStrike, 'X', true), () => editComment((v, s, e) => toggleWrap(v, s, e, '~~'))],
		['code', strings.commentCode, withKeys(strings.commentCode, 'E'), () => editComment((v, s, e) => toggleWrap(v, s, e, '`'))],
		['link', strings.commentLink, withKeys(strings.commentLink, 'K'), () => editComment(insertLink)],
		'gap',
		['list-unordered', strings.commentBullets, strings.commentTipBullets, () => editComment((v, s, e) => toggleLinePrefix(v, s, e, 'bullet'))],
		['list-ordered', strings.commentNumbers, strings.commentTipNumbers, () => editComment((v, s, e) => toggleLinePrefix(v, s, e, 'number'))],
		['tasklist', strings.commentTasks, strings.commentTipTasks, () => editComment((v, s, e) => toggleLinePrefix(v, s, e, 'task'))],
		['quote', strings.commentQuote, strings.commentTipQuote, () => editComment((v, s, e) => toggleLinePrefix(v, s, e, 'quote'))],
		['info', strings.commentPanel, strings.commentTipPanel, () => editComment((v, s, e) => insertBlock(v, s, e, 'callout'))],
		['file-code', strings.commentCodeBlock, strings.commentTipCodeBlock, () => editComment((v, s, e) => insertBlock(v, s, e, 'code'))],
		['table', strings.commentTable, strings.commentTipTable, () => editComment((v, s, e) => insertBlock(v, s, e, 'table'))],
		['horizontal-rule', strings.commentRule, strings.commentTipRule, () => editComment((v, s, e) => insertBlock(v, s, e, 'rule'))],
		'gap',
		['mention', strings.commentMention, strings.commentTipMention, () => editComment(startMention)],
		['file-add', strings.commentAttach, strings.commentTipAttach, () => host.post({ type: 'commentFiles' })],
	];
	commentToolbar.replaceChildren(...commentTools.map(tool => {
		if (tool === 'gap') {
			return el('span', 'dash-comment-gap');
		}
		const [name, label, detail, run] = tool;
		// No codicon for strikethrough: a struck-through S.
		return tip(name === 'strike' ? button('icon-button dash-comment-strike', 'S', run) : button('icon-button', '', run, name), label, detail);
	}));
	// The tabs' own tooltips: what Write is for, and Preview with its keys.
	tip(commentWriteTab, strings.writeLabel, strings.commentTipWrite);
	tip(commentPreviewTab, strings.previewLabel, format(strings.commentShortcut, strings.previewLabel, mac ? '⇧⌘V' : 'Ctrl+Shift+V'));
	tip(commentVisibility, strings.commentVisibleTo, strings.commentTipVisibility);
	tip(commentCancel, strings.cancel, strings.commentTipCancel);
	tip(commentPost, strings.commentPost, withKeys(strings.commentPost, mac ? '↩' : 'Enter'));

	function openComment(action: Extract<HomeAction, { kind: 'comment' }>): void {
		commentKey = action.key;
		commentDefaultRole = action.visibility;
		const draft = commentDraft()!;
		commentHead.replaceChildren(toolLogo('jira', 16), commentTitle, tip(button('icon-button dash-list-close', '', () => commentDialog.close(), 'close'), strings.close, strings.commentTipCancel));
		commentTitle.textContent = format(strings.commentTitle, action.key);
		commentSummary.textContent = action.title;
		commentNote.textContent = strings.commentHelp;
		commentText.value = draft.text;
		renderCommentFiles();
		renderVisibility([], []);
		commentPreviewTabs.close();
		closePeople();
		setCommentPosting(false);
		commentError.textContent = '';
		commentDialog.showModal();
		commentText.focus();
		host.post({ type: 'commentOptions', key: action.key });
	}

	/** Everyone, the team's role, and the project's roles and the user's groups once Jira says. */
	function renderVisibility(roles: readonly string[], groups: readonly string[]): void {
		const draft = commentDraft();
		const option = (value: string, label: string) => {
			const node = el('option', undefined, label);
			node.value = value;
			return node;
		};
		const allRoles = [...new Set([...commentDefaultRole ? [commentDefaultRole] : [], ...roles])];
		const nodes: HTMLElement[] = [option('everyone', strings.commentEveryone)];
		if (allRoles.length) {
			const group = el('optgroup');
			group.label = strings.commentRoles;
			group.append(...allRoles.map(role => option(`role:${role}`, role)));
			nodes.push(group);
		}
		if (groups.length) {
			const group = el('optgroup');
			group.label = strings.commentGroups;
			group.append(...groups.map(name => option(`group:${name}`, name)));
			nodes.push(group);
		}
		commentVisibility.replaceChildren(...nodes);
		commentVisibility.value = draft?.visibility ?? (commentDefaultRole ? `role:${commentDefaultRole}` : 'everyone');
	}

	commentVisibility.addEventListener('change', () => {
		const draft = commentDraft();
		if (draft) {
			draft.visibility = commentVisibility.value;
		}
	});

	function setCommentPosting(posting: boolean): void {
		commentPosting = posting;
		commentText.readOnly = posting;
		const draft = commentDraft();
		commentPost.disabled = posting || !draft || (!commentText.value.trim() && !draft.files.length);
		commentPost.textContent = posting ? strings.commentPosting : strings.commentPost;
	}

	function showToast(text: string): void {
		clearTimeout(toastTimer);
		toast.textContent = text;
		toast.hidden = false;
		toastTimer = setTimeout(() => toast.hidden = true, 3000);
	}

	function renderCommentFiles(): void {
		const draft = commentDraft();
		const files = draft?.files ?? [];
		commentFiles.hidden = !files.length;
		commentFiles.replaceChildren(...files.map(file => {
			const chip = el('span', 'chip attachment');
			setTip(chip, file.kind === 'path' ? file.path : file.name);
			chip.append(icon(attachmentIcon(/\.(png|jpe?g|gif|webp|svg)$/i.test(file.name) ? 'image' : 'document', file.name)), el('span', undefined, file.name), el('span', 'muted', formatSize(file.size)));
			chip.append(tip(button('chip-remove', '', () => {
				draft!.files = draft!.files.filter(f => f !== file);
				renderCommentFiles();
			}, 'close'), format(strings.commentRemoveFile, file.name)));
			return chip;
		}));
		setCommentPosting(commentPosting);
	}

	function formatSize(bytes: number): string {
		return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	function addCommentFiles(files: readonly CommentFile[]): void {
		const draft = commentDraft();
		if (!draft) {
			return;
		}
		draft.files = [...draft.files, ...files.filter(file => !draft.files.some(f => f.kind === 'path' && file.kind === 'path' && f.path === file.path))];
		renderCommentFiles();
	}

	/** Files from a paste or a drop: ones with paths by their URIs, others read here. */
	function takeCommentFiles(data: DataTransfer | null): boolean {
		if (!data) {
			return false;
		}
		const uris = fileUris(data.getData('application/vnd.code.uri-list') || data.getData('text/uri-list'));
		if (uris.length) {
			host.post({ type: 'commentFiles', uris });
			return true;
		}
		const files = [...data.files];
		if (!files.length) {
			return false;
		}
		void Promise.all(files.map(async (file): Promise<CommentFile | undefined> => {
			const name = file.name || `pasted-${Date.now()}.${file.type.split('/')[1] || 'bin'}`;
			if (file.size > maxPastedBytes) {
				commentError.textContent = format(strings.commentTooLarge, name);
				return undefined;
			}
			return { kind: 'data', name, size: file.size, data: await readFileBase64(file) };
		})).then(read => addCommentFiles(read.filter((f): f is CommentFile => !!f)));
		return true;
	}

	commentText.addEventListener('paste', event => {
		if (event.clipboardData?.files.length && takeCommentFiles(event.clipboardData)) {
			event.preventDefault();
		}
	});
	commentDialog.addEventListener('dragover', event => {
		if (event.dataTransfer && carriesFiles([...event.dataTransfer.types])) {
			event.preventDefault();
			event.dataTransfer.dropEffect = 'copy';
			commentEditor.classList.add('dragging');
		}
	});
	commentDialog.addEventListener('dragleave', event => {
		if (!event.relatedTarget || !commentDialog.contains(event.relatedTarget as Node)) {
			commentEditor.classList.remove('dragging');
		}
	});
	commentDialog.addEventListener('drop', event => {
		commentEditor.classList.remove('dragging');
		if (takeCommentFiles(event.dataTransfer)) {
			event.preventDefault();
		}
	});
	commentEditor.dataset.drop = strings.commentDrop;

	// --- @ mentions: people who can see the ticket, from Jira, as they type.

	let peopleQuestion = 0;
	let peopleStart = -1;
	let peopleActive = 0;
	let peopleFound: { readonly accountId: string; readonly name: string; readonly email?: string }[] = [];
	let peopleTimer: ReturnType<typeof setTimeout> | undefined;

	function closePeople(): void {
		clearTimeout(peopleTimer);
		peopleStart = -1;
		peopleFound = [];
		commentPeople.hidden = true;
		commentText.removeAttribute('aria-activedescendant');
	}

	/** Looks up the @mention at the caret, a moment after the last key. */
	function updatePeople(): void {
		const at = commentKey && commentText.selectionStart === commentText.selectionEnd ? mentionAt(commentText.value, commentText.selectionStart) : undefined;
		if (!at) {
			closePeople();
			return;
		}
		peopleStart = at.start;
		clearTimeout(peopleTimer);
		if (commentPeople.hidden) {
			commentPeople.replaceChildren(el('div', 'dash-comment-person muted', strings.commentSearching));
			commentPeople.hidden = false;
		}
		const id = ++peopleQuestion;
		peopleTimer = setTimeout(() => host.post({ type: 'commentPeople', key: commentKey!, query: at.query, id }), 150);
	}

	function renderPeople(): void {
		if (!peopleFound.length) {
			commentPeople.replaceChildren(el('div', 'dash-comment-person muted', strings.commentNoPeople));
			return;
		}
		peopleActive = Math.min(peopleActive, peopleFound.length - 1);
		commentPeople.replaceChildren(...peopleFound.map((person, i) => {
			const row = el('div', `dash-comment-person${i === peopleActive ? ' active' : ''}`);
			row.id = `dash-comment-person-${i}`;
			row.setAttribute('role', 'option');
			row.setAttribute('aria-selected', String(i === peopleActive));
			row.append(icon('account'), el('span', undefined, person.name), ...person.email ? [el('span', 'muted', person.email)] : []);
			row.addEventListener('mousedown', event => event.preventDefault());
			row.addEventListener('click', () => pickPerson(person));
			return row;
		}));
		commentText.setAttribute('aria-activedescendant', `dash-comment-person-${peopleActive}`);
	}

	/** Puts `@Name ` in place of what was typed after @, and remembers who that is. */
	function pickPerson(person: { readonly accountId: string; readonly name: string }): void {
		const draft = commentDraft();
		if (!draft || peopleStart < 0) {
			return;
		}
		const start = peopleStart;
		const end = commentText.selectionStart;
		closePeople();
		if (!draft.mentions.some(m => m.accountId === person.accountId && m.name === person.name)) {
			draft.mentions.push({ accountId: person.accountId, name: person.name });
		}
		const text = `@${person.name} `;
		applyTextEdit(commentText, { start, end, text, selectionStart: start + text.length, selectionEnd: start + text.length });
	}

	function onPeopleKey(event: KeyboardEvent): boolean {
		if (commentPeople.hidden || !peopleFound.length) {
			if (event.key === 'Escape' && !commentPeople.hidden) {
				closePeople();
				return true;
			}
			return false;
		}
		switch (event.key) {
			case 'ArrowDown':
			case 'ArrowUp':
				peopleActive = (peopleActive + (event.key === 'ArrowDown' ? 1 : peopleFound.length - 1)) % peopleFound.length;
				renderPeople();
				return true;
			case 'Enter':
			case 'Tab':
				pickPerson(peopleFound[peopleActive]);
				return true;
			case 'Escape':
				closePeople();
				return true;
			default:
				return false;
		}
	}

	function onCommentPeople(id: number, people: readonly { readonly accountId: string; readonly name: string; readonly email?: string }[]): void {
		if (id !== peopleQuestion || peopleStart < 0) {
			return;
		}
		peopleFound = [...people];
		peopleActive = 0;
		renderPeople();
	}

	commentText.addEventListener('input', () => {
		const draft = commentDraft();
		if (draft) {
			draft.text = commentText.value;
		}
		setCommentPosting(commentPosting);
		updatePeople();
	});
	commentText.addEventListener('click', updatePeople);
	commentText.addEventListener('blur', () => setTimeout(() => document.activeElement !== commentText && closePeople(), 0));
	commentText.addEventListener('keydown', event => {
		if (event.isComposing) {
			return;
		}
		if (onPeopleKey(event)) {
			event.preventDefault();
			// Escape closes the list, not the box.
			event.stopPropagation();
			return;
		}
		if (isPreviewShortcut(event)) {
			event.preventDefault();
			commentPreviewTabs.toggle();
			return;
		}
		const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
		if (mod && event.key === 'Enter') {
			event.preventDefault();
			commentForm.requestSubmit();
			return;
		}
		if (!mod || event.altKey) {
			if (event.key === 'Enter' && event.shiftKey && commentText.selectionStart === commentText.selectionEnd) {
				const edit = continueList(commentText.value, commentText.selectionStart);
				if (edit) {
					event.preventDefault();
					applyTextEdit(commentText, edit);
				}
			}
			return;
		}
		const marker = event.shiftKey ? (event.code === 'KeyX' ? '~~' : undefined) : event.code === 'KeyB' ? '**' : event.code === 'KeyI' ? '_' : event.code === 'KeyE' ? '`' : undefined;
		if (marker) {
			event.preventDefault();
			editComment((v, s, e) => toggleWrap(v, s, e, marker));
		} else if (!event.shiftKey && event.code === 'KeyK') {
			event.preventDefault();
			editComment(insertLink);
		}
	});
	// Escape with the people list open closes the list only.
	commentDialog.addEventListener('cancel', event => {
		if (!commentPeople.hidden) {
			event.preventDefault();
			closePeople();
		}
	});

	commentForm.addEventListener('submit', event => {
		event.preventDefault();
		const draft = commentDraft();
		const markdown = commentText.value;
		if (!commentKey || !draft || (!markdown.trim() && !draft.files.length) || commentPosting) {
			return;
		}
		commentError.textContent = '';
		closePeople();
		setCommentPosting(true);
		const key = commentKey;
		const chosen = commentVisibility.value;
		const visibility = chosen === 'everyone' ? 'everyone' as const : /^(role|group):/.test(chosen) ? { type: chosen.startsWith('role:') ? 'role' as const : 'group' as const, value: chosen.replace(/^(role|group):/, '') } : undefined;
		// Only the people still named in the text.
		void host.toAdf(markdown, draft.mentions.filter(m => markdown.includes(`@${m.name}`))).then(document => host.post({
			type: 'comment', key, markdown, document,
			files: draft.files.flatMap(f => f.kind === 'path' ? [f.path] : []),
			pasted: draft.files.flatMap(f => f.kind === 'data' ? [{ name: f.name, data: f.data }] : []),
			...visibility ? { visibility } : {},
		}), (err: unknown) => onCommented(key, err instanceof Error ? err.message : String(err)));
	});
	// Closing while it posts leaves the post to finish; the toast or the draft says how it went.
	commentDialog.addEventListener('close', () => {
		closePeople();
		commentKey = commentPosting ? commentKey : undefined;
	});
	commentDialog.addEventListener('click', event => {
		if (event.target === commentDialog && !commentPosting) {
			commentDialog.close();
		}
	});

	function onCommented(key: string, error: string | undefined): void {
		const current = key === commentKey;
		if (error) {
			if (current && commentDialog.open) {
				setCommentPosting(false);
				commentError.textContent = error;
			} else {
				showToast(error);
			}
			return;
		}
		commentDrafts.delete(key);
		if (current) {
			commentPosting = false;
			commentKey = undefined;
			commentDialog.close();
		}
		showToast(format(strings.commentPosted, key));
	}

	return {
		open: openComment,
		onMessage: message => {
			switch (message.type) {
				case 'commented':
					return onCommented(message.key, message.error);
				case 'commentPeople':
					return onCommentPeople(message.id, message.people);
				case 'commentOptions':
					if (message.key === commentKey) {
						renderVisibility(message.roles, message.groups);
					}
					return;
				case 'commentFiles':
					return addCommentFiles(message.files.map(file => ({ kind: 'path' as const, ...file })));
			}
		},
	};
}
