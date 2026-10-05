/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat view's decisions that need no DOM, so they can be tested.

import type { Attachment } from '../src/acp/attachments';
import type { TranscriptItem } from '../src/acp/chatTranscript';
import type { TextAppend } from '../src/acp/textDeltas';

export type ItemOf<K extends TranscriptItem['kind']> = Extract<TranscriptItem, { kind: K }>;

/** Puts `value` in place of "{0}" in a localized string. */
export function format(template: string, value: string | number): string {
	return template.replace('{0}', String(value));
}

/** "12s", "2m 5s" or "1h 3m". */
export function formatDuration(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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
		return a.path !== undefined ? a.path === b.path : a.name === b.name && a.text === b.text && a.data === b.data;
	}
	return a.kind === 'image' && b.kind === 'image' && a.data === b.data;
}

/** The codicon for an attachment chip. */
export function attachmentIcon(kind: Attachment['kind'], label: string): string {
	return kind === 'image' ? 'file-media' : kind === 'selection' ? 'list-selection' : /\.pdf$/i.test(label) ? 'file-pdf' : 'file';
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

/** The codicon for a kind of tool call. */
export function toolKindIcon(kind: string | undefined): string {
	return toolKindIcons[kind ?? ''] ?? 'tools';
}

/** The codicon for a plan entry. */
export function planIcon(status: ItemOf<'plan'>['entries'][number]['status']): string {
	return status === 'completed' ? 'pass-filled' : status === 'in_progress' ? 'loading' : 'circle-large-outline';
}

type PermissionOption = ItemOf<'permission'>['options'][number];

/** The option to show as primary ("Allow" once, else any allow) and the one Escape picks (a rejection). */
export function permissionDefaults(options: readonly PermissionOption[]): { primary?: PermissionOption; reject?: PermissionOption } {
	return {
		primary: options.find(o => o.kind === 'allow_once') ?? options.find(o => o.kind.startsWith('allow')),
		reject: options.find(o => o.kind === 'reject_once') ?? options.find(o => o.kind.startsWith('reject')),
	};
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
