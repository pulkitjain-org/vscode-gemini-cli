/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Reactions to the agent's replies (src/acp/reactions.ts): the reply gets
// the chip, and the reaction goes to the agent as its meaning says, now,
// with the next message, or as its own turn. The recents and meanings the
// view offers come from the settings (../chatReactions.ts).

import type { ChatTranscript } from '../../acp/chatTranscript';
import { meaningOf, olderReplyExcerpt, routeReaction, type ReactionRef, type ReactionRequest } from '../../acp/reactions';
import type { ToWebview } from '../chatProtocol';
import { reactionMeanings, reactionsOn, recentReactions, rememberReaction, shownMeanings } from '../chatReactions';
import type { ChatControllerOptions } from './chatOptions';
import type { ChatPlan } from './chatPlan';
import type { ChatQueue } from './chatQueue';
import type { ChatTurn } from './chatTurn';

/** What reacting needs of its chat. */
export interface ReactionsHost {
	isBusy(): boolean;
	/** The saved chat being read in, while it is. */
	restoring(): Promise<void> | undefined;
}

/** What the transcript keeps of a reaction sent with a prompt. */
export function reactionRef({ turnEnd, emoji, name }: ReactionRequest): ReactionRef {
	return { ...(turnEnd ? { turnEnd } : {}), emoji, name };
}

export class ChatReactions {

	constructor(
		private readonly transcript: ChatTranscript,
		private readonly options: Pick<ChatControllerOptions, 'project'>,
		private readonly turn: ChatTurn,
		private readonly queue: ChatQueue,
		private readonly plan: ChatPlan,
		private readonly host: ReactionsHost,
		private readonly post: (message: ToWebview) => void,
	) { }

	/**
	 * The user reacted to the reply that `turnEnd` ends: the reply gets the
	 * chip, and the reaction goes to the agent as {@link routeReaction} says.
	 * The same reaction while it is still waiting or running is not sent again.
	 */
	react(turnEnd: string, emoji: string, name: string): void {
		const target = this.transcript.items.find(item => item.id === turnEnd);
		if (this.options.project || !reactionsOn() || target?.kind !== 'turnEnd' || this.queue.hasReaction(turnEnd, emoji) || this.reactionRunning(turnEnd, emoji)) {
			return;
		}
		rememberReaction(emoji);
		this.postReactions();
		const meanings = reactionMeanings();
		const route = routeReaction(emoji, meanings, { busy: this.host.isBusy() || !!this.host.restoring(), buildPlan: !!target.buildPlan && turnEnd === this.turn.retryItemId });
		this.transcript.addReaction(turnEnd, emoji);
		if (route === 'mark') {
			return;
		}
		if (route === 'buildPlan') {
			void this.plan.buildPlan(turnEnd);
			return;
		}
		const meaning = meaningOf(emoji, meanings);
		const excerpt = olderReplyExcerpt(this.transcript.items, turnEnd);
		const request: ReactionRequest = { turnEnd, emoji, name, ...(meaning ? { meaning } : {}), ...(excerpt ? { excerpt } : {}), ...(target.unfinished ? { unfinished: true } : {}) };
		if (route === 'send') {
			void this.sendReaction(request);
			return;
		}
		this.queue.addReaction(request, route === 'now');
		this.queue.trySteer();
	}

	/** Sends a reaction as its own turn, once a saved conversation is in; it waits in the queue if a turn started meanwhile. */
	private async sendReaction(request: ReactionRequest): Promise<void> {
		const restoring = this.host.restoring();
		if (restoring) {
			await restoring;
		}
		if (this.host.isBusy()) {
			this.queue.addReaction(request, false);
			return;
		}
		await this.turn.startPrompt('', [], undefined, [request]);
	}

	/** Whether the running turn's prompt carried this reaction. */
	private reactionRunning(turnEnd: string, emoji: string): boolean {
		if (!this.host.isBusy()) {
			return false;
		}
		const prompt = this.transcript.items.findLast(item => item.kind === 'user');
		return prompt?.kind === 'user' && !!prompt.reactions?.some(reaction => reaction.turnEnd === turnEnd && reaction.emoji === emoji);
	}

	postReactions(): void {
		this.post({ type: 'reactions', on: !this.options.project && reactionsOn(), recents: recentReactions(), meanings: shownMeanings() });
	}
}
