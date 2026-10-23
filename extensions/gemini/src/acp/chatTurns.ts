/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a chat (src/host/chatController.ts) reads off its transcript between
// turns: whether a saved chat was cut off, the step a turn is on, which
// prompts it can rewind to, what to tell the agent after an undo, and when to
// suggest compacting.

import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import type { TranscriptItem } from './chatTranscript';
import type { StoredCheckpoints } from './checkpoints';
import type { SessionSettings } from './sessionSettings';

/** The CLI's Plan and Default mode IDs (gemini-cli 0.63 `ApprovalMode`); Build This Plan shows only when the agent offers both. */
const planModeId = 'plan';
const defaultModeId = 'default';

/** The most proposed edits, and tool calls, a chat keeps track of. */
const maxRemembered = 200;

/** Whether the saved chat ends in a prompt that never got its turn end or an error. */
export function wasCutOff(items: readonly TranscriptItem[]): boolean {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind === 'user') {
			return true;
		}
		// A cut-off card already says so (and stays while the turn is unfinished); a second one would say it twice.
		if (item.kind === 'turnEnd' || item.kind === 'cutOff' || (item.kind === 'notice' && item.severity === 'error')) {
			return false;
		}
	}
	return false;
}

/** When the latest prompt was sent, as the working strip's clock counts from it. */
export function lastPromptAt(items: readonly TranscriptItem[]): number | undefined {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind === 'user') {
			return item.at;
		}
	}
	return undefined;
}

/** The title of the tool call the turn is on, if any. */
export function runningStep(items: readonly TranscriptItem[]): string | undefined {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind === 'user') {
			return undefined;
		}
		if (item.kind === 'toolCall') {
			return item.status === 'pending' || item.status === 'in_progress' ? item.title : undefined;
		}
	}
	return undefined;
}

/** A turn's steps for the log, without their contents: "user, thought, tool(browser_snapshot: completed), agent". */
export function turnShape(items: readonly TranscriptItem[]): string {
	return items.map(item => {
		switch (item.kind) {
			case 'toolCall':
				return `tool(${item.title.slice(0, 40)}: ${item.status}${item.details.length ? `, ${item.details.length} parts` : ''})`;
			case 'permission':
				return `permission(${item.answer?.kind ?? 'open'})`;
			case 'notice':
				return 'notice';
			default:
				return item.kind;
		}
	}).join(', ') || 'nothing';
}

/** The user's prompts the chat can rewind to, newest first. */
export function rewindPrompts(items: readonly TranscriptItem[]): Extract<TranscriptItem, { kind: 'user' | 'agent' | 'thought' }>[] {
	return items.flatMap(item => item.kind === 'user' && item.text.trim() ? [item] : []).reverse();
}

/** How many of the user's prompts after the one at `index` say the same: the CLI's messages are found by text. */
export function laterRepeats(items: readonly TranscriptItem[], index: number): number {
	const squash = (t: string) => t.replace(/\s+/g, ' ').trim();
	const prompt = items[index];
	const text = prompt?.kind === 'user' ? squash(prompt.text) : '';
	return items.slice(index + 1).filter(item => item.kind === 'user' && squash(item.text) === text).length;
}

/** Whether `stored` covers only turns the chat shows: checkpoints of other turns would undo the wrong ones. */
export function checkpointsFit(items: readonly TranscriptItem[], stored: StoredCheckpoints | undefined): stored is StoredCheckpoints {
	const shown = new Set(items.flatMap(item => item.kind === 'turnEnd' ? [item.id] : []));
	return !!stored?.turns?.length && stored.turns.every(turn => shown.has(turn?.id));
}

/** What the agent is told with the next prompt after the user undid its edits to `files`, which it would otherwise think it changed. */
export function undoNote(cwd: string, files: readonly string[]): string {
	const names = files.map(file => path.relative(cwd, file) || file);
	return `[The user undid your file changes. These files are back to how they were before those replies, so read them again before editing them: ${names.join(', ')}]`;
}

/** The mode Build This Plan switches to: Default, when the chat is in Plan mode and the agent offers both. */
export function buildModeAfterPlan(settings: SessionSettings): string | undefined {
	const mode = settings.mode;
	return mode?.currentId === planModeId && mode.available.some(m => m.id === defaultModeId) ? defaultModeId : undefined;
}

/** A tool call's proposed edits. */
export function diffsOf(content: readonly acp.ToolCallContent[] | null | undefined): acp.Diff[] {
	return (content ?? []).flatMap(c => c.type === 'diff' ? [c] : []);
}

/** Drops the oldest entries of a set or map beyond the {@link maxRemembered} newest. */
export function dropOldest<K>(collection: Set<K> | Map<K, unknown>): void {
	for (const key of collection.keys()) {
		if (collection.size <= maxRemembered) {
			return;
		}
		collection.delete(key);
	}
}

/** How full the context is, as a share of the window, when the chat suggests compacting; the CLI compresses on its own at half. */
export const suggestCompactAt = 0.4;

/**
 * Whether the chat should suggest compacting session `session`, now `used`
 * of `limit` tokens full: past {@link suggestCompactAt}, once per session,
 * never again after a suggestion or on a session a compact made or left.
 */
export function shouldSuggestCompact(items: readonly TranscriptItem[], session: string | undefined, used: number, limit: number): boolean {
	return !!session && used >= limit * suggestCompactAt
		&& !items.some(item => item.kind === 'compact' && (item.state === 'suggested' || item.state === 'dismissed' || item.to === session || item.from === session));
}
