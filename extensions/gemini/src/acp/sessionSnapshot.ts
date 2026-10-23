/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Snapshots of a Gemini CLI session, for Fork and Compact. ACP has no fork in
// gemini-cli 0.64 (its agent leaves `session/fork` out), its /restore does not
// put a checkpoint's history back into the session, and /compress is only in
// the terminal. But `session/load` rebuilds a session from its file's
// messages, so a copy of that file under a new id, in another folder's chats
// folder, opens there as a session with the same history. The CLI puts its
// session context first, made for the folder it opens in, so the copy's
// workspace paths are the new folder's. A compacted copy is the same file with
// the older messages replaced by a summary.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isPrompt, MessageRecord, projectHash, registeredChatsFolder, squashSpaces, textOf } from './cliSessions';

/** How many of the latest prompts a compacted session keeps as they were, at most. */
export const compactKeepPrompts = 4;

/** The share of a session's size the kept prompts may take, as the CLI's own compression keeps its newest 30%. */
export const compactKeepShare = 0.3;

/** Rough characters per token, for estimates shown before anything is sent. */
const charsPerToken = 4;

/**
 * The messages before one of the user's prompts, for Fork from Here: the
 * prompt is found by its text, `fromEnd` being how many later prompts have
 * the same text. Undefined when it isn't found.
 */
export function messagesBefore(messages: readonly MessageRecord[], prompt: string, fromEnd: number): MessageRecord[] | undefined {
	const wanted = squashSpaces(prompt);
	if (!wanted) {
		return undefined;
	}
	// The CLI's message also carries what GeminiCode added to the prompt, such as context.
	const matches = messages.flatMap((message, i) => message.type === 'user' && squashSpaces(textOf(message.content)).includes(wanted) ? [i] : []);
	const index = matches[matches.length - 1 - fromEnd];
	return index === undefined ? undefined : messages.slice(0, index);
}

/** What a message adds to a model request, in characters: its text and its tool calls, not its thoughts. */
function messageSize(message: MessageRecord): number {
	let size = textOf(message.content).length;
	if (Array.isArray(message.toolCalls)) {
		for (const call of message.toolCalls) {
			size += JSON.stringify((call as { args?: unknown }).args ?? '').length + JSON.stringify((call as { result?: unknown }).result ?? '').length;
		}
	}
	return size;
}

/** About how many tokens `messages` add to each model request. */
export function estimateTokens(messages: readonly MessageRecord[]): number {
	return Math.round(messages.reduce((sum, message) => sum + messageSize(message), 0) / charsPerToken);
}

/** Whether a message is one of the user's prompts, not context or a command the CLI added. */
function isPromptMessage(message: MessageRecord): boolean {
	return message.type === 'user' && isPrompt(textOf(message.content).trim());
}

/**
 * Where a compacted session's kept messages start: at the earliest of the
 * last `keepPrompts` prompts whose messages from there on take at most
 * `keepShare` of the whole. `messages.length` when none fit, so only the
 * summary is kept.
 */
export function compactSplit(messages: readonly MessageRecord[], keepPrompts = compactKeepPrompts, keepShare = compactKeepShare): number {
	const sizes = messages.map(messageSize);
	const total = sizes.reduce((sum, size) => sum + size, 0);
	// The prompts that fit, latest first.
	const splits: number[] = [];
	let kept = 0;
	for (let i = messages.length - 1; i >= 0 && splits.length < keepPrompts; i--) {
		kept += sizes[i];
		if (kept > total * keepShare) {
			break;
		}
		if (isPromptMessage(messages[i])) {
			splits.push(i);
		}
	}
	// Never keep everything: a split at or before the first prompt would summarize nothing.
	const first = messages.findIndex(isPromptMessage);
	return splits.filter(split => split > first).at(-1) ?? messages.length;
}

/** The note a compacted session starts with, which holds the summary. */
export function compactedNote(summary: string): string {
	return `This session was compacted to save context. The earlier work is summarized below; the messages after this one are the latest ones, as they were. Carry on from both.\n\n<summary_of_earlier_work>\n${summary.trim()}\n</summary_of_earlier_work>`;
}

/**
 * A compacted copy of `messages`: a user message with `summary`, the model's
 * acknowledgement, then the messages from `split` on, unchanged. The CLI's
 * session context is left out: on `session/load` it skips the saved one and
 * puts a fresh one first, for the folder the session opens in.
 */
export function compactedMessages(messages: readonly MessageRecord[], summary: string, split: number, now = new Date()): MessageRecord[] {
	const timestamp = now.toISOString();
	return [
		{ id: randomUUID(), timestamp, type: 'user', content: [{ text: compactedNote(summary) }] },
		{ id: randomUUID(), timestamp, type: 'gemini', content: 'Understood. I have the summary of the earlier work and will carry on from it.' },
		...messages.slice(split),
	];
}

/** The name the CLI gives a session's file: its start to the minute, then the first 8 characters of its id. */
export function sessionFileName(id: string, started: Date): string {
	return `session-${started.toISOString().slice(0, 16).replace(/:/g, '-')}-${id.slice(0, 8)}.jsonl`;
}

/**
 * Writes `messages` as a new session of `cwd`'s, with a new id, where the CLI
 * looks for `cwd`'s sessions; resolves with the id, which `session/load` in
 * `cwd` then opens. The CLI must have registered `cwd` first (it does when it
 * opens any session there), else this rejects.
 */
export async function writeSessionCopy(cwd: string, messages: readonly MessageRecord[], options: { readonly home?: string; readonly now?: Date } = {}): Promise<string> {
	const folder = await registeredChatsFolder(cwd, options.home);
	if (!folder) {
		throw new Error(`The Gemini CLI has not opened a session in ${cwd} yet.`);
	}
	const id = randomUUID();
	const now = options.now ?? new Date();
	const time = now.toISOString();
	const header = { sessionId: id, projectHash: projectHash(cwd), startTime: time, lastUpdated: time, kind: 'main' };
	const text = [header, ...messages].map(record => JSON.stringify(record)).join('\n') + '\n';
	await fs.mkdir(folder, { recursive: true });
	// Written whole, then renamed, so the CLI never reads half a file.
	const file = path.join(folder, sessionFileName(id, now));
	await fs.writeFile(`${file}.tmp`, text, 'utf8');
	await fs.rename(`${file}.tmp`, file);
	return id;
}
