/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Review Page (src/host/confluenceReviewPage.ts): a Confluence page an
// agent drafted, edited in place as it will look, with a floating toolbar
// over selected text. For a new version of a page it opens on the page as it
// is now with the draft's changes marked, each kept or undone; publishing
// waits until each is, and sends only the kept ones. Blocks of the page the
// agent's Markdown can't write are never dropped (draftReview.ts). When
// someone saved the page since, it shows the draft combined with their
// version and asks only where both changed the same part. The agent's
// Markdown becomes the editor's document through the Markdown chunk Home's
// comment box loads (draftMarkdown.js), so this page carries no Markdown
// parser.

import type { AdfDocument } from '../src/acp/confluence';
import { blockChanges, mergeBlocks, type BlockPart, type MergeConflict } from '../src/acp/blockMerge';
import { confluenceSafe, holdBlocks, keepAllKeys, keepEdits, lostKinds, rewritesHeld, takeRewrite, undecided, undoBlocks, type DraftReview } from '../src/acp/draftReview';
import type { FromReview, ReviewStrings, ReviewView, ToReview } from '../src/host/confluenceReviewProtocol';
import { adfToHtml, htmlToAdf, textOf, type AdfView } from './adfHtml';
import { button, el, format, icon } from './panelDom';
import { bootPage } from './panelBoot';
import { setTip } from './tooltip';

const { strings, post, main: page, start } = bootPage<ToReview, FromReview, ReviewStrings>();
const markdownUrl = document.querySelector<HTMLScriptElement>('script[data-draft-markdown]')?.dataset.draftMarkdown;

type Mode = 'edit' | 'marked' | 'now' | 'changes';
type Change = Extract<BlockPart, { kind: 'change' }>;

let view: ReviewView | undefined;
let doc: AdfDocument = { type: 'doc', version: 1, content: [] };
let base: AdfDocument | undefined;
let baseVersion: number | undefined;
let title = '';
let mode: Mode = 'edit';
/** The changes kept, by key: kept ones show without marks, and only they are published. */
let kept = new Set<string>();
/** The page's blocks the agent's draft would have removed, put back, by block index in the page. */
let held: number[] = [];
/** Where the draft and the latest version both changed the same part, until the user picks. */
let conflicts: MergeConflict[] = [];
let editor: HTMLElement | undefined;
let published: { url: string; version: number } | undefined;
let busy = false;
let status: { text: string; tone: 'ok' | 'error' | '' } = { text: '', tone: '' };
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** The page and the draft compared, once for each pair. */
let compared: { readonly base: AdfDocument; readonly doc: AdfDocument; readonly parts: BlockPart[] } | undefined;

/** The page's blocks and the draft's changes to them; none for a new page. */
function parts(): BlockPart[] {
	if (!base) {
		return [];
	}
	if (compared?.base !== base || compared.doc !== doc) {
		compared = { base, doc, parts: blockChanges(base.content, doc.content) };
	}
	return compared.parts;
}

function changes(): Change[] {
	return parts().filter((part): part is Change => part.kind === 'change');
}

function review(): DraftReview {
	return { kept: [...kept], held, conflicts };
}

/** The editor's content, read back when it is open; the user's own edits there count as kept. */
function current(): AdfDocument {
	if (editor && mode === 'edit') {
		const before = parts();
		const at = new Map<number, number>();
		doc = htmlToAdf(editor, (element, index) => {
			if (element.dataset.conflict !== undefined) {
				at.set(Number(element.dataset.conflict), index);
			}
		});
		conflicts = conflicts.map((conflict, i) => at.has(i) ? { ...conflict, at: at.get(i)! } : conflict);
		if (base) {
			kept = keepEdits(before, parts(), kept);
		}
	}
	return doc;
}

function save(): void {
	clearTimeout(saveTimer);
	const document = current();
	post({ type: 'save', title, document, review: review() });
	refreshFooter();
}

function scheduleSave(): void {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(save, 800);
}

async function markdownToDoc(markdown: string): Promise<AdfDocument> {
	if (!markdownUrl) {
		return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }] };
	}
	// eslint-disable-next-line no-restricted-syntax
	const module = await import(/* webpackIgnore: true */ markdownUrl) as { markdownToAdf(text: string): AdfDocument };
	return module.markdownToAdf(markdown);
}

/** Says what a part the editor can't change is, and why. */
function readOnly(element: HTMLElement): void {
	setTip(element, strings.readOnlyBlock);
	element.setAttribute('role', 'note');
	element.setAttribute('aria-label', format(strings.readOnlyLabel, element.textContent ?? ''));
}

const adfView: AdfView = { labels: strings.opaque, readOnly };

function html(content: AdfDocument['content'], into: HTMLElement): HTMLElement {
	adfToHtml({ type: 'doc', version: 1, content }, into, adfView);
	return into;
}

function render(): void {
	if (!view) {
		return;
	}
	current();
	editor = undefined;
	page.replaceChildren(header(view), ...conflicts.length ? [conflictBanner()] : [], published ? publishedBanner(published) : body(view), footer(view));
}

function header(v: ReviewView): HTMLElement {
	const node = el('header', 'review-head');
	const line = el('div', 'review-line');
	const pill = el('span', 'review-pill', v.kind === 'new' ? strings.newPage : strings.newVersion);
	pill.prepend(el('span', 'review-dot'));
	const crumbs = el('nav', 'review-crumbs');
	v.where.forEach((part, i) => {
		if (i) {
			crumbs.append(el('span', 'review-sep', '\u203a'));
		}
		crumbs.append(el('span', undefined, part));
	});
	const time = new Date(v.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	line.append(pill, crumbs, el('span', 'spacer'), el('span', 'review-by', format(strings.draftedAt, time)));
	if (v.url) {
		line.append(button('quiet', strings.openInConfluence, () => post({ type: 'open', url: v.url! }), 'link-external'));
	}
	node.append(line);
	if (v.kind === 'edit' && !published && !conflicts.length) {
		const seg = el('div', 'review-seg');
		seg.setAttribute('role', 'radiogroup');
		const left = undecided(parts(), kept, held);
		for (const [id, label] of [['now', strings.pageNow], ['marked', strings.withChanges], ['changes', strings.changesOnly], ['edit', strings.edit]] as const) {
			const option = button(mode === id ? 'on' : '', label, () => {
				current();
				mode = id;
				render();
			});
			option.setAttribute('role', 'radio');
			option.setAttribute('aria-checked', String(mode === id));
			if (id === 'marked' && left) {
				option.append(el('span', 'review-count', String(left)));
			}
			seg.append(option);
		}
		node.append(seg);
	}
	return node;
}

function body(v: ReviewView): HTMLElement {
	const wrap = el('div', mode === 'marked' || mode === 'changes' ? 'review-body with-side' : 'review-body');
	const sheet = el('article', 'review-sheet');
	const heading = el('input', 'review-title');
	heading.value = title;
	heading.setAttribute('aria-label', strings.titleLabel);
	heading.readOnly = mode !== 'edit';
	heading.addEventListener('input', () => {
		title = heading.value;
		scheduleSave();
	});
	sheet.append(heading);
	if (v.kind === 'edit' && mode === 'marked' && baseVersion !== undefined) {
		const note = el('div', 'review-note');
		note.append(icon('info'), el('span', undefined, format(strings.editNote, String(baseVersion))));
		sheet.append(note);
	}
	if (mode === 'edit') {
		const content = html(doc.content, el('div', 'review-content'));
		content.contentEditable = 'true';
		content.spellcheck = true;
		markConflicts(content);
		content.addEventListener('input', scheduleSave);
		content.addEventListener('keydown', onEditorKey);
		editor = content;
		sheet.append(content);
	} else if (mode === 'now' && base) {
		sheet.append(html(base.content, el('div', 'review-content read-only')));
	} else if (base) {
		sheet.append(marked(mode === 'changes'));
	}
	wrap.append(sheet);
	if ((mode === 'marked' || mode === 'changes') && base) {
		wrap.append(changeList());
	}
	return wrap;
}

/** The page with the draft's changes in place: removed blocks struck through, added ones highlighted, each with Keep and Undo. */
function marked(only: boolean): HTMLElement {
	const content = el('div', 'review-content read-only');
	const count = listed().length;
	let n = 0;
	/** The part of the page put back that the blocks just drawn belong to, with what it holds. */
	let putBack: { readonly node: HTMLElement; readonly blocks: AdfDocument['content'][number][]; readonly note: HTMLElement; next: number } | undefined;
	for (const part of parts()) {
		if (part.kind === 'same' && held.includes(part.at)) {
			// A part of the page the agent's Markdown would have dropped: on the page still, and why.
			if (putBack?.next !== part.at) {
				const node = el('section', 'review-held');
				const note = el('div', 'review-held-note');
				note.setAttribute('role', 'note');
				node.append(note);
				content.append(node);
				putBack = { node, blocks: [], note, next: part.at };
			}
			putBack.blocks.push(part.node);
			putBack.note.replaceChildren(icon('lock'), el('span', undefined, format(strings.held, kindNames(putBack.blocks))));
			putBack.next++;
			html([part.node], putBack.node);
			continue;
		}
		if (part.kind === 'same') {
			if (!only) {
				html([part.node], content);
			}
			continue;
		}
		if (putBack?.next === part.at && rewritesHeld(part, held)) {
			// The agent's version of it: taken only by choosing it, never by Keep All.
			const theirs = el('div', 'review-agent-version');
			const bar = el('div', 'review-change-bar');
			bar.setAttribute('role', 'toolbar');
			bar.append(
				el('span', 'review-change-of', format(strings.agentVersion, kindNames(putBack.blocks))),
				button('keep', strings.usePage, () => undoChange(part.key), 'check'),
				button('undo', strings.useAgent, () => takeAgent(part.key), 'arrow-swap'),
			);
			theirs.append(bar, html(part.added, el('div', 'review-added')));
			putBack.node.append(theirs);
			continue;
		}
		const index = n++;
		const isKept = kept.has(part.key);
		const box = el('section', isKept ? 'review-change kept' : 'review-change');
		box.id = `change-${index}`;
		if (!isKept) {
			const bar = el('div', 'review-change-bar');
			bar.setAttribute('role', 'toolbar');
			bar.append(
				el('span', 'review-change-of', format(strings.changeOf, index + 1, count)),
				button('keep', strings.keep, () => {
					kept.add(part.key);
					scheduleSave();
					render();
				}, 'check'),
				button('undo', strings.undo, () => undoChange(part.key), 'discard'),
			);
			box.append(bar);
			if (part.removed.length) {
				box.append(html(part.removed, el('div', 'review-removed')));
			}
		}
		if (part.added.length) {
			box.append(html(part.added, el('div', isKept ? '' : 'review-added')));
		}
		content.append(box);
	}
	if (!count) {
		content.append(el('p', 'review-empty', strings.noChanges));
	}
	return content;
}

/** The changes the user keeps or undoes one by one: all but the agent's versions of parts put back. */
function listed(): Change[] {
	return changes().filter(change => !rewritesHeld(change, held));
}

/** What `blocks` hold that the agent can't write, as the user reads it. */
function kindNames(blocks: AdfDocument['content']): string {
	return new Intl.ListFormat(navigator.language).format(new Set(lostKinds(blocks).map(kind => strings.kinds[kind] ?? strings.kinds.other)));
}

/** Takes the agent's version (change `key`) in place of the part of the page put back before it, as a change the user kept. */
function takeAgent(key: string): void {
	const taken = takeRewrite(parts(), held, key);
	doc = { type: 'doc', version: 1, content: taken.content };
	held = taken.held;
	const change = changes().find(c => c.at <= taken.from && taken.from <= c.at + c.removed.length);
	if (change) {
		kept.add(change.key);
	}
	scheduleSave();
	render();
}

/** Undoes change `key`: the draft gets the page's blocks back there. */
function undoChange(key: string): void {
	doc = { type: 'doc', version: 1, content: undoBlocks(parts(), key) };
	kept.delete(key);
	scheduleSave();
	render();
}

function changeList(): HTMLElement {
	const side = el('aside', 'review-side');
	const list = el('nav', 'review-outline');
	const all = listed();
	all.forEach((change, i) => {
		const first = change.added[0] ?? change.removed[0];
		const link = el('a', kept.has(change.key) ? 'kept' : '', (first ? textOf(first).trim() : '').slice(0, 60) || format(strings.changeOf, i + 1, all.length));
		link.href = `#change-${i}`;
		link.prepend(icon(kept.has(change.key) ? 'check' : 'circle-filled'));
		list.append(link);
	});
	const actions = el('div', 'review-side-actions');
	actions.append(
		button('', strings.keepAll, () => {
			keepAllKeys(parts(), held).forEach(key => kept.add(key));
			scheduleSave();
			render();
		}),
		button('quiet', strings.undoAll, () => {
			doc = base ?? doc;
			kept.clear();
			held = [];
			scheduleSave();
			render();
		}),
	);
	side.append(list, actions);
	return side;
}

function banner(tone: 'warn' | 'ok', iconName: string, title: string, ...lines: string[]): HTMLElement {
	const node = el('div', `review-banner ${tone}`);
	node.setAttribute('role', tone === 'warn' ? 'alert' : 'status');
	const text = el('div', 'review-banner-text');
	text.append(el('strong', undefined, title), ...lines.map(line => el('span', undefined, line)));
	node.append(icon(iconName), text);
	return node;
}

function conflictBanner(): HTMLElement {
	return banner('warn', 'warning', format(strings.conflictTitle, String(baseVersion ?? '')), strings.conflictText, format(strings.conflictPlaces, String(conflicts.length)));
}

/**
 * Each place both changed, in the editor: the latest version's blocks, with
 * the draft's beside them and a choice. The box and the latest version's
 * blocks are tagged with the conflict, so picking finds them wherever edits
 * above have moved them.
 */
function markConflicts(content: HTMLElement): void {
	const blocks = Array.from(content.children);
	conflicts.forEach((conflict, index) => {
		const box = el('section', 'review-conflict');
		box.contentEditable = 'false';
		// Not part of the page: `htmlToAdf` leaves it out, and says where it stands.
		box.dataset.skip = '';
		box.dataset.conflict = String(index);
		const actions = el('div', 'review-conflict-actions');
		actions.append(button('', strings.keepTheirs, () => resolve(index, 'theirs')), button('', strings.keepMine, () => resolve(index, 'mine')));
		box.append(side(strings.theirs, conflict.theirs, ''), side(strings.mine, conflict.mine, ' mine'), actions);
		// The latest version's blocks stand in the page until the user picks, unless they were edited since.
		if (conflict.theirs.every((node, i) => JSON.stringify(doc.content[conflict.at + i]) === JSON.stringify(node))) {
			for (let i = 0; i < conflict.theirs.length; i++) {
				const block = blocks[conflict.at + i];
				block?.classList.add('review-conflict-theirs');
				block?.setAttribute('data-theirs', String(index));
			}
		}
		const anchor = blocks[conflict.at];
		if (anchor) {
			content.insertBefore(box, anchor);
		} else {
			content.append(box);
		}
	});
}

/** One side of a place both changed: its label, then its blocks. */
function side(label: string, content: AdfDocument['content'], mine: string): HTMLElement {
	const node = el('div', `review-conflict-side${mine}`);
	node.append(el('div', 'review-conflict-label', label));
	return html(content, node);
}

function resolve(index: number, side: 'theirs' | 'mine'): void {
	if (!editor) {
		return;
	}
	const box = editor.querySelector(`[data-conflict="${index}"]`);
	const theirs = editor.querySelectorAll(`[data-theirs="${index}"]`);
	if (side === 'mine') {
		box?.before(...Array.from(html([...conflicts[index].mine], el('div')).childNodes));
		theirs.forEach(node => node.remove());
	} else {
		theirs.forEach(node => {
			node.classList.remove('review-conflict-theirs');
			node.removeAttribute('data-theirs');
			if (!node.classList.length) {
				node.removeAttribute('class');
			}
		});
	}
	box?.remove();
	// Read once, while the boxes still carry the numbers they were drawn with.
	current();
	editor = undefined;
	conflicts = conflicts.filter((_, i) => i !== index);
	scheduleSave();
	render();
}

function publishedBanner(done: { url: string; version: number }): HTMLElement {
	const node = banner('ok', 'pass', strings.publishedTitle, format(strings.publishedText, String(done.version)));
	if (done.url) {
		node.append(button('primary', strings.openInConfluence, () => post({ type: 'open', url: done.url }), 'link-external'));
	}
	return node;
}

/** Why Publish waits, if it does: a place left to pick, or changes left to keep or undo. */
function blocked(): string {
	const left = undecided(parts(), kept, held);
	return conflicts.length ? format(strings.conflictPlaces, String(conflicts.length)) : left ? format(strings.decideFirst, left) : '';
}

function footer(v: ReviewView): HTMLElement {
	const node = el('footer', 'review-foot');
	if (published) {
		return node;
	}
	node.append(icon('lock'), el('span', 'review-foot-text', v.kind === 'new' ? strings.footNew : format(strings.footEdit, String((baseVersion ?? 0) + 1))));
	const state = el('span', `review-status ${status.tone}`, status.text);
	state.setAttribute('role', 'status');
	node.append(state);
	const reason = blocked();
	node.dataset.state = `${busy}${reason}${!title.trim()}`;
	const publish = button('primary', busy ? strings.publishing : v.kind === 'new' ? strings.publishNew : strings.publishEdit, () => {
		clearTimeout(saveTimer);
		const document = current();
		busy = true;
		status = { text: '', tone: '' };
		post({ type: 'publish', title, document, review: review() });
		refreshFooter(true);
	});
	publish.disabled = busy || !!reason || !title.trim();
	if (reason) {
		const why = el('span', 'review-foot-reason', reason);
		why.id = 'review-blocked';
		publish.setAttribute('aria-describedby', why.id);
		node.append(why);
	}
	const actions = el('span', 'review-foot-actions');
	actions.append(button('quiet', strings.discard, () => post({ type: 'discard' })), button('', strings.save, save), publish);
	node.append(actions);
	return node;
}

/** Redraws the footer alone, when what Publish can do changed (or `force`): the editor, its cursor and its undo stay. */
function refreshFooter(force = false): void {
	const old = page.querySelector<HTMLElement>('.review-foot');
	if (view && old && (force || old.dataset.state !== `${busy}${blocked()}${!title.trim()}`)) {
		old.replaceWith(footer(view));
	}
}

function showStatus(text: string, tone: 'ok' | 'error'): void {
	status = { text, tone };
	const node = page.querySelector('.review-status');
	if (node) {
		node.textContent = text;
		node.className = `review-status ${tone}`;
	}
}

// --- The floating toolbar, over selected text in the editor.

const toolbar = el('div', 'review-toolbar');
toolbar.setAttribute('role', 'toolbar');
toolbar.hidden = true;
document.body.append(toolbar);
let linkRange: Range | undefined;

function toolButton(label: string, content: string | HTMLElement, run: () => void): HTMLButtonElement {
	const node = el('button', 'review-tool');
	node.type = 'button';
	node.setAttribute('aria-label', label);
	setTip(node, label);
	node.append(content);
	// Keeps the selection: the editor never loses focus to the toolbar.
	node.addEventListener('mousedown', event => event.preventDefault());
	node.addEventListener('click', () => {
		run();
		editor?.dispatchEvent(new Event('input'));
		placeToolbar();
	});
	return node;
}

function exec(command: string, value?: string): void {
	// The editor is a plain contenteditable: the browser's own commands do the editing, and `htmlToAdf` reads the result.
	document.execCommand(command, false, value);
}

function wrapCode(): void {
	const selection = document.getSelection();
	if (!selection?.rangeCount) {
		return;
	}
	const range = selection.getRangeAt(0);
	const inCode = (range.commonAncestorContainer.parentElement)?.closest('code');
	if (inCode) {
		inCode.replaceWith(...Array.from(inCode.childNodes));
		return;
	}
	const code = document.createElement('code');
	code.append(range.extractContents());
	range.insertNode(code);
}

function buildToolbar(): void {
	const strong = el('strong', undefined, 'B');
	const em = el('em', undefined, 'I');
	const strike = el('s', undefined, 'S');
	const styles = ([['p', strings.paragraph, 'T'], ['h1', strings.heading1, 'H1'], ['h2', strings.heading2, 'H2'], ['h3', strings.heading3, 'H3']] as const).map(([tag, label, text]) => {
		const node = toolButton(label, text, () => exec('formatBlock', tag));
		node.dataset.block = tag;
		return node;
	});
	const linkBox = el('span', 'review-link-box');
	linkBox.hidden = true;
	const linkInput = el('input');
	linkInput.type = 'url';
	linkInput.placeholder = 'https://';
	linkInput.setAttribute('aria-label', strings.linkPrompt);
	linkInput.addEventListener('keydown', event => {
		if (event.key === 'Enter' && linkRange) {
			event.preventDefault();
			const selection = document.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(linkRange);
			const href = linkInput.value.trim();
			if (/^(https?:|mailto:)/i.test(href)) {
				exec('createLink', href);
			} else if (!href) {
				exec('unlink');
			}
			linkBox.hidden = true;
			editor?.dispatchEvent(new Event('input'));
			editor?.focus();
		} else if (event.key === 'Escape') {
			linkBox.hidden = true;
			editor?.focus();
		}
	});
	linkBox.append(linkInput);
	toolbar.append(
		toolButton(strings.bold, strong, () => exec('bold')),
		toolButton(strings.italic, em, () => exec('italic')),
		toolButton(strings.strike, strike, () => exec('strikeThrough')),
		toolButton(strings.code, icon('code'), wrapCode),
		el('span', 'review-tool-sep'),
		...styles,
		toolButton(strings.bulletList, icon('list-unordered'), () => exec('insertUnorderedList')),
		toolButton(strings.numberedList, icon('list-ordered'), () => exec('insertOrderedList')),
		el('span', 'review-tool-sep'),
		toolButton(strings.link, icon('link'), () => {
			const selection = document.getSelection();
			linkRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
			linkInput.value = (linkRange?.commonAncestorContainer.parentElement?.closest('a') as HTMLAnchorElement | null)?.getAttribute('href') ?? '';
			linkBox.hidden = false;
			linkInput.focus();
		}),
		linkBox,
	);
}

function placeToolbar(): void {
	const selection = document.getSelection();
	const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
	const inside = range && editor?.contains(range.commonAncestorContainer);
	if (!inside || !range || (range.collapsed && document.activeElement !== toolbar.querySelector('input'))) {
		if (!toolbar.contains(document.activeElement)) {
			toolbar.hidden = true;
		}
		return;
	}
	const block = (range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement)?.closest('p, h1, h2, h3, li, td, th');
	const current = block && /^H[1-3]$/.test(block.tagName) ? block.tagName.toLowerCase() : 'p';
	toolbar.querySelectorAll<HTMLElement>('[data-block]').forEach(node => node.classList.toggle('on', node.dataset.block === current));
	const rect = range.getBoundingClientRect();
	toolbar.hidden = false;
	const width = toolbar.offsetWidth;
	toolbar.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2))}px`;
	toolbar.style.top = `${Math.max(8, rect.top + window.scrollY - toolbar.offsetHeight - 8)}px`;
}

function onEditorKey(event: KeyboardEvent): void {
	if ((event.metaKey || event.ctrlKey) && !event.shiftKey) {
		const command = event.key === 'b' ? 'bold' : event.key === 'i' ? 'italic' : undefined;
		if (command) {
			event.preventDefault();
			exec(command);
			editor?.dispatchEvent(new Event('input'));
		}
		if (event.key === 's') {
			event.preventDefault();
			save();
		}
	}
}

buildToolbar();
document.addEventListener('selectionchange', placeToolbar);
window.addEventListener('scroll', () => toolbar.hidden || placeToolbar(), { passive: true });

start(message => {
	switch (message.type) {
		case 'view':
			void (async () => {
				const v = message.view;
				view = v;
				title = v.title;
				base = v.base;
				baseVersion = v.baseVersion;
				kept = new Set(v.review?.kept);
				held = [...v.review?.held ?? []];
				conflicts = [...v.review?.conflicts ?? []];
				editor = undefined;
				if (v.saved) {
					doc = v.saved;
				} else {
					// As Confluence takes it (no heading in a list), and with what the agent's Markdown would have dropped from the page put back.
					const drafted = confluenceSafe((await markdownToDoc(v.markdown ?? '')).content);
					const holding = base && holdBlocks(base.content, drafted);
					doc = { type: 'doc', version: 1, content: holding ? holding.content : drafted };
					held = holding ? holding.held : [];
				}
				mode = v.kind === 'edit' && !conflicts.length ? 'marked' : 'edit';
				render();
				if (!v.saved && held.length) {
					save();
				}
			})();
			return;
		case 'saved':
			showStatus(strings.saved, 'ok');
			return;
		case 'published':
			busy = false;
			published = { url: message.url, version: message.version };
			render();
			return;
		case 'conflict': {
			busy = false;
			const mine = current();
			editor = undefined;
			const merged = mergeBlocks(base?.content ?? [], message.theirs.content, mine.content);
			base = message.theirs;
			baseVersion = message.version;
			doc = { type: 'doc', version: 1, content: merged.merged };
			conflicts = merged.conflicts;
			held = [];
			// The draft's changes carried onto the latest version were each kept before publishing.
			kept = new Set(changes().map(change => change.key));
			mode = 'edit';
			post({ type: 'rebase', title, document: doc, review: review(), version: message.version, base: message.theirs });
			render();
			return;
		}
		case 'error':
			busy = false;
			showStatus(message.message, 'error');
			refreshFooter(true);
			return;
	}
});
