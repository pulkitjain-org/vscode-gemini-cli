/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Renders transcript items. Agent and user Markdown is rendered by markdown-it
// with raw HTML disabled, so message text can never inject markup; everything
// else is set with textContent.

import MarkdownIt from 'markdown-it';
import { basename } from '../src/acp/attachments';
import type { PromptAttachmentLabel, TranscriptItem } from '../src/acp/chatTranscript';
import type { ViewSession } from '../src/host/chatProtocol';
import { attachmentIcon, codeLanguage, format, formatDuration, formatSentAt, permissionDefaults, planIcon, replyBefore, thoughtSeconds, toolKindIcon, type ItemOf } from './chatLogic';
import { highlightCode } from './codeHighlight';
import { enhanceMarkdown } from './markdownExtras';
import { button, copyButton, el, icon, setLabel } from './dom';
import { thoughtPreview } from './streaming';
import { expanded, state, strings, thoughtTimes, ui, vscode } from './view';

const mac = /Mac/.test(navigator.platform);

const markdown = new MarkdownIt({ html: false, linkify: true });
// Only links with a scheme or www.; file names such as README.md are not web addresses.
markdown.linkify.set({ fuzzyLink: false });
// The user's own messages keep their line breaks, as typed.
const userMarkdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
userMarkdown.linkify.set({ fuzzyLink: false });

/** Called when the user expands or collapses a tool call's output. */
export type ToggleToolCall = (item: ItemOf<'toolCall'>) => void;

export function render(item: TranscriptItem, toggleToolCall: ToggleToolCall): HTMLElement {
	switch (item.kind) {
		case 'user':
			return renderUserMessage(item);
		case 'agent':
			return renderMarkdown(item.text);
		case 'thought':
			return renderThought(item);
		case 'toolCall':
			return renderToolCall(item, toggleToolCall);
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

function renderTurnEnd(item: ItemOf<'turnEnd'>): HTMLElement {
	const node = el('div', 'turn-end');
	node.append(el('span', undefined, format(strings.workedFor, formatDuration(item.durationMs))));
	if (item.at) {
		node.append(el('span', 'turn-dot', '\u00b7'), sentAt(item.at));
	}
	node.append(copyButton('copy-reply', strings.copyReply, () => replyBefore(state.items, item.id)));
	if (item.retry) {
		const retry = button('turn-action', strings.retry, () => vscode.postMessage({ type: 'retry', itemId: item.id }), 'refresh');
		setLabel(retry, strings.retryTooltip);
		node.append(retry);
	}
	if (item.buildPlan) {
		const build = button('turn-action', strings.buildPlan, () => vscode.postMessage({ type: 'buildPlan', itemId: item.id }), 'play');
		setLabel(build, strings.buildPlanTooltip);
		node.append(build);
	}
	if (item.undo === 'available') {
		const undo = button('turn-action undo-turn', strings.undoTurn, () => vscode.postMessage({ type: 'undoTurn', itemId: item.id }), 'discard');
		setLabel(undo, item.files && item.files > 1 ? format(strings.undoTurnFiles, item.files) : strings.undoTurnTooltip);
		node.append(undo);
	} else if (item.undo === 'undone') {
		node.append(el('span', 'turn-undone', strings.turnUndone));
	}
	return node;
}

/** A message's time, with the full date and time as its tooltip. */
function sentAt(at: number): HTMLElement {
	const time = el('time', 'sent-at', formatSentAt(at, Date.now()));
	time.dateTime = new Date(at).toISOString();
	time.title = new Date(at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' });
	return time;
}

/** The user's message, with its time and Copy under it, shown on hover. */
function renderUserMessage(item: { readonly text: string; readonly attachments?: readonly PromptAttachmentLabel[]; readonly at?: number }): HTMLElement {
	const turn = el('div', 'user-turn');
	const node = el('div', 'message user');
	turn.append(node);
	if (item.text) {
		const text = el('div', 'user-text markdown');
		text.append(...renderUserMarkdown(item.text));
		node.append(text);
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
	const meta = el('div', 'user-meta');
	if (item.at) {
		meta.append(sentAt(item.at));
	}
	if (item.text) {
		meta.append(copyButton('copy-message', strings.copyMessage, () => item.text));
	}
	if (meta.childElementCount) {
		turn.append(meta);
	}
	return turn;
}

function renderMarkdown(text: string): HTMLElement {
	const node = el('div', 'message agent markdown');
	node.append(...renderBlocks(text));
	return node;
}

/** The user's Markdown as nodes, with line breaks as typed. */
export function renderUserMarkdown(text: string): Node[] {
	return renderBlocks(text, userMarkdown);
}

/** Markdown as nodes, with each code block under a header that names its language and copies it. */
export function renderBlocks(text: string, renderer = markdown): Node[] {
	const node = el('div');
	node.innerHTML = renderer.render(text);
	enhanceMarkdown(node);
	for (const pre of node.querySelectorAll('pre')) {
		const wrapper = el('div', 'code-block');
		pre.replaceWith(wrapper);
		const header = el('div', 'code-header');
		const code = pre.querySelector('code');
		const language = codeLanguage(code?.className ?? '');
		header.append(el('span', 'code-language', language), copyButton('copy', strings.copy, () => pre.textContent ?? ''));
		wrapper.append(header, pre);
		if (code) {
			highlightCode(code, language.toLowerCase());
		}
	}
	return [...node.childNodes];
}

function thoughtLabel(item: { readonly id: string }, thinking: boolean): string {
	const times = thoughtTimes.get(item.id);
	if (times?.end !== undefined) {
		return format(strings.thoughtFor, thoughtSeconds(times.start, times.end));
	}
	return thinking ? strings.thinking : strings.thought;
}

function renderThought(item: { readonly id: string; readonly text: string }): HTMLElement {
	const details = el('details', 'thought');
	const summary = el('summary');
	const thinking = state.busy && state.items.at(-1)?.id === item.id;
	summary.append(icon('chevron-right', 'chevron'), el('span', thinking ? 'shimmer' : undefined, thoughtLabel(item, thinking)));
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

function statusIcon(value: ItemOf<'toolCall'>['status']): HTMLElement {
	switch (value) {
		case 'pending': return icon('circle-large-outline', 'status-icon pending');
		case 'in_progress': return icon('loading', 'status-icon codicon-modifier-spin');
		case 'completed': return icon('check', 'status-icon completed');
		case 'failed': return icon('error', 'status-icon failed');
	}
}

function renderToolCall(item: ItemOf<'toolCall'>, toggleToolCall: ToggleToolCall): HTMLElement {
	const card = el('div', `tool-call status-${item.status}`);
	const row = el('div', 'tool-row');
	// "Read src/cart/total.ts": the verb in the text colour, what it acted on quieter.
	const [verb, target] = splitToolTitle(item.title);
	const title = el('span', 'tool-title');
	title.append(el('span', 'tool-verb', verb));
	if (target) {
		title.append(` ${target}`);
	}
	row.append(icon(toolKindIcon(item.toolKind), 'kind-icon'), title);
	row.title = item.title;

	for (const location of item.locations) {
		// A file the title already names needs no chip of its own; the title opens it.
		const named = !item.details.some(detail => detail.type === 'text' || detail.type === 'terminal') && item.locations.length === 1 && item.title.includes(basename(location.path));
		const open = () => vscode.postMessage({ type: 'openLocation', path: location.path, line: location.line });
		if (named) {
			title.classList.add('tool-link');
			title.addEventListener('click', open);
			title.title = location.path;
			continue;
		}
		const label = location.line ? `${basename(location.path)}:${location.line}` : basename(location.path);
		const chip = button('chip', label, open);
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
		row.addEventListener('click', () => toggleToolCall(item));
		row.addEventListener('keydown', event => {
			// Not when a file or diff chip inside the row has focus.
			if (event.target === row && (event.key === 'Enter' || event.key === ' ')) {
				event.preventDefault();
				toggleToolCall(item);
			}
		});
		card.append(body);
	}
	return card;
}

/** A tool call's title as its first word and the rest. */
function splitToolTitle(title: string): readonly [string, string] {
	const space = title.indexOf(' ');
	return space === -1 ? [title, ''] : [title.slice(0, space), title.slice(space + 1)];
}

function renderPlan(item: ItemOf<'plan'>): HTMLElement {
	const plan = el('div', 'plan');
	plan.append(el('div', 'plan-title', strings.plan));
	const list = el('ul');
	for (const entry of item.entries) {
		const li = el('li', `plan-${entry.status}`);
		li.append(icon(planIcon(entry.status), entry.status === 'in_progress' ? 'codicon-modifier-spin' : ''), el('span', undefined, entry.content));
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
	const { primary, reject } = permissionDefaults(item.options);
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

export function renderNotice(text: string, severity: 'info' | 'error'): HTMLElement {
	const node = el('div', `notice ${severity}`);
	node.append(icon(severity === 'error' ? 'error' : 'info'), el('span', undefined, text));
	return node;
}

/** The saved sessions last sent, so the empty chat shows them again when it is drawn again. */
let savedSessions: { readonly sessions: readonly ViewSession[]; readonly total: number; readonly retention: string } = { sessions: [], total: 0, retention: '' };

/** The empty chat's card of saved sessions to reopen; nothing when there are none. */
export function showSavedSessions(sessions: readonly ViewSession[], total: number, retention: string): void {
	savedSessions = { sessions, total, retention };
	const empty = ui.transcript.querySelector('.empty');
	empty?.querySelector('.restore-card')?.remove();
	const card = restoreCard();
	if (empty && card) {
		empty.append(card);
	}
}

function restoreCard(): HTMLElement | undefined {
	const { sessions, total } = savedSessions;
	if (!sessions.length) {
		return undefined;
	}
	const card = el('section', 'restore-card');
	const header = el('h3', 'restore-header');
	header.append(icon('history'), el('span', undefined, strings.restoreTitle));
	card.append(header, el('p', 'restore-hint', strings.restoreHint));
	for (const session of sessions) {
		const row = el('div', 'restore-row');
		const text = el('div', 'restore-text');
		text.append(el('span', 'restore-title', session.title), el('span', 'restore-detail', session.detail));
		text.title = session.title;
		row.append(text, button('restore-button', strings.restore, () => vscode.postMessage({ type: 'restoreSession', id: session.id })));
		card.append(row);
	}
	if (total > sessions.length) {
		card.append(button('restore-more', format(strings.showAllSessions, total), () => vscode.postMessage({ type: 'pickSession' })));
	}
	if (savedSessions.retention) {
		card.append(el('p', 'restore-hint restore-retention', savedSessions.retention));
	}
	return card;
}

export function renderEmpty(): HTMLElement {
	const node = el('div', 'empty');
	const hints = el('ul', 'empty-hints');
	for (const [key, text] of [['@', strings.hintMention], ['/', strings.hintCommands], [mac ? '⇧↩' : 'Shift+Enter', strings.hintNewLine], ['', strings.dropFiles]] as const) {
		const hint = el('li');
		hint.append(key ? el('kbd', undefined, key) : icon('cloud-upload'), el('span', undefined, text));
		hints.append(hint);
	}
	node.append(icon('sparkle', 'empty-icon'), el('h2', 'empty-title', strings.welcomeTitle), el('p', undefined, strings.welcome), hints);
	const card = restoreCard();
	if (card) {
		node.append(card);
	}
	return node;
}
