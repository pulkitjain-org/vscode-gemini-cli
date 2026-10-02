/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat view's webview. It renders the transcript items the extension
// sends (src/acp/chatTranscript.ts) and posts prompts back. Agent Markdown is
// rendered by markdown-it with raw HTML disabled, so agent text can never
// inject markup; everything else is set with textContent.

import MarkdownIt from 'markdown-it';
import { Attachment, attachmentLabel, basename, maxImageBase64Length, supportedImageTypes } from '../src/acp/attachments';
import type { PromptAttachmentLabel, TranscriptItem } from '../src/acp/chatTranscript';
import type { SessionSelector, SessionSettings } from '../src/acp/sessionSettings';
import { chatProtocolVersion, type ChatStrings, type FromWebview, type ToWebview, type ViewStatus } from '../src/host/chatProtocol';

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

mentionButton.title = strings.addContext;
mentionButton.setAttribute('aria-label', strings.addContext);

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
	}
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
				? button('chip', attachment.label, () => vscode.postMessage({ type: 'openLocation', path, line }), attachmentIcon(attachment.kind))
				: el('span', 'chip static');
			if (!path) {
				chip.append(icon(attachmentIcon(attachment.kind)), el('span', undefined, attachment.label));
			}
			chip.title = path ?? attachment.label;
			chips.append(chip);
		}
		node.append(chips);
	}
	return node;
}

function attachmentIcon(kind: Attachment['kind']): string {
	return kind === 'image' ? 'file-media' : kind === 'selection' ? 'list-selection' : 'file';
}

function renderMarkdown(text: string): HTMLElement {
	const node = el('div', 'message agent markdown');
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
	return node;
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
	details.append(summary, el('div', 'thought-text', item.text));
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
			if (!expanded.delete(item.id)) {
				expanded.add(item.id);
			}
			upsert(item);
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

function upsert(item: TranscriptItem, live = false): void {
	const stick = isNearBottom();
	const index = items.findIndex(existing => existing.id === item.id);
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
	const node = render(item);
	if (existing) {
		// Keep a thought open if the user opened it while it streamed.
		if (existing instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) {
			node.open = existing.open;
		}
		existing.replaceWith(node);
	} else {
		transcript.querySelector('.empty')?.remove();
		transcript.append(node);
	}
	elements.set(item.id, node);
	if (previous?.kind === 'thought') {
		// It is no longer the last item, so it is no longer "Thinking".
		rerender(previous);
	}
	if (item.kind === 'permission' && !item.answer) {
		node.querySelector<HTMLButtonElement>('button.primary')?.focus();
	}
	if (stick || item.kind === 'user') {
		transcript.scrollTop = transcript.scrollHeight;
	}
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
	transcript.replaceChildren();
	elements.clear();
	items = [];
	for (const item of newItems) {
		upsert(item);
	}
	if (!items.length) {
		transcript.append(renderEmpty());
		expanded.clear();
		thoughtTimes.clear();
	}
	updatePlaceholder();
}

// ---- Composer ------------------------------------------------------------

function setBusy(value: boolean): void {
	busy = value;
	stopButton.hidden = !value;
	sendButton.hidden = value;
	if (!value) {
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
			chip.append(icon(attachmentIcon(attachment.kind)));
			chip.title = attachment.path;
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

/** Takes the images from a paste or drop when the agent accepts images. */
function takeImages(data: DataTransfer | null): boolean {
	const files = imageInput ? [...data?.files ?? []].filter(file => supportedImageTypes.has(file.type)) : [];
	if (!files.length) {
		return false;
	}
	void Promise.all(files.map(readImage)).then(images => addAttachments(images.filter((i): i is Attachment => !!i)));
	return true;
}

function setTransientNotice(text: string): void {
	const notice = renderNotice(text, 'error');
	transcript.append(notice);
	transcript.scrollTop = transcript.scrollHeight;
	setTimeout(() => notice.remove(), 6000);
}

/** Height the user dragged the composer to; the input never gets shorter than this. */
let userHeight = 0;

function autoGrow(): void {
	input.style.height = 'auto';
	const max = Math.max(200, userHeight);
	input.style.height = `${Math.max(userHeight, Math.min(input.scrollHeight, max))}px`;
}

// Dragging the composer's top edge resizes the input; a double-click resets it.
resizeHandle.addEventListener('pointerdown', event => {
	event.preventDefault();
	resizeHandle.setPointerCapture(event.pointerId);
	const startY = event.clientY;
	const startHeight = input.getBoundingClientRect().height;
	const onMove = (move: PointerEvent) => {
		const limit = Math.max(60, window.innerHeight * 0.7);
		userHeight = Math.min(limit, Math.max(20, startHeight + startY - move.clientY));
		autoGrow();
	};
	const onUp = () => {
		resizeHandle.removeEventListener('pointermove', onMove);
		resizeHandle.removeEventListener('pointerup', onUp);
		resizeHandle.removeEventListener('pointercancel', onUp);
		input.focus();
	};
	resizeHandle.addEventListener('pointermove', onMove);
	resizeHandle.addEventListener('pointerup', onUp);
	resizeHandle.addEventListener('pointercancel', onUp);
});
resizeHandle.addEventListener('dblclick', () => {
	userHeight = 0;
	autoGrow();
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
	if (takeImages(event.clipboardData)) {
		event.preventDefault();
	}
});
form.addEventListener('dragover', event => {
	if (imageInput && event.dataTransfer?.types.includes('Files')) {
		event.preventDefault();
	}
});
form.addEventListener('drop', event => {
	if (takeImages(event.dataTransfer)) {
		event.preventDefault();
	}
});
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
		case 'items':
			for (const item of message.items) {
				upsert(item, true);
			}
			updatePlaceholder();
			break;
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
	}
});

vscode.postMessage({ type: 'ready', protocol: chatProtocolVersion });
updateSendState();
input.focus();
