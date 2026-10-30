/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat view's decisions that need no DOM, so they can be tested.

/// <reference lib="es2025.intl" />

import type { Attachment } from '../src/acp/attachments';
import type { TranscriptItem } from '../src/acp/chatTranscript';
import type { ItemUpdate, TextAppend } from '../src/acp/textDeltas';
import { thoughtPreview } from './streaming';

export type ItemOf<K extends TranscriptItem['kind']> = Extract<TranscriptItem, { kind: K }>;

/** Puts `values` in place of "{0}", "{1}" and so on in a localized string. */
export function format(template: string, ...values: (string | number)[]): string {
	return template.replace(/\{(\d+)\}/g, (match, i) => i < values.length ? String(values[Number(i)]) : match);
}

/** When a message was sent: the time alone today, with the day before that ("10:42", "3 Oct, 10:42"). */
export function formatSentAt(at: number, now: number, locale?: string): string {
	const sent = new Date(at);
	const time = sent.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
	if (sent.toDateString() === new Date(now).toDateString()) {
		return time;
	}
	const sameYear = sent.getFullYear() === new Date(now).getFullYear();
	return `${sent.toLocaleDateString(locale, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })}, ${time}`;
}

/** Formatters for `formatDuration`, by locale and by its largest unit. */
const durationFormats = new Map<string, Intl.DurationFormat>();

/** "12s", "2m 5s" or "1h 3m" in English: the two largest units, narrow, as the locale writes them. */
export function formatDuration(ms: number, locale?: string): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	const unit = seconds < 60 ? 'seconds' : minutes < 60 ? 'minutes' : 'hours';
	const key = `${locale}|${unit}`;
	let formatter = durationFormats.get(key);
	if (!formatter) {
		// The smaller unit shows even when it is 0 ("2m 0s"), as the larger one leads.
		formatter = new Intl.DurationFormat(locale, { style: 'narrow', ...unit === 'minutes' ? { secondsDisplay: 'always' } : unit === 'hours' ? { minutesDisplay: 'always' } : {} });
		durationFormats.set(key, formatter);
	}
	return formatter.format(unit === 'seconds' ? { seconds } : unit === 'minutes' ? { minutes, seconds: seconds % 60 } : { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/** How long a thought took, in whole seconds and at least one. */
export function thoughtSeconds(start: number, end: number): number {
	return Math.max(1, Math.round((end - start) / 1000));
}

/** The agent's reply in the turn that the turn end `turnEndId` closes, as Markdown. */
export function replyBefore(items: readonly TranscriptItem[], turnEndId: string): string {
	const end = items.findIndex(item => item.id === turnEndId);
	const parts: string[] = [];
	for (let i = end - 1; i >= 0 && items[i].kind !== 'user' && items[i].kind !== 'turnEnd'; i--) {
		const item = items[i];
		if (item.kind === 'agent') {
			parts.unshift(item.text.trim());
		}
	}
	return parts.filter(Boolean).join('\n\n');
}

/** The index of the item with `id`; streaming updates are nearly always to the last one. */
export function indexOfItem(items: readonly TranscriptItem[], id: string): number {
	return items.at(-1)?.id === id ? items.length - 1 : items.findIndex(existing => existing.id === id);
}

/** `current` with the text of `update` added, if it is an item that takes text. */
export function withAppended(current: TranscriptItem | undefined, update: TextAppend): TranscriptItem | undefined {
	return current?.kind === 'agent' || current?.kind === 'thought' ? { ...current, text: current.text + update.append } : undefined;
}

/** Whether two attachments are the same thing, so adding it again does nothing. */
export function sameAttachment(a: Attachment, b: Attachment): boolean {
	if (a.kind === 'file' && b.kind === 'file') {
		return a.path === b.path;
	}
	if (a.kind === 'selection' && b.kind === 'selection') {
		return a.path === b.path && a.startLine === b.startLine && a.endLine === b.endLine;
	}
	if (a.kind === 'document' && b.kind === 'document') {
		if (a.ref !== undefined || b.ref !== undefined) {
			return a.ref === b.ref;
		}
		return a.path !== undefined ? a.path === b.path : a.name === b.name && a.text === b.text && a.data === b.data;
	}
	return a.kind === 'image' && b.kind === 'image' && a.data === b.data;
}

/** A team tool chip's key and title, such as ["ACME-412", "Gift message at checkout"]. */
export function toolChipParts(attachment: Attachment): readonly [string, string] {
	if (attachment.kind !== 'document' || !attachment.tool || attachment.tool === 'figma') {
		return [attachment.kind === 'document' ? attachment.name : '', ''];
	}
	const space = attachment.name.indexOf(' ');
	return space === -1 ? [attachment.name, ''] : [attachment.name.slice(0, space), attachment.name.slice(space + 1)];
}

/** The codicon for an attachment chip. */
export function attachmentIcon(kind: Attachment['kind'] | 'page', label: string): string {
	return kind === 'page' ? 'globe' : kind === 'image' ? 'file-media' : kind === 'selection' ? 'list-selection' : /\.pdf$/i.test(label) ? 'file-pdf' : label.startsWith('$ ') ? 'terminal' : 'file';
}

/** The name for a pasted or dropped image, which may have none. */
export function imageName(name: string, mimeType: string): string {
	return name || `image.${mimeType.split('/')[1] ?? 'png'}`;
}

/**
 * The "@word" just before the caret in `text`, if the caret is in one (and
 * nothing is selected): where its "@" is and the word after it.
 */
export function mentionAt(text: string, selectionStart: number, selectionEnd: number): { start: number; query: string } | undefined {
	if (selectionStart !== selectionEnd) {
		return undefined;
	}
	const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, selectionStart));
	return match ? { start: selectionStart - match[2].length - 1, query: match[2] } : undefined;
}

/** The command name typed so far when the input is just "/name" up to the caret, which opens the command menu. */
export function slashQuery(text: string, selectionStart: number, selectionEnd: number): string | undefined {
	if (selectionStart !== selectionEnd) {
		return undefined;
	}
	const match = /^\/(\S*)$/.exec(text.slice(0, selectionStart));
	return match && !/^\S/.test(text.slice(selectionStart)) ? match[1] : undefined;
}

/** Commands whose names start with `query`, then those that contain it. */
export function matchCommands<T extends { readonly name: string }>(commands: readonly T[], query: string, limit = 50): T[] {
	const q = query.toLowerCase();
	const prefix = commands.filter(c => c.name.toLowerCase().startsWith(q));
	const inside = commands.filter(c => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
	return [...prefix, ...inside].slice(0, limit);
}

/** The "/" menu before anything is typed: GeminiCode's commands, then the team's, the skills and the Gemini CLI's, each in its own order. */
export function groupCommands<T extends { readonly source: 'cli' | 'team' | 'skill' | 'app' }>(commands: readonly T[]): T[] {
	const order = ['app', 'team', 'skill', 'cli'];
	return commands.map((command, index) => ({ command, index })).sort((a, b) => order.indexOf(a.command.source) - order.indexOf(b.command.source) || a.index - b.index).map(each => each.command);
}

/** What to insert to start a mention after `before`: "@", with a space first when it would join a word. */
export function mentionInsertion(before: string): string {
	return before && !/\s$/.test(before) ? ' @' : '@';
}

/** `text` without the "@query" at `start`. */
export function withoutMention(text: string, start: number, query: string): string {
	return text.slice(0, start) + text.slice(start + 1 + query.length);
}

/** The folder part of a workspace-relative path, or "" at the root. */
export function folderOf(relative: string): string {
	return relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
}

/** `index` moved by `delta` in a list of `length`, wrapping around. */
export function wrapIndex(index: number, delta: number, length: number): number {
	return (index + delta + length) % length;
}

/** The file URIs in a URI list, such as one dropped from the Explorer. */
export function fileUris(list: string): string[] {
	return list.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('file:'));
}

/** Whether a drag with these data types carries files. */
export function carriesFiles(types: readonly string[]): boolean {
	return types.includes('Files') || types.includes('text/uri-list') || types.includes('application/vnd.code.uri-list');
}

/** The language a rendered code block names in its class, or "". */
export function codeLanguage(className: string): string {
	return /(?:^|\s)language-(\S+)/.exec(className)?.[1] ?? '';
}

/** File extensions a `code` span must end in to be taken for a file. */
const fileExtensions = new Set('ts tsx mts cts js jsx mjs cjs json jsonc md mdx py go rs java kt kts swift css scss less html htm xml yml yaml toml sql sh bash zsh c h cc cpp hpp cs rb php vue svelte lock txt env gradle proto graphql ini cfg conf dart lua r scala ex exs erl hs ml clj tf hcl mk dockerfile'.split(' '));

/**
 * The file a `code` span names, such as `src/cart/total.ts`, `total.ts:11` or
 * `README.md`, with its line; undefined for anything else, such as `item.price`.
 */
export function fileReference(text: string): { path: string; line?: number } | undefined {
	const match = /^((?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.([A-Za-z][\w]{0,9}))(?::(\d+)(?::\d+)?)?$/.exec(text.trim());
	if (!match || !fileExtensions.has(match[2].toLowerCase())) {
		return undefined;
	}
	const line = match[3] ? Number(match[3]) : undefined;
	return { path: match[1], ...(line ? { line } : {}) };
}

/** An empty code block opened by `opener`, closed with its own marker. */
export function emptyFence(opener: string): string {
	return `${opener}\n${opener.trimEnd().replace(/^([`~]+).*$/, '$1')}\n`;
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

/**
 * The subagent a tool call hands work to, as a name to show, or undefined for
 * other tool calls. Over ACP the CLI sends a subagent call (its `invoke_agent`
 * tool, kind `agent` sent as `think`) titled "Delegating to agent '<name>'";
 * a title worded otherwise falls back to a plain tool row.
 */
export function subagentName(title: string): string | undefined {
	const name = /^Delegating to agent '([\w-]{1,64})'$/.exec(title.trim())?.[1];
	return name?.split(/[_-]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
}

/** The codicon for a kind of tool call. */
export function toolKindIcon(kind: string | undefined): string {
	return toolKindIcons[kind ?? ''] ?? 'tools';
}

/** The codicon for a plan entry. */
export function planIcon(status: ItemOf<'plan'>['entries'][number]['status']): string {
	return status === 'completed' ? 'pass-filled' : status === 'in_progress' ? 'loading' : 'circle-large-outline';
}

type PermissionOption = ItemOf<'permission'>['options'][number];

/**
 * A request's options by role: the one shown as primary ("Allow" once, else
 * any allow), Allow once, "Allow for this session" (gemini-cli's
 * `proceed_always`, or the narrowest of an MCP tool's), and the one Escape
 * picks (a rejection).
 */
export function permissionChoices(options: readonly PermissionOption[]): { primary?: PermissionOption; once?: PermissionOption; session?: PermissionOption; reject?: PermissionOption } {
	const always = options.filter(o => o.kind === 'allow_always');
	return {
		primary: options.find(o => o.kind === 'allow_once') ?? options.find(o => o.kind.startsWith('allow')),
		once: options.find(o => o.kind === 'allow_once'),
		session: always.find(o => o.optionId === 'proceed_always') ?? always.find(o => o.optionId === 'proceed_always_tool') ?? always.find(o => /for this session/i.test(o.name)),
		reject: options.find(o => o.kind === 'reject_once') ?? options.find(o => o.kind.startsWith('reject')),
	};
}

/** The permission card still waiting for an answer, the newest if several are. */
export function waitingPermission(items: readonly TranscriptItem[]): ItemOf<'permission'> | undefined {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind === 'permission' && !item.answer) {
			return item;
		}
	}
	return undefined;
}

/**
 * What a key in the chat box does to a waiting card: ⌥⌘↩ (Ctrl+Alt+Enter)
 * allows once, ⌥⌘S (Ctrl+Alt+S) allows for the session, Esc rejects. Clear
 * of the composer's own keys: ↩ sends, ⌘↩ queues, ⌥⌘↑ ⌥⌘↓ move between prompts.
 */
export function cardKey(event: { readonly key: string; readonly code: string; readonly altKey: boolean; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean }, mac: boolean): 'once' | 'session' | 'reject' | undefined {
	if (event.key === 'Escape') {
		return event.altKey || event.metaKey || event.ctrlKey || event.shiftKey ? undefined : 'reject';
	}
	const chord = event.altKey && !event.shiftKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
	if (!chord) {
		return undefined;
	}
	// The key's code, not its character: on a Mac, Option turns S into another letter.
	return event.key === 'Enter' ? 'once' : event.code === 'KeyS' ? 'session' : undefined;
}

/** Whether a scroll position is close enough to the bottom to keep following new content. */
export function isNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
	return scrollHeight - scrollTop - clientHeight < 40;
}

/** The tallest the composer's input can be dragged in a view `viewHeight` high. */
export function composerHeightLimit(viewHeight: number): number {
	return Math.max(60, viewHeight * 0.7);
}

/** The input's height while dragging its top edge from `startY` to `y`. */
export function draggedHeight(startHeight: number, startY: number, y: number, viewHeight: number): number {
	return Math.min(composerHeightLimit(viewHeight), Math.max(20, startHeight + startY - y));
}

/** A remembered height made to fit this view; kept as is while the view has no height yet. */
export function restoredHeight(height: number, viewHeight: number): number {
	return viewHeight ? Math.min(height, composerHeightLimit(viewHeight)) : height;
}

/** Where Enhance prompt is: offered, rewriting the draft, or showing its rewrite. */
export type EnhancePhase =
	| { readonly kind: 'idle' }
	| { readonly kind: 'working'; readonly requestId: number; readonly original: string }
	| { readonly kind: 'done'; readonly original: string; readonly rewrite: string };

/** The phase once the input reads `value`: a rewrite the user edits (or undoes) is their own draft again. */
export function enhancePhaseAfterInput(phase: EnhancePhase, value: string): EnhancePhase {
	return phase.kind === 'done' && value !== phase.rewrite ? { kind: 'idle' } : phase;
}

/** Whether a reply answers the rewrite in progress; one that was cancelled or replaced is dropped. */
export function acceptsEnhanceReply(phase: EnhancePhase, requestId: number): phase is Extract<EnhancePhase, { kind: 'working' }> {
	return phase.kind === 'working' && phase.requestId === requestId;
}

/** What Revert puts back when enhancing `draft`: what the user wrote, also when they enhance a rewrite again. */
export function enhanceOriginal(phase: EnhancePhase, draft: string): string {
	return phase.kind === 'done' && draft === phase.rewrite ? phase.original : draft;
}

/** The text a rewrite puts in the input, with the line endings a textarea keeps. */
export function enhanceText(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

/** Whether a key press is the Enhance shortcut: ⌥⌘E on a Mac, Ctrl+Alt+E elsewhere. */
export function isEnhanceShortcut(event: { readonly code: string; readonly altKey: boolean; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean }, mac: boolean): boolean {
	// The key's code, not its character: Alt changes the character on a Mac.
	return event.code === 'KeyE' && event.altKey && !event.shiftKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

/** The Enhance shortcut as the platform writes it. */
export function enhanceShortcutLabel(mac: boolean): string {
	return mac ? '⌥⌘E' : 'Ctrl+Alt+E';
}

/** Where the text of the input ends, and the room around it, in pixels from the input's top left. */
export interface TextEnd {
	readonly left: number;
	readonly top: number;
	readonly lineHeight: number;
	/** The input's inner width and visible height, and how far it is scrolled. */
	readonly width: number;
	readonly height: number;
	readonly scrollTop: number;
}

/**
 * Where the floating Enhance button goes: just after the last character,
 * centred on its line, or at the start of the next line when it does not fit
 * after it (`below`); kept inside the visible part of the input.
 */
export function enhanceButtonPlacement(end: TextEnd, button: { readonly width: number; readonly height: number }, gap = 6): { readonly x: number; readonly y: number; readonly below: boolean } {
	const below = end.left + gap + button.width > end.width;
	const x = below ? 0 : end.left + gap;
	const lineTop = (below ? end.top + end.lineHeight : end.top) - end.scrollTop;
	const y = Math.max(0, Math.min(lineTop + (end.lineHeight - button.height) / 2, end.height - button.height));
	return { x: Math.round(x), y: Math.round(y), below };
}

/** A running clock for a turn: "0:07", "1:42" or "1:02:03"; shared with the Agents side bar. */
export { formatClock } from '../src/acp/agentRow';

/** What the agent is doing now, for the working strip above the composer. */
export interface Activity {
	readonly kind: 'thinking' | 'tool' | 'writing' | 'waiting';
	/** A tool call's or question's title, or the thought's latest heading; empty when there is nothing more to say. */
	readonly detail: string;
}

/** The newest thing still happening in a turn: an unanswered question, a running tool call, a thought or the reply. */
export function currentActivity(items: readonly TranscriptItem[]): Activity {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		switch (item.kind) {
			case 'permission':
				if (!item.answer) {
					return { kind: 'waiting', detail: item.title };
				}
				return { kind: 'thinking', detail: '' };
			case 'toolCall':
				return item.status === 'pending' || item.status === 'in_progress' ? { kind: 'tool', detail: item.title } : { kind: 'thinking', detail: '' };
			case 'thought':
				return { kind: 'thinking', detail: thoughtPreview(item.text) };
			case 'agent':
				return { kind: 'writing', detail: '' };
			case 'user':
			case 'turnEnd':
				return { kind: 'thinking', detail: '' };
			default:
				// Plans, notices and unknown updates say nothing about what happens now.
				continue;
		}
	}
	return { kind: 'thinking', detail: '' };
}

/** When the turn now running started: the newest prompt's send time, if it has one. */
export function turnStart(items: readonly TranscriptItem[]): number | undefined {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind === 'user') {
			return item.at;
		}
		if (item.kind === 'turnEnd') {
			return undefined;
		}
	}
	return undefined;
}

/** How close (in pixels) a prompt's top must be to the view's top to count as the one in view; a jump leaves 12. */
const promptSlack = 24;

/**
 * The prompt that is current when the view's top is at `viewTop`: the last
 * one starting at or above it, or -1 above the first. `tops` are the
 * prompts' tops, in order.
 */
export function currentPrompt(tops: readonly number[], viewTop: number): number {
	let current = -1;
	for (let i = 0; i < tops.length && tops[i] <= viewTop + promptSlack; i++) {
		current = i;
	}
	return current;
}

/** The prompt to jump to from `viewTop`: the next one below it, or the previous one above; -1 when there is none. */
export function promptStep(tops: readonly number[], viewTop: number, direction: 1 | -1): number {
	if (direction === 1) {
		return tops.findIndex(top => top > viewTop + promptSlack);
	}
	for (let i = tops.length - 1; i >= 0; i--) {
		if (tops[i] < viewTop - promptSlack) {
			return i;
		}
	}
	return -1;
}

/** The most of a reply a prompt's preview card shows; the card clamps it to three lines. */
const replyPreviewLength = 280;

/**
 * The start of Gemini's reply to prompt `promptId`, as plain text for the
 * outline's preview card: its first reply before the next prompt, without
 * code blocks or Markdown marks. Empty while there is none yet.
 */
export function replyPreview(items: readonly TranscriptItem[], promptId: string): string {
	const start = items.findIndex(item => item.id === promptId);
	for (let i = start + 1; start >= 0 && i < items.length; i++) {
		const item = items[i];
		if (item.kind === 'user') {
			break;
		}
		if (item.kind === 'agent' && item.text.trim()) {
			const text = item.text
				.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm, ' ')
				.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
				.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
				.replace(/(\*\*|__|\*|_|~~|`)(?=\S)([^\n]*?\S)\1/g, '$2')
				.replace(/\s+/g, ' ')
				.trim();
			if (text) {
				return text.length > replyPreviewLength ? `${text.slice(0, replyPreviewLength - 1).trimEnd()}…` : text;
			}
		}
	}
	return '';
}

/** A token count, short: "950", "48.2k", "1.3M". */
export function formatTokens(count: number, locale?: string): string {
	return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(count);
}

/** How long until `resetTime`, in whole hours or, under an hour, minutes; undefined once it has passed or when unknown. */
export function resetsIn(resetTime: string | undefined, now: number): { readonly unit: 'hours' | 'minutes'; readonly value: number } | undefined {
	const ms = resetTime ? Date.parse(resetTime) - now : NaN;
	if (!Number.isFinite(ms) || ms <= 0) {
		return undefined;
	}
	const hours = Math.floor(ms / 3_600_000);
	return hours ? { unit: 'hours', value: hours } : { unit: 'minutes', value: Math.max(1, Math.round(ms / 60_000)) };
}

/**
 * Updates that arrive while the view is hidden, merged as they arrive into as
 * few as give the same result: appends to one item joined into one, and an
 * item sent whole replacing what came before it for that item. A hidden chat
 * then holds about one update per item however long it streams, and each item
 * is rendered once when the view shows, not once per streamed chunk.
 */
export class HeldUpdates {
	private slots: (ItemUpdate | undefined)[] = [];
	/** Slots emptied by a later whole item; dropped once they are half the slots. */
	private emptied = 0;
	private readonly whole = new Map<string, number>();
	private readonly appends = new Map<string, number>();

	/** How many updates are held. */
	get size(): number {
		return this.slots.length - this.emptied;
	}

	add(update: ItemUpdate): void {
		const at = this.appends.get(update.id);
		if (update.kind === 'append') {
			const previous = at === undefined ? undefined : this.slots[at];
			if (previous?.kind === 'append') {
				this.slots[at!] = { kind: 'append', id: update.id, append: previous.append + update.append };
			} else {
				this.appends.set(update.id, this.slots.push(update) - 1);
			}
			return;
		}
		if (at !== undefined) {
			// The whole item already has that text.
			this.slots[at] = undefined;
			this.appends.delete(update.id);
			this.emptied++;
		}
		const slot = this.whole.get(update.id);
		if (slot === undefined) {
			this.whole.set(update.id, this.slots.push(update) - 1);
		} else {
			this.slots[slot] = update;
		}
		if (this.emptied > 32 && this.emptied * 2 > this.slots.length) {
			this.compact();
		}
	}

	/** The held updates, in the order their items first changed; the holder is left empty. */
	take(): ItemUpdate[] {
		const updates = this.slots.filter((update): update is ItemUpdate => update !== undefined);
		this.clear();
		return updates;
	}

	clear(): void {
		this.slots = [];
		this.emptied = 0;
		this.whole.clear();
		this.appends.clear();
	}

	private compact(): void {
		const updates = this.take();
		this.slots = updates;
		updates.forEach((update, i) => (update.kind === 'append' ? this.appends : this.whole).set(update.id, i));
	}
}

/** `updates` merged as `HeldUpdates` merges them. */
export function coalesceUpdates(updates: readonly ItemUpdate[]): ItemUpdate[] {
	const held = new HeldUpdates();
	updates.forEach(update => held.add(update));
	return held.take();
}

type EnterKey = { readonly key: string; readonly altKey: boolean; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean };

/**
 * What Return does in the composer: send now, queue for after the agent's
 * turn, or make a new line (undefined: not Return). With `cmdEnter`
 * (`gemini.chat.sendWith`), ⌘Return (Ctrl+Enter) sends, ⇧⌘Return queues and
 * Return makes a new line; otherwise Return sends, ⌘Return queues and
 * ⇧Return makes a new line.
 */
export function enterAction(event: EnterKey, mac: boolean, cmdEnter: boolean): 'now' | 'queue' | 'newLine' | undefined {
	if (event.key !== 'Enter' || event.altKey) {
		return undefined;
	}
	const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	if (cmdEnter) {
		return command ? (event.shiftKey ? 'queue' : 'now') : event.metaKey || event.ctrlKey ? undefined : 'newLine';
	}
	return isQueueShortcut(event, mac) ? 'queue' : event.shiftKey ? 'newLine' : 'now';
}

/** ⌘Return on a Mac, Ctrl+Enter elsewhere: queues a message while the agent works, instead of sending it now. */
export function isQueueShortcut(event: { readonly key: string; readonly altKey: boolean; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean }, mac: boolean): boolean {
	return event.key === 'Enter' && !event.shiftKey && !event.altKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

/** A part of what each turn carries, for the usage popover's breakdown. */
export interface ContextPart {
	readonly part: 'conversation' | 'servers' | 'rules' | 'geminicode' | 'cli';
	readonly tokens: number;
	/** How many servers or rule files the part is. */
	readonly count?: number;
}

/**
 * The usage popover's breakdown, largest first: the measured parts every
 * call carries, and the conversation, which is what the latest request's
 * input (`used`) holds beyond them. Parts that cost nothing are left out.
 */
export function contextParts(parts: { readonly cli: number; readonly rules: number; readonly geminicode: number; readonly servers: number; readonly serverTokens: number; readonly total: number }, rules: number, used?: number): ContextPart[] {
	const rows: ContextPart[] = [
		...used !== undefined ? [{ part: 'conversation' as const, tokens: Math.max(0, used - parts.total) }] : [],
		{ part: 'servers', tokens: parts.serverTokens, count: parts.servers },
		{ part: 'rules', tokens: parts.rules, count: rules },
		{ part: 'geminicode', tokens: parts.geminicode },
		{ part: 'cli', tokens: parts.cli },
	];
	return rows.filter(row => row.tokens > 0).sort((a, b) => b.tokens - a.tokens);
}

/** The codicon for a symbol of the index's `kind` (function, class, method…). */
export function symbolIcon(kind: string): string {
	switch (kind) {
		case 'class': case 'method': case 'function': case 'interface': case 'enum': case 'constant': case 'struct': case 'module': case 'variable': case 'field': case 'property':
			return `symbol-${kind}`;
		case 'type': return 'symbol-interface';
		case 'trait': return 'symbol-interface';
		default: return 'symbol-misc';
	}
}

/** The @ picker's group a row is in, in the order the groups show. */
export type MentionGroup = 'files' | 'folders' | 'symbols' | 'workspace';

/** Which group a picker row of `kind` goes in. */
export function mentionGroup(kind: 'file' | 'folder' | 'symbol' | 'problems' | 'changes' | 'terminal'): MentionGroup {
	return kind === 'file' ? 'files' : kind === 'folder' ? 'folders' : kind === 'symbol' ? 'symbols' : 'workspace';
}
