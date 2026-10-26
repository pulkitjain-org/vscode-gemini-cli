/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A Confluence page (Atlassian Document Format) as editable HTML for the
// Review Page's editor, and the editor's HTML back as ADF. Text, headings,
// lists, quotes, code, rules, tables, links and the common marks are edited
// in place. Anything else (macros, images, panels, mentions, status lozenges)
// shows read-only, carrying its own ADF, and goes back to Confluence as it
// came, so publishing never drops what the editor can't change. So do the
// attributes and marks the editor has no control for (inline comments,
// colours, alignment, ids): they ride on the elements as `data-adf-attrs`,
// `data-adf-marks` and `data-adf-mark`, and a block the user didn't touch
// goes back as the very ADF it came from. Pure DOM: no Confluence calls.

import type { AdfDocument, AdfNode } from '../src/acp/confluence';
import { bold, codeMarks } from '../src/acp/draftReview';
import type { OpaqueLabels } from '../src/host/confluenceReviewProtocol';

type Mark = NonNullable<AdfNode['marks']>[number];

const markTags: Readonly<Record<string, string>> = { strong: 'strong', em: 'em', strike: 's', code: 'code', underline: 'u' };

/** Each top-level block the editor shows, with the ADF it came from and its HTML then: unchanged, it goes back as it came. */
const originals = new WeakMap<Node, { readonly node: AdfNode; readonly html: string }>();

/** How the page draws the parts the editor can't change: `labels` for what they show in the user's language, `readOnly` to describe each. */
export interface AdfView {
	readonly labels?: OpaqueLabels;
	readOnly?(element: HTMLElement): void;
}

/** The page as nodes for the editor, appended to `into`. */
export function adfToHtml(doc: AdfDocument, into: HTMLElement, view: AdfView = {}): void {
	for (const node of doc.content) {
		const element = block(into.ownerDocument, node, view);
		if (element.nodeType === 1) {
			originals.set(element, { node, html: (element as Element).outerHTML });
		}
		into.append(element);
	}
}

/** The element each block the editor changes in place becomes; a heading's depends on its level. */
const tagOf: Readonly<Record<string, string>> = { paragraph: 'p', bulletList: 'ul', orderedList: 'ol', listItem: 'li', blockquote: 'blockquote', codeBlock: 'pre', rule: 'hr', table: 'table', tableRow: 'tr', tableHeader: 'th', tableCell: 'td' };

function block(document: Document, node: AdfNode, view: AdfView): Node {
	const tag = node.type === 'heading' ? `h${Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6)}` : tagOf[node.type];
	if (!tag) {
		return opaque(document, node, 'div', view);
	}
	const element = document.createElement(tag);
	if (node.type === 'codeBlock') {
		element.append(document.createElement('code'));
		element.firstChild!.textContent = (node.content ?? []).map(t => t.text ?? '').join('');
	} else {
		const parent = node.type === 'table' ? element.appendChild(document.createElement('tbody')) : element;
		for (const child of node.content ?? []) {
			parent.append(isInline(child) ? inline(document, child, view) : block(document, child, view));
		}
	}
	if (node.type === 'paragraph' && !element.childNodes.length) {
		element.append(document.createElement('br'));
	}
	if (node.type === 'orderedList' && Number(node.attrs?.order) > 1) {
		element.setAttribute('start', String(node.attrs!.order));
	}
	return keep(element, node);
}

function isInline(node: AdfNode): boolean {
	return ['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'status', 'date', 'placeholder', 'inlineExtension', 'mediaInline'].includes(node.type);
}

function inline(document: Document, node: AdfNode, view: AdfView): Node {
	if (node.type === 'hardBreak') {
		return document.createElement('br');
	}
	if (node.type !== 'text') {
		return opaque(document, node, 'span', view);
	}
	let result: Node = document.createTextNode(node.text ?? '');
	for (const mark of [...node.marks ?? []].reverse()) {
		const tag = mark.type === 'link' ? 'a' : markTags[mark.type];
		const element = document.createElement(tag ?? 'span');
		if (mark.type === 'link') {
			element.setAttribute('href', String(mark.attrs?.href ?? ''));
			keep(element, mark);
		} else if (!tag) {
			// A mark the editor has no control for: kept whole, shown as near as it can be.
			element.className = `adf-mark adf-mark-${mark.type}`;
			element.dataset.adfMark = JSON.stringify(mark);
			if (mark.type === 'textColor' || mark.type === 'backgroundColor') {
				element.style[mark.type === 'textColor' ? 'color' : 'backgroundColor'] = String(mark.attrs?.color ?? '');
			}
		}
		element.append(result);
		result = element;
	}
	return result;
}

/** Something the editor shows but can't change: read-only, with its ADF kept on the element. */
function opaque(document: Document, node: AdfNode, tag: 'div' | 'span', view: AdfView): HTMLElement {
	const element = document.createElement(tag);
	element.className = `adf-opaque adf-${node.type}`;
	element.contentEditable = 'false';
	element.dataset.adf = JSON.stringify(node);
	element.textContent = opaqueText(node, view.labels);
	view.readOnly?.(element);
	return element;
}

/** What a read-only node shows: its own text where it has one, else what kind of thing it is. */
export function opaqueText(node: AdfNode, labels?: OpaqueLabels): string {
	const attrs = node.attrs ?? {};
	const label = (key: keyof OpaqueLabels) => labels?.[key] ?? node.type;
	switch (node.type) {
		case 'mention': return String(attrs.text ?? label('someone'));
		case 'emoji': return String(attrs.text ?? attrs.shortName ?? '');
		case 'status': return String(attrs.text ?? '').toUpperCase();
		case 'inlineCard': case 'blockCard': case 'embedCard': return String(attrs.url ?? label('link'));
		case 'date': return attrs.timestamp ? new Date(Number(attrs.timestamp)).toISOString().slice(0, 10) : label('date');
		case 'extension': case 'bodiedExtension': case 'inlineExtension': return String(attrs.extensionKey ?? label('macro'));
		case 'mediaSingle': case 'mediaGroup': case 'media': case 'mediaInline': return label('media');
		default: return textOf(node).trim() || label('other');
	}
}

/** A node's text, its paragraphs' words joined. */
export function textOf(node: AdfNode): string {
	return node.text ?? (node.content ?? []).map(textOf).join(node.type === 'paragraph' ? '' : ' ');
}

/** Keeps `node`'s attributes and marks on `element`, for `finish` to put back. */
function keep(element: HTMLElement, node: { readonly attrs?: Readonly<Record<string, unknown>>; readonly marks?: readonly Mark[] }): HTMLElement {
	if (node.attrs && Object.keys(node.attrs).length) {
		element.dataset.adfAttrs = JSON.stringify(node.attrs);
	}
	if (node.marks?.length) {
		element.dataset.adfMarks = JSON.stringify(node.marks);
	}
	return element;
}

/**
 * What an element's `data-adf*` attribute holds, when it has the shape `is`
 * wants; else nothing. An element pasted into the editor can carry any such
 * attribute, so nothing is taken on trust.
 */
function stored<T>(raw: string | undefined, is: (value: unknown) => value is T): T | undefined {
	try {
		const value: unknown = raw ? JSON.parse(raw) : undefined;
		return is(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

type Attrs = Record<string, unknown>;

/** A JSON value of scalars, `depth` levels of arrays and objects at most, and no `content`: attributes, never nodes. */
function plain(value: unknown, depth: number): boolean {
	return value === null || /^(string|number|boolean)$/.test(typeof value) || depth > 0 && typeof value === 'object'
		&& (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype && !Object.hasOwn(value as object, 'content'))
		&& Object.values(value as object).every(v => plain(v, depth - 1));
}

function isAttrs(value: unknown, depth = 2): value is Attrs {
	return !!value && !Array.isArray(value) && plain(value, depth);
}

/** Something with a `type`, no keys but `keys`, and attributes `depth` levels deep at most. */
function has(value: unknown, keys: RegExp, depth: number): value is AdfNode {
	return !!value && typeof (value as AdfNode).type === 'string' && Object.keys(value).every(key => keys.test(key)) && ((value as AdfNode).attrs === undefined || isAttrs((value as AdfNode).attrs, depth));
}

function isMark(value: unknown): value is Mark {
	return has(value, /^(type|attrs)$/, 2);
}

function isMarks(value: unknown): value is Mark[] {
	return Array.isArray(value) && value.every(isMark);
}

/** An ADF node, as a part the editor can't change carries it: a macro's parameters may run deep, but every part has a node's shape. */
function isNode(value: unknown): value is AdfNode {
	const node = value as AdfNode;
	return has(value, /^(type|attrs|content|text|marks)$/, 9) && (node.text === undefined || typeof node.text === 'string')
		&& (node.marks === undefined || isMarks(node.marks)) && (node.content === undefined || Array.isArray(node.content) && node.content.every(isNode));
}

/** The ids met so far in one `htmlToAdf`: the browser copies a block's attributes to the new one when Enter splits it, and an id belongs to one node. */
let seenIds = new Set<unknown>();
/** The blocks of one `htmlToAdf` that go back as they came: unchanged, and with no id another such block has. */
let unchanged = new Map<Node, AdfNode>();

/** Every id in `node`. */
function idsOf(node: AdfNode): unknown[] {
	return [...node.attrs?.localId !== undefined ? [node.attrs.localId] : [], ...(node.content ?? []).flatMap(idsOf)];
}

/** `node` with the attributes and marks its element kept (`node`'s own attributes win), and a copied id dropped. */
function finish(element: Element, node: AdfNode): AdfNode {
	const kept = stored((element as HTMLElement).dataset?.adfAttrs, isAttrs);
	const marks = stored((element as HTMLElement).dataset?.adfMarks, isMarks);
	let attrs = kept ? { ...kept, ...node.attrs } : node.attrs;
	if (attrs?.localId !== undefined) {
		if (seenIds.has(attrs.localId)) {
			const { localId: _copied, ...rest } = attrs;
			attrs = rest;
		}
		seenIds.add(attrs.localId);
	}
	// In Confluence's order, so a block read back unchanged compares equal to the one it came from.
	const { type, attrs: _attrs, ...rest } = node;
	return { type, ...attrs && Object.keys(attrs).length ? { attrs } : {}, ...rest, ...marks ? { marks } : {} };
}

/**
 * The editor's content as an ADF document. `skipped` hears where each part
 * of the page that isn't the page's own (`data-skip`) stands, by block index.
 */
export function htmlToAdf(root: Element, skipped?: (element: HTMLElement, at: number) => void): AdfDocument {
	seenIds = new Set();
	unchanged = new Map();
	// The blocks the user didn't touch keep their ids first, so a pasted copy, before or after its original, is the one that loses its id.
	for (const child of Array.from(root.childNodes)) {
		const original = originals.get(child);
		const ids = original && original.html === (child as Element).outerHTML ? idsOf(original.node) : undefined;
		if (ids && !ids.some(id => seenIds.has(id))) {
			ids.forEach(id => seenIds.add(id));
			unchanged.set(child, original!.node);
		}
	}
	return { type: 'doc', version: 1, content: blocks(root.childNodes, skipped) };
}

const blockTags = /^(P|DIV|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|HR|TABLE|TBODY|THEAD|TR|TD|TH)$/;

function isBlock(node: Node): boolean {
	return node.nodeType === 1 && blockTags.test((node as Element).tagName);
}

/** What a page puts in the editor that isn't part of the page, such as the Review Page's conflict boxes (`data-skip`). */
function isSkipped(node: Node): boolean {
	return node.nodeType === 1 && (node as HTMLElement).dataset?.skip !== undefined;
}

/** Block nodes from `nodes`; runs of loose inline content become paragraphs. */
function blocks(nodes: NodeListOf<ChildNode> | readonly ChildNode[], skipped?: (element: HTMLElement, at: number) => void): AdfNode[] {
	const result: AdfNode[] = [];
	let loose: ChildNode[] = [];
	const flush = () => {
		const content = inlines(loose, []);
		if (content.length || loose.some(n => n.nodeType === 1)) {
			result.push(paragraph(content));
		}
		loose = [];
	};
	for (const node of Array.from(nodes)) {
		if (isSkipped(node)) {
			flush();
			skipped?.(node as HTMLElement, result.length);
			continue;
		}
		if (node.nodeType === 3 && !loose.length && !(node.textContent ?? '').trim()) {
			continue;
		}
		if (!isBlock(node)) {
			loose.push(node);
			continue;
		}
		flush();
		const original = unchanged.get(node);
		if (original) {
			result.push(original);
			continue;
		}
		const converted = blockOf(node as HTMLElement);
		if (converted) {
			result.push(...Array.isArray(converted) ? converted : [converted]);
		}
	}
	flush();
	return result;
}

function paragraph(content: AdfNode[]): AdfNode {
	return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function blockOf(element: HTMLElement): AdfNode | AdfNode[] | undefined {
	if (element.dataset.adf !== undefined) {
		return stored(element.dataset.adf, isNode);
	}
	if (/^H[1-6]$/.test(element.tagName)) {
		const content = inlines(element.childNodes, []);
		return finish(element, { type: 'heading', attrs: { level: Number(element.tagName[1]) }, ...content.length ? { content } : {} });
	}
	switch (element.tagName) {
		case 'P':
			return finish(element, paragraph(inlines(element.childNodes, [])));
		case 'DIV':
			// What the browser makes for a new line in some cases: a paragraph, or blocks when it holds some.
			return Array.from(element.childNodes).some(isBlock) ? blocks(element.childNodes) : paragraph(inlines(element.childNodes, []));
		case 'UL': case 'OL': {
			const items = Array.from(element.children).filter(child => child.tagName === 'LI').map(li => listItem(li as HTMLElement));
			if (!items.length) {
				return undefined;
			}
			const start = Number(element.getAttribute('start'));
			return finish(element, element.tagName === 'UL' ? { type: 'bulletList', content: items } : { type: 'orderedList', ...start > 1 ? { attrs: { order: start } } : {}, content: items });
		}
		case 'LI':
			return paragraph(inlines(element.childNodes, []));
		case 'BLOCKQUOTE': {
			const content = blocks(element.childNodes);
			return finish(element, { type: 'blockquote', content: content.length ? content : [paragraph([])] });
		}
		case 'PRE': {
			const text = element.textContent ?? '';
			return finish(element, { type: 'codeBlock', ...text ? { content: [{ type: 'text', text }] } : {} });
		}
		case 'HR':
			return finish(element, { type: 'rule' });
		case 'TABLE': case 'TBODY': case 'THEAD': {
			const rows = Array.from(element.querySelectorAll(':scope > tr, :scope > tbody > tr, :scope > thead > tr')).map(row => tableRow(row as HTMLElement));
			return element.tagName === 'TABLE' ? finish(element, { type: 'table', content: rows }) : rows;
		}
		case 'TR':
			return tableRow(element);
		case 'TD': case 'TH':
			return paragraph(inlines(element.childNodes, []));
	}
	return undefined;
}

/**
 * A list item, as Confluence takes one: it starts with a paragraph, and a
 * heading in it (which the browser makes when a heading becomes a list)
 * becomes bold text.
 */
function listItem(li: HTMLElement): AdfNode {
	const content = blocks(li.childNodes).map(node => node.type === 'heading' ? paragraph((node.content ?? []).map(bold)) : node);
	if (!content.length || (content[0].type !== 'paragraph' && content[0].type !== 'codeBlock')) {
		content.unshift(paragraph([]));
	}
	return finish(li, { type: 'listItem', content });
}

function tableRow(row: HTMLElement): AdfNode {
	return finish(row, {
		type: 'tableRow',
		content: Array.from(row.children).filter(cell => cell.tagName === 'TD' || cell.tagName === 'TH').map(cell => {
			const content = blocks(cell.childNodes);
			return finish(cell, { type: cell.tagName === 'TH' ? 'tableHeader' : 'tableCell', content: content.length ? content : [paragraph([])] });
		}),
	});
}

/** Inline nodes from `nodes`, with `marks` from the elements around them. */
function inlines(nodes: NodeListOf<ChildNode> | readonly ChildNode[], marks: readonly Mark[]): AdfNode[] {
	const result: AdfNode[] = [];
	for (const node of Array.from(nodes)) {
		if (node.nodeType === 3) {
			const text = (node.textContent ?? '').replace(/\u00a0/g, ' ');
			if (text) {
				result.push({ type: 'text', text, ...marks.length ? { marks: codeMarks(marks) } : {} });
			}
			continue;
		}
		if (node.nodeType !== 1) {
			continue;
		}
		const element = node as HTMLElement;
		if (isSkipped(element)) {
			continue;
		}
		if (element.dataset.adf !== undefined) {
			// A node that can't be read back is left out rather than sent broken.
			const opaqueNode = stored(element.dataset.adf, isNode);
			if (opaqueNode) {
				result.push(opaqueNode);
			}
			continue;
		}
		if (element.tagName === 'BR') {
			// The browser's placeholder in an empty line is not a line break.
			if (element.nextSibling || element.previousSibling) {
				result.push({ type: 'hardBreak' });
			}
			continue;
		}
		result.push(...inlines(element.childNodes, [...marks, ...marksOf(element, marks)]));
	}
	return merge(result);
}

/** The marks the browser's own elements and styles stand for. */
const tagMarks: Readonly<Record<string, string>> = { STRONG: 'strong', B: 'strong', EM: 'em', I: 'em', S: 'strike', STRIKE: 'strike', DEL: 'strike', U: 'underline', CODE: 'code' };
const styleMarks: readonly (readonly [RegExp, string])[] = [[/font-weight:\s*(bold|[6-9]00)/, 'strong'], [/font-style:\s*italic/, 'em'], [/line-through/, 'strike']];

function marksOf(element: HTMLElement, outer: readonly Mark[]): Mark[] {
	const found: Mark[] = [];
	const add = (mark: Mark) => {
		if (![...outer, ...found].some(m => m.type === mark.type)) {
			found.push(mark);
		}
	};
	const style = element.getAttribute('style') ?? '';
	if (tagMarks[element.tagName]) {
		add({ type: tagMarks[element.tagName] });
	}
	for (const [pattern, type] of styleMarks) {
		if (pattern.test(style)) {
			add({ type });
		}
	}
	const href = element.tagName === 'A' && element.getAttribute('href');
	if (href) {
		add({ type: 'link', attrs: { ...stored(element.dataset.adfAttrs, isAttrs), href } });
	}
	// A mark the editor has no control for, as it came; inline comments may come more than once, each its own.
	const mark = element.dataset.adfMark;
	const kept = stored(mark, isMark);
	if (kept && !outer.some(m => JSON.stringify(m) === mark)) {
		found.push(kept);
	}
	return found;
}

/** Joins neighbouring text with the same marks, as Confluence stores it. */
function merge(nodes: AdfNode[]): AdfNode[] {
	const result: AdfNode[] = [];
	for (const node of nodes) {
		const last = result[result.length - 1];
		if (last?.type === 'text' && node.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) {
			result[result.length - 1] = { ...last, text: (last.text ?? '') + (node.text ?? '') };
		} else {
			result.push(node);
		}
	}
	return result;
}
