/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a chat (src/host/chatController.ts) reads off its transcript between
// turns: whether a saved chat was cut off, the step a turn is on, which
// prompts it can rewind to, what to tell the agent after an undo, when to
// suggest compacting, and what a fork's chat starts with.

import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import type { TranscriptItem } from './chatTranscript';
import type { StoredCheckpoints } from './checkpoints';
import type { SessionSettings } from './sessionSettings';

/** The CLI's Plan and Default mode IDs (gemini-cli 0.63 `ApprovalMode`); Build This Plan shows only when the agent offers both. */
const planModeId = 'plan';
const defaultModeId = 'default';
const yoloModeId = 'yolo';

/** The most proposed edits, and tool calls, a chat keeps track of. */
export const maxRemembered = 200;

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

/**
 * The approval mode after `settings`' current one, for Cycle Approval Mode: the
 * next the agent lists, as the CLI's own ⇧Tab steps through them, but never
 * YOLO, which approves everything and is picked on purpose. Undefined when
 * there is nothing to switch to.
 */
export function nextApprovalMode(settings: SessionSettings): string | undefined {
	const mode = settings.mode;
	const cycle = mode?.available.filter(choice => choice.id !== yoloModeId) ?? [];
	if (!mode || !cycle.length) {
		return undefined;
	}
	const index = cycle.findIndex(choice => choice.id === mode.currentId);
	// From YOLO, the next mode the agent lists after it.
	const next = index >= 0 ? cycle[(index + 1) % cycle.length] : cycle.find(choice => mode.available.indexOf(choice) > mode.available.findIndex(c => c.id === mode.currentId)) ?? cycle[0];
	return next.id === mode.currentId ? undefined : next.id;
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

/**
 * Fork from Here on the reply that ends at turn end `turnEnd`: the prompt
 * after it, which the fork stops before (none for the last reply), and the
 * prompt the reply answered. Undefined when the turn end is not there.
 */
export function forkPointAfter(items: readonly TranscriptItem[], turnEnd: string): { readonly before?: string; readonly answered?: string } | undefined {
	const index = items.findIndex(item => item.id === turnEnd && item.kind === 'turnEnd');
	if (index < 0) {
		return undefined;
	}
	const next = items.slice(index + 1).find(item => item.kind === 'user');
	const answered = items.slice(0, index).reverse().find(item => item.kind === 'user');
	return { ...(next ? { before: next.id } : {}), ...(answered?.kind === 'user' ? { answered: answered.text } : {}) };
}

/**
 * What a fork's chat shows of its parent's: the items before item `before`
 * (a prompt, for Fork from Here or a turn still running), else all of them.
 * Nothing in them can act on the parent: requests and tool calls still open
 * are settled, turn ends offer no Undo or Retry (the checkpoints are the
 * parent's), compacts keep no session to go back to, and suggestions,
 * interruptions and the parent's own fork lines go. Undefined when `before`
 * is not there.
 */
export function forkedItems(items: readonly TranscriptItem[], before?: string): TranscriptItem[] | undefined {
	const end = before === undefined ? items.length : items.findIndex(item => item.id === before);
	if (end < 0) {
		return undefined;
	}
	return items.slice(0, end).flatMap((item): TranscriptItem[] => {
		switch (item.kind) {
			case 'cutOff':
				return [];
			case 'compact':
				if (item.state !== 'done' && item.state !== 'undone') {
					return [];
				}
				return [{ id: item.id, kind: 'compact', state: item.state, ...(item.before !== undefined ? { before: item.before } : {}), ...(item.after !== undefined ? { after: item.after } : {}), ...(item.kept !== undefined ? { kept: item.kept } : {}), ...(item.summary ? { summary: item.summary } : {}) }];
			case 'fork':
				return item.role === 'from' ? [item] : [];
			case 'permission':
				return [item.answer ? item : { ...item, answer: { kind: 'cancelled' } }];
			case 'toolCall':
				return [item.status === 'pending' || item.status === 'in_progress' ? { ...item, status: 'failed' } : item];
			case 'turnEnd': {
				const { undo: _undo, retry: _retry, buildPlan: _buildPlan, files: _files, ...rest } = item;
				return [rest];
			}
			default:
				return [item];
		}
	});
}

/**
 * The note a fork's first prompt carries, which the chat does not show: whose
 * fork it is, and where it works now. In a folder of its own, the paths the
 * earlier messages name under the parent's folder are under its own.
 */
export function forkNote(parentTitle: string, parentFolder: string, folder: string, branch: string | undefined): string {
	const where = branch && folder !== parentFolder
		? `You now work in ${folder}, on the new branch ${branch}, a copy of ${parentFolder} with its uncommitted changes. Files the earlier messages name under ${parentFolder} are under ${folder} now: read and change them there, never in ${parentFolder}, which the other agent is still working in.`
		: `You work in ${folder}, the same folder as the other agent, which may still be changing files there: read a file again before you change it.`;
	return `This session was forked from the agent "${parentTitle}": the earlier conversation is that agent's, up to the fork, and you now carry on from it as a separate agent. ${where}`;
}
