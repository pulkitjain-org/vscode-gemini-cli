/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Emoji reactions in a chat. You react to one of the agent's replies, and the
// reaction goes to the agent as a prompt with a hidden <reaction_note>; four
// emoji have fixed meanings, and the model reads every other one. The agent may
// react to your prompt by starting its reply with <react>X</react>, which the
// transcript lifts out before anything stores or shows the reply. Pure, so the
// chat's decisions are tested without the extension host.

import type { TranscriptItem } from './chatTranscript';

/** A reaction to one of the agent's replies. */
export interface ReactionRef {
	/** The reply's turnEnd item; unset for a reaction rebuilt from a saved session's replay. */
	readonly turnEnd?: string;
	readonly emoji: string;
	/** Its name in the picker, such as "rocket"; it helps the model with rarer emoji. */
	readonly name: string;
}

/** A reaction on its way to the agent: what its note needs to say. */
export interface ReactionRequest extends ReactionRef {
	/** The fixed or edited meaning; unset leaves the model to read it. */
	readonly meaning?: string;
	/** The start of the reply, when it is not the latest one. */
	readonly excerpt?: string;
	/** The reply's turn was stopped or failed. */
	readonly unfinished?: boolean;
}

/** What a reaction does: a chip only, Build plan, steer the running turn, wait for it, or start a turn. */
export type ReactionRoute = 'mark' | 'buildPlan' | 'now' | 'queue' | 'send';

/** The emoji with fixed meanings, written as escapes for the hygiene check. */
export const thumbsUp = '\u{1F44D}';
export const thumbsDown = '\u{1F44E}';
export const question = '\u{2753}';
export const heart = '\u{2764}\u{FE0F}';

/** The fixed meanings; the unedited heart has none, so it is only a chip. */
const builtInMeanings: ReadonlyMap<string, string | undefined> = new Map([
	[thumbsUp, 'Approve what you proposed and go ahead.'],
	[thumbsDown, 'That is not right: stop, say in one line what you understood, and ask what to change. Do not undo work on your own.'],
	[question, 'Explain your last reply more simply, with an example.'],
	[heart, undefined],
]);

/** The longest meaning `gemini.chat.reactions.meanings` may give an emoji. */
export const maxMeaningLength = 500;

/** How much of an older reply the note quotes. */
const excerptLength = 300;

/** An emoji without its variation selectors, so a heart with or without one is the same heart. */
export function emojiKey(emoji: string): string {
	return emoji.replace(/\u{FE0F}/gu, '');
}

const singleEmoji = /^\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier}|\u{20E3})*(?:\u{200D}\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})*)*$|^(?:\p{Regional_Indicator}){2}$|^[#*0-9]\u{FE0F}?\u{20E3}$/u;

/** Whether `text` is one emoji, joined sequences and flags included. */
export function isSingleEmoji(text: string): boolean {
	return singleEmoji.test(text);
}

/**
 * The meaning of each emoji with one: the built-in four, with
 * `gemini.chat.reactions.meanings` laid over them. An entry changes or adds a
 * meaning; a built-in is never removed. Entries that are not one emoji and a
 * non-empty text of at most {@link maxMeaningLength} characters are ignored.
 */
export function resolveMeanings(setting: unknown): ReadonlyMap<string, string | undefined> {
	const meanings = new Map<string, string | undefined>();
	for (const [emoji, meaning] of builtInMeanings) {
		meanings.set(emojiKey(emoji), meaning);
	}
	if (typeof setting !== 'object' || setting === null || Array.isArray(setting)) {
		return meanings;
	}
	for (const [emoji, meaning] of Object.entries(setting)) {
		const text = typeof meaning === 'string' ? meaning.trim() : '';
		if (isSingleEmoji(emoji.trim()) && text && text.length <= maxMeaningLength) {
			meanings.set(emojiKey(emoji.trim()), text);
		}
	}
	return meanings;
}

/** Whether `emoji` only marks the reply: it has a meaning entry, and that entry is empty. */
function marksOnly(emoji: string, meanings: ReadonlyMap<string, string | undefined>): boolean {
	const key = emojiKey(emoji);
	return meanings.has(key) && meanings.get(key) === undefined;
}

/**
 * What a reaction does. The heart, unless edited, is only a chip. A thumbs up
 * on the reply that offers Build plan builds the plan. A thumbs down steers a
 * running turn; anything else waits for it, or starts a turn when idle.
 */
export function routeReaction(emoji: string, meanings: ReadonlyMap<string, string | undefined>, chat: { readonly busy: boolean; readonly buildPlan: boolean }): ReactionRoute {
	if (marksOnly(emoji, meanings)) {
		return 'mark';
	}
	const key = emojiKey(emoji);
	if (key === emojiKey(thumbsUp) && chat.buildPlan && !chat.busy) {
		return 'buildPlan';
	}
	if (!chat.busy) {
		return 'send';
	}
	return key === emojiKey(thumbsDown) ? 'now' : 'queue';
}

/** The meaning `emoji` has, if any. */
export function meaningOf(emoji: string, meanings: ReadonlyMap<string, string | undefined>): string | undefined {
	return meanings.get(emojiKey(emoji));
}

const noteStart = '<reaction_note>';
const noteEnd = '</reaction_note>';
const ruleStart = '<reaction_rule>';
const ruleEnd = '</reaction_rule>';

/**
 * The hidden note sent for a reaction. `stopped`: it stopped the running turn
 * to be sent, so the agent checks its last step before repeating it.
 */
export function reactionNote(reaction: ReactionRequest, stopped = false): string {
	const target = reaction.excerpt ? ` that began: "${reaction.excerpt}"` : '';
	const lines = [`The user reacted ${reaction.emoji} (${reaction.name}) to your reply${target}.`];
	if (reaction.unfinished) {
		lines.push('That turn did not finish.');
	}
	if (stopped) {
		lines.push('The user stopped your turn to send it. Your last step may not have finished: check its result before repeating it.');
	}
	// Its reading comes before any step, so a misread shows before a tool runs.
	lines.push('Before any tool call, say in one short line how you read the reaction.');
	if (reaction.meaning) {
		lines.push(`They mean: ${reaction.meaning}`);
	} else {
		lines.push(
			'Decide what they mean.',
			'- If it clearly approves or asks for a next step you proposed, do it.',
			'- If it is negative or asks for a change, ask what to change. Do not undo work on your own.',
			'- If it is only appreciation or acknowledgement, reply in one short line and take no action.',
			'- If you are unsure, ask one short question.',
		);
	}
	return `${noteStart}\n${lines.join('\n')}\n${noteEnd}\n`;
}

/** The rule that lets the agent react to the user's prompts, sent once per session. */
export function reactionRule(): string {
	return `${ruleStart}\nYou may begin a reply with <react>X</react>, where X is one emoji reacting to the user's message. Use it only when a reaction adds something, such as good news or thanks; most replies have none. Never mention the tag.\n${ruleEnd}\n`;
}

const notePattern = /<reaction_note>\n?([\s\S]*?)<\/reaction_note>\s*/g;
const rulePattern = /<reaction_rule>[\s\S]*?<\/reaction_rule>\s*/g;
const reactedPattern = /^The user reacted (?<emoji>\S+) \((?<name>[^)]*)\) to your reply/;

/**
 * A saved session's user message without GeminiCode's reaction notes and
 * rule, with the reactions its notes carried, for the replay.
 */
export function withoutReactionNotes(text: string): { readonly text: string; readonly reactions: readonly ReactionRef[] } {
	const reactions: ReactionRef[] = [];
	for (const match of text.matchAll(notePattern)) {
		const found = reactedPattern.exec(match[1].trim());
		if (found?.groups) {
			reactions.push({ emoji: found.groups.emoji, name: found.groups.name });
		}
	}
	return { text: text.replace(notePattern, '').replace(rulePattern, ''), reactions };
}

/** The start of the agent's reply, as the note quotes it. */
export function replyExcerpt(reply: string): string {
	const line = reply.replace(/\s+/g, ' ').trim();
	return line.length > excerptLength ? `${line.slice(0, excerptLength - 1).trimEnd()}…` : line;
}

const tagOpen = '<react>';
const tagClose = '</react>';
/** Past this many characters a tag is no longer looked for: the reply is plain text. */
export const reactionHoldLength = 32;

/**
 * Whether the start of a reply carries the agent's reaction: `pending` while
 * it could still be a tag, `none` once it cannot, or the emoji and the text
 * after the tag. Only a complete tag at the very start holding one emoji
 * counts; anything else is left as text.
 */
export function leadingReaction(text: string): 'pending' | 'none' | { readonly emoji: string; readonly rest: string } {
	const start = text.length - text.trimStart().length;
	const body = text.slice(start);
	if (body.length < tagOpen.length) {
		return tagOpen.startsWith(body) && text.length < reactionHoldLength ? 'pending' : 'none';
	}
	if (!body.startsWith(tagOpen)) {
		return 'none';
	}
	const close = body.indexOf(tagClose);
	if (close < 0) {
		return text.length < reactionHoldLength ? 'pending' : 'none';
	}
	const emoji = body.slice(tagOpen.length, close).trim();
	if (!isSingleEmoji(emoji)) {
		return 'none';
	}
	return { emoji, rest: body.slice(close + tagClose.length).replace(/^[ \t]*\n?/, '') };
}

/** What a thread tells its coordinator when its turn came from the user's reactions. */
export function reactionReport(reactions: readonly ReactionRef[]): string | undefined {
	if (!reactions.length) {
		return undefined;
	}
	return `The user reacted ${reactions.map(reaction => reaction.emoji).join(' ')} to its reply.`;
}

/** How many emoji the picker's Recent row keeps. */
export const maxRecents = 16;

/** `recents` with `emoji` first, once, at most {@link maxRecents} long. */
export function withRecent(recents: readonly string[], emoji: string): string[] {
	return [emoji, ...recents.filter(other => emojiKey(other) !== emojiKey(emoji))].slice(0, maxRecents);
}

/**
 * The start of the reply that turnEnd `id` ends, for the note; undefined when
 * it is the latest reply, which the agent knows without a quote.
 */
export function olderReplyExcerpt(items: readonly TranscriptItem[], id: string): string | undefined {
	const index = items.findIndex(item => item.id === id);
	if (index < 0 || !items.slice(index + 1).some(item => item.kind === 'turnEnd')) {
		return undefined;
	}
	const parts: string[] = [];
	for (let i = index - 1; i >= 0 && items[i].kind !== 'user'; i--) {
		const item = items[i];
		if (item.kind === 'agent') {
			parts.unshift(item.text);
		}
	}
	const excerpt = replyExcerpt(parts.join(' '));
	return excerpt || undefined;
}
