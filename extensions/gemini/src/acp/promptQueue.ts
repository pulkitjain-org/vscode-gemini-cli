/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages sent while an agent works. A queued message waits for the turn to
// end and goes as the next prompt. A message sent now steers: the chat waits
// until no tool is running, stops the turn and sends it at once with a note
// that tells the agent to carry on. gemini-cli's ACP mode has no way to add a
// message to a running turn (its terminal UI's `experimental.modelSteering`
// does not reach ACP), so stopping at a safe point is the closest it gets.
// The note follows the CLI's own steering wording (`USER_STEERING_INSTRUCTION`,
// gemini-cli 0.64), so the model reacts as it does in the terminal.

import type { Attachment } from './attachments';
import type { TranscriptItem } from './chatTranscript';
import type { ReactionRequest } from './reactions';

export interface PendingPrompt {
	readonly id: string;
	readonly text: string;
	readonly attachments: readonly Attachment[];
	/** Sent now: it goes as soon as the turn reaches a safe point. Otherwise it waits for the turn to end. */
	readonly steer: boolean;
	/** Sent by the thread's project coordinator, not typed by the user. */
	readonly from?: 'coordinator';
	/** Reactions to the agent's replies, sent with hidden notes. */
	readonly reactions?: readonly ReactionRequest[];
}

/** What the composer shows about a pending prompt. */
export interface PendingPromptView {
	readonly id: string;
	readonly text: string;
	readonly attachments: number;
	readonly steer: boolean;
	readonly from?: 'coordinator';
	readonly reactions?: readonly { readonly emoji: string; readonly name: string }[];
}

/** The prompts waiting in one chat, oldest first. */
export class PromptQueue {
	private items: PendingPrompt[] = [];
	private nextId = 1;

	get pending(): readonly PendingPrompt[] {
		return this.items;
	}

	get hasSteer(): boolean {
		return this.items.some(item => item.steer);
	}

	get view(): PendingPromptView[] {
		return this.items.map(({ id, text, attachments, steer, from, reactions }) => ({
			id, text, attachments: attachments.length, steer, ...(from ? { from } : {}),
			...(reactions?.length ? { reactions: reactions.map(({ emoji, name }) => ({ emoji, name })) } : {}),
		}));
	}

	add(text: string, attachments: readonly Attachment[], steer: boolean, from?: 'coordinator'): void {
		this.items.push({ id: `q${this.nextId++}`, text, attachments, steer, ...(from ? { from } : {}) });
	}

	/**
	 * Adds a reaction as a message of its own. A reaction still waiting for the
	 * same reply is replaced, so reacting again changes it rather than adding a turn.
	 */
	addReaction(reaction: ReactionRequest, steer: boolean): void {
		const index = this.items.findIndex(item => !item.text && item.reactions?.some(r => r.turnEnd === reaction.turnEnd));
		const id = index < 0 ? `q${this.nextId++}` : this.items[index].id;
		const item: PendingPrompt = { id, text: '', attachments: [], steer, reactions: [reaction] };
		if (index < 0) {
			this.items.push(item);
		} else {
			this.items[index] = item;
		}
	}

	/** Whether `emoji` on reply `turnEnd` is waiting to go. */
	hasReaction(turnEnd: string, emoji: string): boolean {
		return this.items.some(item => item.reactions?.some(r => r.turnEnd === turnEnd && r.emoji === emoji));
	}

	/** Takes out the prompt `id`; undefined when it is gone. */
	remove(id: string): PendingPrompt | undefined {
		const index = this.items.findIndex(item => item.id === id);
		return index < 0 ? undefined : this.items.splice(index, 1)[0];
	}

	/** Sends `id` now: it joins the prompts that steer. */
	steer(id: string): boolean {
		const index = this.items.findIndex(item => item.id === id);
		if (index < 0 || this.items[index].steer) {
			return false;
		}
		this.items[index] = { ...this.items[index], steer: true };
		return true;
	}

	/** The turn was stopped or failed: what was to be sent now waits, like a queued prompt, until the user sends it. */
	holdSteers(): void {
		this.items = this.items.map(item => item.steer ? { ...item, steer: false } : item);
	}

	/** Takes out the prompts that steer, joined into one; undefined when there are none. */
	takeSteers(): JoinedPrompt | undefined {
		const taken = this.items.filter(item => item.steer);
		this.items = this.items.filter(item => !item.steer);
		return joinPrompts(taken);
	}

	/** Takes out every prompt, joined into one, as gemini-cli sends its own queue; undefined when there are none. */
	takeAll(): JoinedPrompt | undefined {
		const taken = this.items;
		this.items = [];
		return joinPrompts(taken);
	}

	clear(): void {
		this.items = [];
	}
}

/** Prompts taken out together, as one; from the coordinator only when every one of them was. */
export interface JoinedPrompt {
	readonly text: string;
	readonly attachments: readonly Attachment[];
	readonly from?: 'coordinator';
	readonly reactions?: readonly ReactionRequest[];
}

function joinPrompts(prompts: readonly PendingPrompt[]): JoinedPrompt | undefined {
	if (!prompts.length) {
		return undefined;
	}
	return {
		text: prompts.map(prompt => prompt.text.trim()).filter(Boolean).join('\n\n'),
		attachments: prompts.flatMap(prompt => prompt.attachments),
		...(prompts.every(prompt => prompt.from === 'coordinator') ? { from: 'coordinator' as const } : {}),
		...(prompts.some(prompt => prompt.reactions?.length) ? { reactions: prompts.flatMap(prompt => prompt.reactions ?? []) } : {}),
	};
}

/**
 * Whether the running turn can be stopped without cutting a tool short: no
 * tool call since the last prompt is running. A tool call waiting for the
 * user's permission has not started, so stopping there is safe too.
 */
export function atSafePoint(items: readonly TranscriptItem[], waitingForPermission: boolean): boolean {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind === 'user') {
			return true;
		}
		if (item.kind === 'toolCall' && (item.status === 'in_progress' || (item.status === 'pending' && !waitingForPermission))) {
			return false;
		}
	}
	return true;
}

const noteStart = '<steering_note>';
const noteEnd = '</steering_note>';

/** The hidden text sent ahead of a prompt that steered a stopped turn. */
export function steeringNote(): string {
	return `${noteStart}
The user stopped your turn to send the message that follows, as a steering update to the work in progress. Your last step may not have finished: check its result before repeating it.
Re-evaluate the active plan using this user steering update. Classify it as ADD_TASK, MODIFY_TASK, CANCEL_TASK, or EXTRA_CONTEXT. Apply minimal-diff changes only to affected tasks and keep unaffected tasks active. Do not cancel/skip tasks unless the user explicitly cancels them. Acknowledge the steering briefly and state the course correction, then carry on with the work.
${noteEnd}`;
}

/** `text` without a steering note at its start, for a saved session's replay. */
export function withoutSteeringNote(text: string): string {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith(noteStart)) {
		return text;
	}
	const end = trimmed.indexOf(noteEnd);
	return end < 0 ? text : trimmed.slice(end + noteEnd.length).trimStart();
}
