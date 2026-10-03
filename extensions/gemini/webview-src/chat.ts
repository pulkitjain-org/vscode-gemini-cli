/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat view's webview. It renders the transcript items the extension
// sends (src/acp/chatTranscript.ts) and posts prompts back. Agent Markdown is
// rendered by markdown-it with raw HTML disabled, so agent text can never
// inject markup; everything else is set with textContent.

import MarkdownIt from 'markdown-it';
import { Attachment, attachmentLabel, basename, classifyFile, maxImageBase64Length, supportedImageTypes } from '../src/acp/attachments';
import type { PromptAttachmentLabel, TranscriptItem } from '../src/acp/chatTranscript';
import type { TextAppend } from '../src/acp/textDeltas';
import type { SessionSelector, SessionSettings } from '../src/acp/sessionSettings';
import { scanStreaming, thoughtPreview } from './streaming';
import { chatProtocolVersion, type ChatStrings, type FromWebview, type ToWebview, type ViewGit, type ViewStatus } from '../src/host/chatProtocol';

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };

type ItemOf<K extends TranscriptItem['kind']> = Extract<TranscriptItem, { kind: K }>;

const vscode = acquireVsCodeApi();
const strings: ChatStrings = JSON.parse(document.querySelector<HTMLScriptElement>('script[data-strings]')?.dataset.strings ?? '{}');
const markdown = new MarkdownIt({ html: false, linkify: true });

function byId<T extends HTMLElement>(id: string): T {
	return document.getElementById(id) as T;
}

const transcript = byId<HTMLElement>('transcript');
const status = byId<HTMLElement>('status');
const form = byId<HTMLFormElement>('composer');
const input = byId<HTMLTextAreaElement>('input');
const sendButton = byId<HTMLButtonElement>('send');
const stopButton = byId<HTMLButtonElement>('stop');
const modeSelect = byId<HTMLSelectElement>('mode');
const modelSelect = byId<HTMLSelectElement>('model');
const resizeHandle = byId<HTMLElement>('resize');
const mentionButton = byId<HTMLButtonElement>('mention');
const picker = byId<HTMLElement>('picker');
const attachmentList = byId<HTMLElement>('attachments');
const branchButton = byId<HTMLButtonElement>('branch');
const commitButton = byId<HTMLButtonElement>('commit');

mentionButton.title = strings.addContext;
mentionButton.setAttribute('aria-label', strings.addContext);
const attachButton = byId<HTMLButtonElement>('attach');
attachButton.title = strings.attachFiles;
attachButton.setAttribute('aria-label', strings.attachFiles);
byId<HTMLElement>('drop-label').textContent = strings.dropFiles;

sendButton.title = strings.send;
sendButton.setAttribute('aria-label', strings.send);
stopButton.title = strings.stop;
stopButton.setAttribute('aria-label', strings.stop);
modeSelect.title = strings.mode;
modeSelect.setAttribute('aria-label', strings.mode);
modelSelect.title = strings.model;
modelSelect.setAttribute('aria-label', strings.model);

const elements = new Map<string, HTMLElement>();
let items: TranscriptItem[] = [];
let busy = false;
/** When each thought started and, once something followed it, ended. Lost when the view reloads. */
const thoughtTimes = new Map<string, { start: number; end?: number }>();
/** Tool calls the user expanded, kept across re-renders. */
const expanded = new Set<string>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

function icon(name: string, extra = ''): HTMLElement {
	const node = el('i', `codicon codicon-${name}${extra ? ` ${extra}` : ''}`);
	node.setAttribute('aria-hidden', 'true');
	return node;
}

function button(className: string, label: string, onClick: () => void, iconName?: string): HTMLButtonElement {
	const node = el('button', className);
	node.type = 'button';
	if (iconName) {
		node.append(icon(iconName));
	}
	if (label) {
		node.append(el('span', undefined, label));
	}
	node.addEventListener('click', event => {
		event.stopPropagation();
		onClick();
	});
	return node;
}

function format(template: string, value: string | number): string {
	return template.replace('{0}', String(value));
}


// ---- Items ---------------------------------------------------------------

function render(item: TranscriptItem): HTMLElement {
	switch (item.kind) {
		case 'user':
			return renderUserMessage(item);
		case 'agent':
			return renderMarkdown(item.text);
		case 'thought':
			return renderThought(item);
		case 'toolCall':
			return renderToolCall(item);
		case 'plan':
			return renderPlan(item);
		case 'permission':
			return renderPermission(item);
		case 'other':
			return renderNotice(format(strings.unknownUpdate, item.type), 'info');
		case 'notice':
			return renderNotice(item.text, item.severity);
		case 'turnEnd':
			return renderTurnEnd(item);
	}
}

/** "12s", "2m 5s" or "1h 3m". */
function formatDuration(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The agent's reply in the turn that `turnEnd` closes, as Markdown. */
function replyBefore(turnEnd: { readonly id: string }): string {
	const end = items.findIndex(item => item.id === turnEnd.id);
	const parts: string[] = [];
	for (let i = end - 1; i >= 0 && items[i].kind !== 'user' && items[i].kind !== 'turnEnd'; i--) {
		const item = items[i];
		if (item.kind === 'agent') {
			parts.unshift(item.text.trim());
		}
	}
	return parts.filter(Boolean).join('\n\n');
}

function renderTurnEnd(item: ItemOf<'turnEnd'>): HTMLElement {
	const node = el('div', 'turn-end');
	node.append(el('span', undefined, format(strings.workedFor, formatDuration(item.durationMs))));
	const copy = button('icon-button copy-reply', '', () => {
		void navigator.clipboard.writeText(replyBefore(item)).then(() => {
			copy.replaceChildren(icon('check'));
			setTimeout(() => copy.replaceChildren(icon('copy')), 1500);
		});
	}, 'copy');
	copy.title = strings.copyReply;
	copy.setAttribute('aria-label', strings.copyReply);
	node.append(copy);
	return node;
}

function renderUserMessage(item: { readonly text: string; readonly attachments?: readonly PromptAttachmentLabel[] }): HTMLElement {
	const node = el('div', 'message user');
	if (item.text) {
		node.append(el('div', 'user-text', item.text));
	}
	if (item.attachments?.length) {
		const chips = el('div', 'attachment-chips');
		for (const attachment of item.attachments) {
			const { path, line } = attachment;
			const chip = path
				? button('chip', attachment.label, () => vscode.postMessage({ type: 'openLocation', path, line }), attachmentIcon(attachment.kind, attachment.label))
				: el('span', 'chip static');
			if (!path) {
				chip.append(icon(attachmentIcon(attachment.kind, attachment.label)), el('span', undefined, attachment.label));
			}
			chip.title = path ?? attachment.label;
			chips.append(chip);
		}
		node.append(chips);
	}
	return node;
}

function attachmentIcon(kind: Attachment['kind'], label: string): string {
	return kind === 'image' ? 'file-media' : kind === 'selection' ? 'list-selection' : /\.pdf$/i.test(label) ? 'file-pdf' : 'file';
}

function renderMarkdown(text: string): HTMLElement {
	const node = el('div', 'message agent markdown');
	node.append(...renderBlocks(text));
	return node;
}

/** Markdown as nodes, with a copy button on each code block. */
function renderBlocks(text: string): Node[] {
	const node = el('div');
	node.innerHTML = markdown.render(text);
	for (const pre of node.querySelectorAll('pre')) {
		const wrapper = el('div', 'code-block');
		pre.replaceWith(wrapper);
		const copy = button('icon-button copy', '', () => {
			void navigator.clipboard.writeText(pre.textContent ?? '').then(() => {
				copy.replaceChildren(icon('check'));
				setTimeout(() => copy.replaceChildren(icon('copy')), 1500);
			});
		}, 'copy');
		copy.title = strings.copy;
		copy.setAttribute('aria-label', strings.copy);
		wrapper.append(pre, copy);
	}
	return [...node.childNodes];
}

/**
 * A reply that is still streaming. Its first `stableCount` child nodes show
 * `stableText`, the blocks that no longer change; each update renders only
 * the text after them, so a long reply stays cheap to update. A code block
 * that is still open is not rendered again: its new code is appended as
 * text. When the reply is done it is rendered once more as a whole.
 */
interface StreamingReply {
	readonly node: HTMLElement;
	stableText: string;
	stableCount: number;
	/** The open code block at the end, if any: where its opening line starts, its code and how much text it shows. */
	fence?: StreamingCode;
}

/**
 * The code of an open code block, in blocks of whole lines. New code only
 * goes into the last block, so the browser lays out just that block again
 * rather than every line of a long block.
 */
interface StreamingCode {
	readonly start: number;
	readonly code: HTMLElement;
	shown: number;
	tail: HTMLElement;
	tailLines: number;
}

const linesPerCodeChunk = 50;

function appendCode(fence: StreamingCode, text: string): void {
	const newlines = text.split('\n').length - 1;
	if (fence.tailLines + newlines < linesPerCodeChunk) {
		fence.tail.append(text);
		fence.tailLines += newlines;
		return;
	}
	// Close this block after its last whole line and start the next.
	const cut = text.lastIndexOf('\n') + 1;
	fence.tail.append(text.slice(0, cut));
	fence.tail = el('span', 'code-chunk');
	fence.tailLines = 0;
	fence.code.append(fence.tail);
	if (cut < text.length) {
		fence.tail.append(text.slice(cut));
	}
}

const streamingReplies = new Map<string, StreamingReply>();

function renderStreamingReply(item: { readonly id: string; readonly text: string }): HTMLElement {
	const reply: StreamingReply = { node: el('div', 'message agent markdown'), stableText: '', stableCount: 0 };
	streamingReplies.set(item.id, reply);
	updateStreamingReply(reply, item.text);
	return reply.node;
}

/** Whether `text` could be shown by rendering only its unfinished part. */
function updateStreamingReply(reply: StreamingReply, text: string): boolean {
	if (!text.startsWith(reply.stableText)) {
		return false;
	}
	const scan = scanStreaming(text, reply.stableText.length);
	const { node, fence } = reply;
	if (fence && scan.openFence?.start === fence.start && text.length >= fence.shown) {
		// Still the same open code block, and nothing before it changed: add the new code.
		appendCode(fence, text.slice(fence.shown));
		fence.shown = text.length;
		return true;
	}
	reply.fence = undefined;
	while (node.childNodes.length > reply.stableCount) {
		node.lastChild!.remove();
	}
	if (scan.stableEnd > reply.stableText.length) {
		const blocks = renderBlocks(text.slice(reply.stableText.length, scan.stableEnd));
		node.append(...blocks);
		reply.stableCount += blocks.length;
		reply.stableText = text.slice(0, scan.stableEnd);
	}
	const open = scan.openFence;
	if (open && open.start >= reply.stableText.length) {
		node.append(...renderBlocks(text.slice(reply.stableText.length, open.start)));
		// Render the empty block once for its classes and copy button, then fill in the code.
		const blocks = renderBlocks(`${open.opener}\n${open.opener.trimEnd().replace(/^([`~]+).*$/, '$1')}\n`);
		const code = blocks.map(b => b instanceof HTMLElement ? b.querySelector('code') : null).find(c => c);
		if (code) {
			node.append(...blocks);
			const tail = el('span', 'code-chunk');
			code.replaceChildren(tail);
			reply.fence = { start: open.start, code, shown: text.length, tail, tailLines: 0 };
			appendCode(reply.fence, text.slice(open.codeStart));
			return true;
		}
	}
	node.append(...renderBlocks(text.slice(reply.stableText.length)));
	return true;
}

/** Renders finished replies as a whole, which also mends anything split across blocks (a loose list). */
function finishStreamingReplies(): void {
	for (const id of [...streamingReplies.keys()]) {
		streamingReplies.delete(id);
		const item = items.find(i => i.id === id);
		if (item) {
			rerender(item);
		}
	}
}

function thoughtLabel(item: { readonly id: string }): string {
	const times = thoughtTimes.get(item.id);
	if (times?.end !== undefined) {
		return format(strings.thoughtFor, Math.max(1, Math.round((times.end - times.start) / 1000)));
	}
	return busy && items.at(-1)?.id === item.id ? strings.thinking : strings.thought;
}

function renderThought(item: { readonly id: string; readonly text: string }): HTMLElement {
	const details = el('details', 'thought');
	const summary = el('summary');
	const thinking = busy && items.at(-1)?.id === item.id;
	summary.append(icon('chevron-right', 'chevron'), el('span', thinking ? 'shimmer' : undefined, thoughtLabel(item)));
	// While it thinks, show what about, so a long think does not look idle.
	const preview = thinking ? thoughtPreview(item.text) : '';
	if (preview) {
		summary.append(el('span', 'thought-preview', preview));
	}
	const text = el('div', 'thought-text', item.text);
	// Animate opening by the user only, not the re-renders while it streams.
	summary.addEventListener('click', () => text.classList.toggle('reveal', !details.open));
	details.append(summary, text);
	return details;
}

const toolKindIcons: Record<string, string> = {
	read: 'file',
	edit: 'edit',
	delete: 'trash',
	move: 'arrow-right',
	search: 'search',
	execute: 'terminal',
	think: 'lightbulb',
	fetch: 'globe',
	switch_mode: 'arrow-swap',
};

function statusIcon(value: ItemOf<'toolCall'>['status']): HTMLElement {
	switch (value) {
		case 'pending': return icon('circle-large-outline', 'status-icon pending');
		case 'in_progress': return icon('loading', 'status-icon codicon-modifier-spin');
		case 'completed': return icon('check', 'status-icon completed');
		case 'failed': return icon('error', 'status-icon failed');
	}
}

function renderToolCall(item: ItemOf<'toolCall'>): HTMLElement {
	const card = el('div', `tool-call status-${item.status}`);
	const row = el('div', 'tool-row');
	row.append(icon(toolKindIcons[item.toolKind ?? ''] ?? 'tools', 'kind-icon'), el('span', 'tool-title', item.title));
	row.title = item.title;

	for (const location of item.locations) {
		const label = location.line ? `${basename(location.path)}:${location.line}` : basename(location.path);
		const chip = button('chip', label, () => vscode.postMessage({ type: 'openLocation', path: location.path, line: location.line }));
		chip.title = location.path;
		row.append(chip);
	}
	for (const detail of item.details) {
		if (detail.type === 'diff') {
			const chip = button('chip diff-chip', '', () => vscode.postMessage({ type: 'openDiff', itemId: item.id, path: detail.path }));
			chip.append(el('span', 'added', `+${detail.added}`), el('span', 'removed', `-${detail.removed}`));
			chip.title = `${strings.openDiff}: ${detail.path}`;
			row.append(chip);
		}
	}
	row.append(statusIcon(item.status));
	card.append(row);

	const body = el('div', 'tool-body');
	for (const detail of item.details) {
		if (detail.type === 'text' && detail.text.trim()) {
			body.append(el('pre', 'tool-output', detail.text));
		} else if (detail.type === 'terminal') {
			body.append(el('div', 'tool-note', strings.terminal));
		}
	}
	if (body.childElementCount) {
		card.classList.add('expandable');
		card.classList.toggle('expanded', expanded.has(item.id));
		row.prepend(icon('chevron-right', 'chevron'));
		row.tabIndex = 0;
		row.setAttribute('role', 'button');
		row.setAttribute('aria-expanded', String(expanded.has(item.id)));
		const toggle = () => {
			const opening = !expanded.delete(item.id);
			if (opening) {
				expanded.add(item.id);
			}
			upsert(item);
			if (opening) {
				elements.get(item.id)?.querySelector('.tool-body')?.classList.add('reveal');
			}
		};
		row.addEventListener('click', toggle);
		row.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				toggle();
			}
		});
		card.append(body);
	}
	return card;
}

function renderPlan(item: ItemOf<'plan'>): HTMLElement {
	const plan = el('div', 'plan');
	plan.append(el('div', 'plan-title', strings.plan));
	const list = el('ul');
	for (const entry of item.entries) {
		const li = el('li', `plan-${entry.status}`);
		const iconName = entry.status === 'completed' ? 'pass-filled' : entry.status === 'in_progress' ? 'circle-large-filled' : 'circle-large-outline';
		li.append(icon(iconName), el('span', undefined, entry.content));
		list.append(li);
	}
	plan.append(list);
	return plan;
}

function renderPermission(item: ItemOf<'permission'>): HTMLElement {
	const card = el('div', `permission${item.answer ? ' answered' : ''}`);
	const header = el('div', 'permission-title');
	header.append(icon(item.answer ? 'shield' : 'question'), el('span', undefined, item.title));
	card.append(header);
	if (item.diffPaths.length) {
		const files = el('div', 'permission-files');
		for (const filePath of item.diffPaths) {
			const chip = button('chip', basename(filePath), () => vscode.postMessage({ type: 'openDiff', itemId: item.id, path: filePath }), 'diff');
			chip.title = `${strings.openDiff}: ${filePath}`;
			files.append(chip);
		}
		card.append(files);
	}
	if (item.answer) {
		card.append(el('div', 'permission-answer', item.answer.kind === 'selected' ? format(strings.permissionAnswered, item.answer.name) : strings.permissionCancelled));
		return card;
	}
	const actions = el('div', 'permission-actions');
	const choose = (optionId: string) => vscode.postMessage({ type: 'permission', id: item.id, optionId });
	// "Allow" once is the primary action; other allows and rejections look secondary.
	const primary = item.options.find(o => o.kind === 'allow_once') ?? item.options.find(o => o.kind.startsWith('allow'));
	const reject = item.options.find(o => o.kind === 'reject_once') ?? item.options.find(o => o.kind.startsWith('reject'));
	for (const option of item.options) {
		actions.append(button(option === primary ? 'primary' : 'secondary', option.name, () => choose(option.optionId)));
	}
	if (reject) {
		actions.append(el('span', 'hint', strings.permissionHint));
		card.addEventListener('keydown', event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				choose(reject.optionId);
			}
		});
	}
	card.append(actions);
	return card;
}

function renderNotice(text: string, severity: 'info' | 'error'): HTMLElement {
	const node = el('div', `notice ${severity}`);
	node.append(icon(severity === 'error' ? 'error' : 'info'), el('span', undefined, text));
	return node;
}

function renderEmpty(): HTMLElement {
	const node = el('div', 'empty');
	node.append(icon('sparkle', 'empty-icon'), el('p', undefined, strings.welcome));
	return node;
}

// ---- Transcript ----------------------------------------------------------

function isNearBottom(): boolean {
	return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
}

function trackThoughts(previous: TranscriptItem | undefined, item: TranscriptItem): void {
	if (previous?.kind === 'thought') {
		const times = thoughtTimes.get(previous.id);
		if (times && times.end === undefined) {
			times.end = Date.now();
		}
	}
	if (item.kind === 'thought') {
		thoughtTimes.set(item.id, { start: Date.now() });
	}
}

function scrollToBottom(): void {
	transcript.scrollTop = transcript.scrollHeight;
}

/** Adds or replaces one item, keeping the view scrolled to the bottom if it was there. */
function upsert(item: TranscriptItem, live = false): void {
	const stick = isNearBottom();
	if (applyItem(item, live) || stick) {
		scrollToBottom();
	}
}

/** The index of the item with `id`; streaming updates are nearly always to the last one. */
function indexOfItem(id: string): number {
	return items.at(-1)?.id === id ? items.length - 1 : items.findIndex(existing => existing.id === id);
}

/**
 * Adds or replaces one item without touching the scroll position, so a batch
 * of them causes one layout rather than one each. True if the view should
 * scroll to the bottom whatever its position (the user's own message).
 */
function applyItem(item: TranscriptItem, live: boolean): boolean {
	const index = indexOfItem(item.id);
	let previous: TranscriptItem | undefined;
	if (index === -1) {
		previous = items.at(-1);
		if (live) {
			trackThoughts(previous, item);
		}
		items.push(item);
	} else {
		items[index] = item;
	}
	const existing = elements.get(item.id);
	const reply = item.kind === 'agent' && live && busy ? streamingReplies.get(item.id) : undefined;
	if (reply && item.kind === 'agent' && existing === reply.node && updateStreamingReply(reply, item.text)) {
		return false;
	}
	streamingReplies.delete(item.id);
	const node = item.kind === 'agent' && live && busy ? renderStreamingReply(item) : render(item);
	if (existing) {
		// Keep a thought open if the user opened it while it streamed.
		if (existing instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) {
			node.open = existing.open;
		}
		existing.replaceWith(node);
	} else {
		transcript.querySelector('.empty')?.remove();
		if (live) {
			// Only new items animate in, not ones shown again or restored.
			node.classList.add('enter');
		}
		transcript.append(node);
	}
	elements.set(item.id, node);
	if (previous?.kind === 'agent' && streamingReplies.has(previous.id)) {
		// Something came after the reply, so it is done.
		streamingReplies.delete(previous.id);
		rerender(previous);
	}
	if (previous?.kind === 'thought') {
		// It is no longer the last item, so it is no longer "Thinking".
		rerender(previous);
	}
	if (item.kind === 'permission' && !item.answer) {
		node.querySelector<HTMLButtonElement>('button.primary')?.focus();
	}
	return item.kind === 'user';
}

/** The item that `update` adds text to, with that text added. */
function appended(update: TextAppend): TranscriptItem | undefined {
	const current = items[indexOfItem(update.id)];
	return current?.kind === 'agent' || current?.kind === 'thought' ? { ...current, text: current.text + update.append } : undefined;
}

function rerender(item: TranscriptItem): void {
	const existing = elements.get(item.id);
	if (existing) {
		const node = render(item);
		if (existing instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) {
			node.open = existing.open;
		}
		existing.replaceWith(node);
		elements.set(item.id, node);
	}
}

function reset(newItems: readonly TranscriptItem[]): void {
	streamingReplies.clear();
	transcript.replaceChildren();
	elements.clear();
	items = [];
	// No layout reads while adding, so the whole transcript is laid out once.
	for (const item of newItems) {
		applyItem(item, false);
	}
	scrollToBottom();
	if (!items.length) {
		transcript.append(renderEmpty());
		expanded.clear();
		thoughtTimes.clear();
	}
	updatePlaceholder();
}

// ---- Composer ------------------------------------------------------------

/** Three pulsing dots after the user's message, until the agent's first reply, thought or tool call. */
const working = el('div', 'working');
working.setAttribute('aria-hidden', 'true');
working.append(el('span'), el('span'), el('span'));

function updateWorking(): void {
	if (busy && items.at(-1)?.kind === 'user') {
		if (transcript.lastElementChild !== working) {
			transcript.append(working);
		}
	} else {
		working.remove();
	}
}

function setBusy(value: boolean): void {
	busy = value;
	stopButton.hidden = !value;
	sendButton.hidden = value;
	if (!value) {
		finishStreamingReplies();
		// The turn ended: a thought that was still last has ended too.
		const last = items.at(-1);
		if (last?.kind === 'thought') {
			const times = thoughtTimes.get(last.id);
			if (times && times.end === undefined) {
				times.end = Date.now();
			}
		}
	}
	const last = items.at(-1);
	if (last?.kind === 'thought') {
		rerender(last);
	}
	updateWorking();
	updateSendState();
}

function setStatus(value: ViewStatus): void {
	status.className = `status ${value.phase}`;
	status.replaceChildren();
	if (value.text) {
		if (value.phase === 'error') {
			status.append(icon('warning'));
		} else if (value.phase === 'starting' || value.phase === 'restarting') {
			status.append(icon('loading', 'codicon-modifier-spin'));
		}
		status.append(el('span', 'status-text', value.text));
		for (const action of value.actions ?? []) {
			status.append(button('status-action', action.label, () => vscode.postMessage({ type: 'command', command: action.command })));
		}
	}
	status.hidden = !value.text;
}

const measureContext = document.createElement('canvas').getContext('2d');

/** A select is as wide as its longest option; size it to the chosen one instead. */
function fitSelect(select: HTMLSelectElement): void {
	const text = select.selectedOptions[0]?.textContent ?? '';
	const style = getComputedStyle(select);
	if (!measureContext) {
		return;
	}
	measureContext.font = style.font;
	const chrome = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
	select.style.width = `${Math.ceil(measureContext.measureText(text).width + chrome)}px`;
}

function fillSelect(select: HTMLSelectElement, selector: SessionSelector | undefined): void {
	select.parentElement!.hidden = !selector;
	if (!selector) {
		return;
	}
	select.replaceChildren(...selector.available.map(choice => {
		const option = el('option', undefined, choice.name);
		option.value = choice.id;
		if (choice.description) {
			option.title = choice.description;
		}
		return option;
	}));
	select.value = selector.currentId;
	fitSelect(select);
	const current = selector.available.find(choice => choice.id === selector.currentId);
	select.title = current?.description ? `${select.getAttribute('aria-label')}: ${current.description}` : select.getAttribute('aria-label') ?? '';
}

function setSettings(settings: SessionSettings): void {
	fillSelect(modeSelect, settings.mode);
	fillSelect(modelSelect, settings.model);
}

function setGit(git: ViewGit): void {
	branchButton.hidden = !git.branch;
	branchButton.querySelector('span')!.textContent = git.branch ?? '';
	const branchLabel = format(strings.switchBranch, git.branch ?? '');
	branchButton.title = branchLabel;
	branchButton.setAttribute('aria-label', branchLabel);
	commitButton.hidden = !git.canCommit || !git.branch;
	commitButton.querySelector('span')!.textContent = strings.createBranchAndCommit;
	commitButton.title = strings.createBranchAndCommit;
}

function updatePlaceholder(): void {
	input.placeholder = items.some(item => item.kind === 'user') ? strings.placeholderFollowUp : strings.placeholder;
}

function updateSendState(): void {
	sendButton.disabled = busy || (!input.value.trim() && !attachments.length);
}

// ---- Attachments and the @-mention picker --------------------------------

let attachments: Attachment[] = [];
let imageInput = false;

function sameAttachment(a: Attachment, b: Attachment): boolean {
	if (a.kind === 'file' && b.kind === 'file') {
		return a.path === b.path;
	}
	if (a.kind === 'selection' && b.kind === 'selection') {
		return a.path === b.path && a.startLine === b.startLine && a.endLine === b.endLine;
	}
	if (a.kind === 'document' && b.kind === 'document') {
		return a.path !== undefined ? a.path === b.path : a.name === b.name && a.text === b.text && a.data === b.data;
	}
	return a.kind === 'image' && b.kind === 'image' && a.data === b.data;
}

function addAttachments(added: readonly Attachment[]): void {
	for (const attachment of added) {
		if (!attachments.some(existing => sameAttachment(existing, attachment))) {
			attachments.push(attachment);
		}
	}
	renderAttachments();
	input.focus();
}

function renderAttachments(): void {
	attachmentList.replaceChildren(...attachments.map(attachment => {
		const chip = el('span', 'chip attachment');
		if (attachment.kind === 'image') {
			const thumbnail = el('img', 'thumbnail');
			thumbnail.src = `data:${attachment.mimeType};base64,${attachment.data}`;
			thumbnail.alt = '';
			chip.append(thumbnail);
		} else {
			chip.append(icon(attachmentIcon(attachment.kind, attachmentLabel(attachment))));
			chip.title = attachment.path ?? attachmentLabel(attachment);
		}
		chip.append(el('span', undefined, attachmentLabel(attachment)));
		const remove = button('chip-remove', '', () => {
			attachments = attachments.filter(a => a !== attachment);
			renderAttachments();
			input.focus();
		}, 'close');
		remove.title = strings.remove;
		remove.setAttribute('aria-label', `${strings.remove} ${attachmentLabel(attachment)}`);
		chip.append(remove);
		return chip;
	}));
	attachmentList.hidden = !attachments.length;
	updateSendState();
}

interface PickerState {
	/** Where the "@" is in the input. */
	readonly start: number;
	query: string;
	files: readonly { readonly path: string; readonly relative: string }[];
	active: number;
}

let pickerState: PickerState | undefined;
let lastSearchId = 0;

/** The "@word" just before the caret, if the caret is in one. */
function mentionAtCaret(): { start: number; query: string } | undefined {
	const caret = input.selectionStart;
	if (caret !== input.selectionEnd) {
		return undefined;
	}
	const match = /(^|\s)@([^\s@]*)$/.exec(input.value.slice(0, caret));
	return match ? { start: caret - match[2].length - 1, query: match[2] } : undefined;
}

function updatePicker(): void {
	const mention = mentionAtCaret();
	if (!mention) {
		closePicker();
		return;
	}
	if (pickerState?.start === mention.start && pickerState.query === mention.query) {
		return;
	}
	pickerState = { start: mention.start, query: mention.query, files: pickerState?.start === mention.start ? pickerState.files : [], active: 0 };
	vscode.postMessage({ type: 'searchFiles', requestId: ++lastSearchId, query: mention.query });
	renderPicker();
}

function closePicker(): void {
	pickerState = undefined;
	picker.hidden = true;
	input.removeAttribute('aria-activedescendant');
}

function renderPicker(): void {
	const state = pickerState;
	if (!state) {
		return;
	}
	picker.hidden = false;
	if (!state.files.length) {
		picker.replaceChildren(el('div', 'picker-empty', strings.noFiles));
		return;
	}
	picker.replaceChildren(...state.files.map((file, index) => {
		const row = el('div', `picker-row${index === state.active ? ' active' : ''}`);
		row.id = `picker-${index}`;
		row.setAttribute('role', 'option');
		row.setAttribute('aria-selected', String(index === state.active));
		const folder = file.relative.includes('/') ? file.relative.slice(0, file.relative.lastIndexOf('/')) : '';
		row.append(icon('file'), el('span', 'picker-name', basename(file.relative)), el('span', 'picker-folder', folder));
		row.title = file.relative;
		// mousedown, so the input keeps focus.
		row.addEventListener('mousedown', event => {
			event.preventDefault();
			pick(index);
		});
		return row;
	}));
	input.setAttribute('aria-activedescendant', `picker-${state.active}`);
	picker.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function pick(index: number): void {
	const state = pickerState;
	const file = state?.files[index];
	if (!state || !file) {
		return;
	}
	// Replace the typed "@query" with nothing; the chip shows the file.
	const end = state.start + 1 + state.query.length;
	input.value = input.value.slice(0, state.start) + input.value.slice(end);
	input.setSelectionRange(state.start, state.start);
	closePicker();
	addAttachments([{ kind: 'file', path: file.path }]);
	autoGrow();
}

function onPickerKey(event: KeyboardEvent): boolean {
	const state = pickerState;
	if (!state || picker.hidden) {
		return false;
	}
	switch (event.key) {
		case 'ArrowDown':
		case 'ArrowUp':
			if (state.files.length) {
				state.active = (state.active + (event.key === 'ArrowDown' ? 1 : -1) + state.files.length) % state.files.length;
				renderPicker();
			}
			return true;
		case 'Enter':
		case 'Tab':
			if (state.files.length) {
				pick(state.active);
				return true;
			}
			return false;
		case 'Escape':
			closePicker();
			return true;
	}
	return false;
}

function readImage(file: File): Promise<Attachment | undefined> {
	return new Promise(resolve => {
		const reader = new FileReader();
		reader.onload = () => {
			const data = String(reader.result).replace(/^data:[^,]*,/, '');
			if (data.length > maxImageBase64Length) {
				setTransientNotice(format(strings.imageTooLarge, file.name || 'image'));
				resolve(undefined);
				return;
			}
			resolve({ kind: 'image', name: file.name || `image.${file.type.split('/')[1] ?? 'png'}`, mimeType: file.type, data });
		};
		reader.onerror = () => resolve(undefined);
		reader.readAsDataURL(file);
	});
}

/** File URIs in a drop, such as from the Explorer (which needs Shift held to drop into a view). */
function droppedUris(data: DataTransfer): string[] {
	const list = data.getData('application/vnd.code.uri-list') || data.getData('text/uri-list');
	return list.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('file:'));
}

function readBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

/** A file without a path (dropped from Finder or pasted) sent with its contents, if it can be. */
async function readDroppedFile(file: File): Promise<Attachment | undefined> {
	const name = file.name || 'file';
	if (imageInput && supportedImageTypes.has(file.type)) {
		return readImage(file);
	}
	const content = classifyFile(name, file.type, new Uint8Array(await file.arrayBuffer()));
	switch (content.kind) {
		case 'text':
			return { kind: 'document', name, mimeType: 'text/plain', text: content.text };
		case 'inline':
			return { kind: 'document', name, mimeType: content.mimeType, data: await readBase64(file) };
		case 'tooLarge':
			setTransientNotice(format(strings.imageTooLarge, name));
			return undefined;
		case 'unsupported':
			setTransientNotice(format(strings.cannotAttach, name));
			return undefined;
	}
}

/**
 * Takes the files from a paste or drop. Ones with paths go to the extension,
 * which links workspace files and reads others; ones without are read here.
 */
function takeFiles(data: DataTransfer | null): boolean {
	if (!data) {
		return false;
	}
	const uris = droppedUris(data);
	if (uris.length) {
		vscode.postMessage({ type: 'attachUris', uris });
		return true;
	}
	const files = [...data.files];
	if (!files.length) {
		return false;
	}
	void Promise.all(files.map(file => readDroppedFile(file).catch(() => undefined)))
		.then(added => addAttachments(added.filter((a): a is Attachment => !!a)));
	return true;
}

function carriesFiles(data: DataTransfer | null): boolean {
	const types = data?.types ?? [];
	return types.includes('Files') || types.includes('text/uri-list') || types.includes('application/vnd.code.uri-list');
}

function setTransientNotice(text: string): void {
	const notice = renderNotice(text, 'error');
	transcript.append(notice);
	transcript.scrollTop = transcript.scrollHeight;
	setTimeout(() => notice.remove(), 6000);
}

/** Height the user dragged the composer to; the input never gets shorter than this. */
let userHeight = 0;

/**
 * Applies the dragged height. The input grows with its text by itself (CSS
 * field-sizing), so typing never measures it, which would lay out the whole
 * transcript on every keystroke.
 */
function autoGrow(): void {
	input.style.minHeight = userHeight ? `${userHeight}px` : '';
	// It grows with its text to 40% of the view, or further if dragged taller.
	input.style.maxHeight = userHeight ? `max(40vh, ${userHeight}px)` : '';
}

// Dragging the composer's top edge resizes the input; a double-click resets it.
resizeHandle.addEventListener('pointerdown', event => {
	event.preventDefault();
	resizeHandle.setPointerCapture(event.pointerId);
	const startY = event.clientY;
	const startHeight = input.getBoundingClientRect().height;
	let moved = false;
	const onMove = (move: PointerEvent) => {
		moved = true;
		const limit = Math.max(60, window.innerHeight * 0.7);
		userHeight = Math.min(limit, Math.max(20, startHeight + startY - move.clientY));
		autoGrow();
	};
	const onUp = () => {
		resizeHandle.removeEventListener('pointermove', onMove);
		resizeHandle.removeEventListener('pointerup', onUp);
		resizeHandle.removeEventListener('pointercancel', onUp);
		input.focus();
		if (moved) {
			// Remembered for every chat, also after a restart.
			vscode.postMessage({ type: 'composerHeight', height: userHeight });
		}
	};
	resizeHandle.addEventListener('pointermove', onMove);
	resizeHandle.addEventListener('pointerup', onUp);
	resizeHandle.addEventListener('pointercancel', onUp);
});
resizeHandle.addEventListener('dblclick', () => {
	userHeight = 0;
	autoGrow();
	vscode.postMessage({ type: 'composerHeight', height: 0 });
});

function submit(): void {
	const text = input.value;
	if (busy || (!text.trim() && !attachments.length)) {
		return;
	}
	vscode.postMessage({ type: 'prompt', text, attachments });
	attachments = [];
	renderAttachments();
	closePicker();
	input.value = '';
	autoGrow();
	updateSendState();
}

form.addEventListener('submit', event => {
	event.preventDefault();
	submit();
});
form.addEventListener('click', event => {
	if (event.target === form) {
		input.focus();
	}
});
input.addEventListener('keydown', event => {
	if (!event.isComposing && onPickerKey(event)) {
		event.preventDefault();
		event.stopPropagation();
		return;
	}
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		submit();
	}
});
input.addEventListener('input', () => {
	autoGrow();
	updateSendState();
	updatePicker();
});
input.addEventListener('click', updatePicker);
input.addEventListener('blur', () => setTimeout(() => {
	if (document.activeElement !== input) {
		closePicker();
	}
}, 0));
input.addEventListener('paste', event => {
	// Pasted files only; pasted text (and a link list copied as text) stays text.
	if (event.clipboardData?.files.length && takeFiles(event.clipboardData)) {
		event.preventDefault();
	}
});
// Files can be dropped anywhere in the view; the composer shows where they go.
document.addEventListener('dragover', event => {
	if (carriesFiles(event.dataTransfer)) {
		event.preventDefault();
		event.dataTransfer!.dropEffect = 'copy';
		form.classList.add('dragging');
	}
});
document.addEventListener('dragleave', event => {
	// Leaving the view, not just moving between its elements.
	if (!event.relatedTarget) {
		form.classList.remove('dragging');
	}
});
document.addEventListener('drop', event => {
	form.classList.remove('dragging');
	if (takeFiles(event.dataTransfer)) {
		event.preventDefault();
	}
});
attachButton.addEventListener('click', () => vscode.postMessage({ type: 'pickFiles' }));
mentionButton.addEventListener('click', () => {
	// Insert "@" at the caret (with a space before it when needed) and open the picker.
	const caret = input.selectionStart;
	const before = input.value.slice(0, caret);
	const insert = before && !/\s$/.test(before) ? ' @' : '@';
	input.setRangeText(insert, caret, input.selectionEnd, 'end');
	input.focus();
	autoGrow();
	updatePicker();
});
stopButton.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
branchButton.addEventListener('click', () => vscode.postMessage({ type: 'pickBranch' }));
commitButton.addEventListener('click', () => vscode.postMessage({ type: 'createBranchAndCommit' }));
modeSelect.addEventListener('change', () => {
	fitSelect(modeSelect);
	vscode.postMessage({ type: 'setMode', id: modeSelect.value });
});
modelSelect.addEventListener('change', () => {
	fitSelect(modelSelect);
	vscode.postMessage({ type: 'setModel', id: modelSelect.value });
});

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
	const message = event.data;
	switch (message.type) {
		case 'reset':
			busy = message.busy;
			reset(message.items);
			setBusy(message.busy);
			setStatus(message.status);
			setSettings(message.settings);
			break;
		case 'items': {
			const stick = isNearBottom();
			let scroll = stick;
			for (const update of message.items) {
				const item = update.kind === 'append' ? appended(update) : update;
				if (item) {
					scroll = applyItem(item, true) || scroll;
				}
			}
			updateWorking();
			if (scroll) {
				scrollToBottom();
			}
			updatePlaceholder();
			break;
		}
		case 'busy':
			setBusy(message.busy);
			break;
		case 'status':
			setStatus(message.status);
			break;
		case 'settings':
			setSettings(message.settings);
			break;
		case 'capabilities':
			imageInput = message.image;
			break;
		case 'composerHeight':
			userHeight = window.innerHeight ? Math.min(message.height, Math.max(60, window.innerHeight * 0.7)) : message.height;
			autoGrow();
			break;
		case 'files':
			if (pickerState && message.requestId === lastSearchId) {
				pickerState.files = message.files;
				pickerState.active = 0;
				renderPicker();
			}
			break;
		case 'attach':
			addAttachments(message.attachments);
			break;
		case 'git':
			setGit(message.git);
			break;
	}
});

vscode.postMessage({ type: 'ready', protocol: chatProtocolVersion });
updateSendState();
input.focus();
