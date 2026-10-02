/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat view's model: folds the adapter's ChatEvents into a list of
// plain, serialisable items the webview renders. Streaming chunks extend the
// item they belong to; tool calls and the plan update in place.

import type * as acp from '@agentclientprotocol/sdk';
import { Emitter } from './events';
import type { PendingPermission } from './permissions';
import { Attachment, attachmentLabel } from './attachments';
import { ChatEvent, contentBlockToText, ToolCallModel } from './sessionUpdates';

export type ToolCallDetail =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'diff'; readonly path: string; readonly added: number; readonly removed: number }
	| { readonly type: 'terminal'; readonly terminalId: string };

export interface PromptAttachmentLabel {
	readonly kind: Attachment['kind'];
	readonly label: string;
	/** For files and selections, so the view can open them. */
	readonly path?: string;
	readonly line?: number;
}

export interface ToolCallLocation {
	readonly path: string;
	/** 1-based, as ACP sends it. */
	readonly line?: number;
}

export type TranscriptItem =
	| {
		readonly id: string; readonly kind: 'user' | 'agent' | 'thought'; readonly text: string;
		/** Context sent with a user prompt, as labels (`app.ts`, `app.ts:10-20`). */
		readonly attachments?: readonly PromptAttachmentLabel[];
	}
	| {
		readonly id: string; readonly kind: 'toolCall'; readonly title: string; readonly toolKind: string | undefined;
		readonly status: acp.ToolCallStatus; readonly locations: readonly ToolCallLocation[]; readonly details: readonly ToolCallDetail[];
	}
	| { readonly id: string; readonly kind: 'plan'; readonly entries: readonly { readonly content: string; readonly status: acp.PlanEntryStatus }[] }
	| {
		readonly id: string; readonly kind: 'permission'; readonly title: string;
		readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind: acp.PermissionOptionKind }[];
		/** Files the tool would change; the view can open a diff for each. */
		readonly diffPaths: readonly string[];
		/** Unset while the agent waits for an answer. */
		readonly answer?: { readonly kind: 'selected'; readonly name: string } | { readonly kind: 'cancelled' };
	}
	/** An update kind this version does not know (design rule 4). */
	| { readonly id: string; readonly kind: 'other'; readonly type: string }
	| { readonly id: string; readonly kind: 'notice'; readonly text: string; readonly severity: 'info' | 'error' }
	/** Ends a turn: how long the agent worked, with a way to copy its reply. */
	| { readonly id: string; readonly kind: 'turnEnd'; readonly durationMs: number };

/**
 * Update kinds that describe the session rather than the conversation. They
 * are not chat content, so the transcript skips them; later phases show them
 * elsewhere (commands, modes, usage).
 */
export const SESSION_STATE_UPDATES: ReadonlySet<string> = new Set([
	'available_commands_update',
	'current_mode_update',
	'config_option_update',
	'session_info_update',
	'usage_update',
]);

type TextItem = Extract<TranscriptItem, { kind: 'user' | 'agent' | 'thought' }>;

export class ChatTranscript {

	private readonly onDidChangeItemEmitter = new Emitter<TranscriptItem>();
	/** Fires with an item that was added or replaced (same `id`). */
	readonly onDidChangeItem = this.onDidChangeItemEmitter.event;

	private readonly onDidResetEmitter = new Emitter<void>();
	readonly onDidReset = this.onDidResetEmitter.event;

	private _items: TranscriptItem[] = [];
	private nextId = 0;
	/** Index of the first item of the current turn; tool calls and the plan are looked up from here. */
	private turnStart = 0;
	private lastMessageId: string | null | undefined;

	get items(): readonly TranscriptItem[] {
		return this._items;
	}

	addPrompt(text: string, attachments: readonly Attachment[] = []): void {
		this.turnStart = this._items.length;
		this.lastMessageId = undefined;
		this.push({
			id: this.newId(), kind: 'user', text,
			...(attachments.length ? {
				attachments: attachments.map(a => ({
					kind: a.kind,
					label: attachmentLabel(a),
					...(a.kind === 'image' ? {} : { path: a.path }),
					...(a.kind === 'selection' ? { line: a.startLine } : {}),
				})),
			} : {}),
		});
	}

	apply(event: ChatEvent): void {
		switch (event.kind) {
			case 'text':
				this.appendText(event.role, event.text, event.messageId);
				break;
			case 'toolCall':
				this.upsert(toToolCallItem(event.call));
				break;
			case 'plan':
				this.upsert({
					id: this.currentPlanId() ?? this.newId(),
					kind: 'plan',
					entries: event.entries.map(e => ({ content: e.content, status: e.status })),
				});
				break;
			case 'other':
				if (SESSION_STATE_UPDATES.has(event.type)) {
					break;
				}
				this.push({ id: this.newId(), kind: 'other', type: event.type });
				break;
		}
	}

	addPermission(permission: PendingPermission): void {
		const { toolCall, options } = permission.request;
		this.push({
			id: permission.id,
			kind: 'permission',
			title: toolCall.title ?? toolCall.toolCallId,
			options: options.map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
			diffPaths: (toolCall.content ?? []).flatMap(c => c.type === 'diff' ? [c.path] : []),
		});
	}

	resolvePermission(id: string, outcome: acp.RequestPermissionOutcome): void {
		const item = this._items.find(i => i.id === id);
		if (item?.kind !== 'permission') {
			return;
		}
		const selected = outcome.outcome === 'selected' ? item.options.find(o => o.optionId === outcome.optionId) : undefined;
		this.upsert({ ...item, answer: selected ? { kind: 'selected', name: selected.name } : { kind: 'cancelled' } });
	}

	addTurnEnd(durationMs: number): void {
		this.push({ id: this.newId(), kind: 'turnEnd', durationMs: Math.max(0, Math.round(durationMs)) });
	}

	addNotice(text: string, severity: 'info' | 'error' = 'info'): void {
		this.push({ id: this.newId(), kind: 'notice', text, severity });
	}

	/** Replaces the conversation with saved items, such as an agent's from an earlier window. */
	restore(items: readonly TranscriptItem[]): void {
		this._items = [...items];
		this.nextId = Math.max(this.nextId, ...items.map(i => /^item-(\d+)$/.exec(i.id)).map(m => m ? Number(m[1]) + 1 : 0));
		this.turnStart = this._items.length;
		this.lastMessageId = undefined;
		this.onDidResetEmitter.fire();
	}

	clear(): void {
		this._items = [];
		this.turnStart = 0;
		this.lastMessageId = undefined;
		this.onDidResetEmitter.fire();
	}

	dispose(): void {
		this.onDidChangeItemEmitter.dispose();
		this.onDidResetEmitter.dispose();
	}

	private appendText(role: TextItem['kind'], text: string, messageId: string | null | undefined): void {
		const last = this._items.at(-1);
		const sameMessage = !messageId || !this.lastMessageId || messageId === this.lastMessageId;
		if (last && last.kind === role && sameMessage) {
			this.upsert({ ...last, text: last.text + text });
		} else {
			this.push({ id: this.newId(), kind: role, text });
		}
		if (messageId) {
			this.lastMessageId = messageId;
		}
	}

	private currentPlanId(): string | undefined {
		return this._items.slice(this.turnStart).find(item => item.kind === 'plan')?.id;
	}

	private upsert(item: TranscriptItem): void {
		const index = this._items.findIndex(existing => existing.id === item.id);
		if (index === -1) {
			this.push(item);
		} else {
			this._items[index] = item;
			this.onDidChangeItemEmitter.fire(item);
		}
	}

	private push(item: TranscriptItem): void {
		this._items.push(item);
		this.onDidChangeItemEmitter.fire(item);
	}

	private newId(): string {
		return `item-${this.nextId++}`;
	}
}

export function toolCallItemId(toolCallId: string): string {
	return `tool-${toolCallId}`;
}

export function toToolCallItem(call: ToolCallModel): TranscriptItem {
	return {
		id: toolCallItemId(call.id),
		kind: 'toolCall',
		title: call.title,
		toolKind: call.kind,
		status: call.status,
		locations: call.locations.map(l => l.line ? { path: l.path, line: l.line } : { path: l.path }),
		details: call.content.map(toToolCallDetail),
	};
}

function toToolCallDetail(content: acp.ToolCallContent): ToolCallDetail {
	switch (content.type) {
		case 'content':
			return { type: 'text', text: contentBlockToText(content.content) };
		case 'diff': {
			const { added, removed } = countChangedLines(content.oldText ?? '', content.newText);
			return { type: 'diff', path: content.path, added, removed };
		}
		case 'terminal':
			return { type: 'terminal', terminalId: content.terminalId };
	}
}

/** Lines only in the new text and only in the old text, compared as multisets. Enough for a summary. */
export function countChangedLines(oldText: string, newText: string): { added: number; removed: number } {
	const remaining = new Map<string, number>();
	const oldLines = oldText ? oldText.split('\n') : [];
	for (const line of oldLines) {
		remaining.set(line, (remaining.get(line) ?? 0) + 1);
	}
	let added = 0;
	let kept = 0;
	for (const line of newText ? newText.split('\n') : []) {
		const count = remaining.get(line) ?? 0;
		if (count > 0) {
			remaining.set(line, count - 1);
			kept++;
		} else {
			added++;
		}
	}
	return { added, removed: oldLines.length - kept };
}
