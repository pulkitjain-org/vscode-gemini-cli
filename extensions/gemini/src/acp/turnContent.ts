/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The order of what a turn sends the agent beside the user's own message.
// What goes first is read first: the steering note (why the last turn
// stopped), the notes of the reactions sent with it, the reaction rule, the
// window's context, a conversation carried over from a session the chat
// left, and the note of what Undo put back; then what is long and only to be
// read, the design system's note and the shared page; then the user's message
// with its attachments; then the one-line index hint. Long context comes
// before the ask and the ask near the end, as Google's prompting guidance for
// Gemini has it: the model answers the last thing it read about what came
// before it.

import type * as acp from '@agentclientprotocol/sdk';

export interface TurnContentParts {
	/** The user's message and attachments, as `buildPromptContent` made them. */
	readonly content: readonly acp.ContentBlock[];
	/** Why the last turn stopped, when this one steers the agent on. */
	readonly steering?: string;
	/** The notes of the reactions sent with the message, in order. */
	readonly notes?: readonly string[];
	/** How to react, told once per session. */
	readonly reactionRule?: string;
	/** The window's context, such as the open editor, until the agent has it. */
	readonly context?: string;
	/** A conversation carried over from a session the chat left (an overflow, a compress). */
	readonly carried?: string;
	/** What Undo put back since the last turn. */
	readonly undoNote?: string;
	/** The one-line nudge to use the index tools, once per session. */
	readonly hint?: string;
	/** The design system's note, when a Figma design is attached. */
	readonly design?: string;
	/** The page the user shared in the browser. */
	readonly page?: string;
}

/** The turn's blocks, in the order above. */
export function assembleTurnContent(parts: TurnContentParts): acp.ContentBlock[] {
	const text = (value: string | undefined): acp.ContentBlock[] => value ? [{ type: 'text', text: value }] : [];
	return [
		...text(parts.steering),
		...(parts.notes ?? []).flatMap(note => text(note)),
		...text(parts.reactionRule),
		...text(parts.context),
		...text(parts.carried),
		...text(parts.undoNote),
		...text(parts.design),
		...text(parts.page),
		...parts.content,
		...text(parts.hint),
	];
}
