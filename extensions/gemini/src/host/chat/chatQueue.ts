/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages sent while the agent works (src/acp/promptQueue.ts): queued for
// after the turn, or steering it, which stops the turn at its next safe point
// and sends them at once. A long tool chain may not reach a safe point for a
// while; the queue then offers Stop Now. A coordinator's turn is never
// stopped: its messages go when it ends.

import type { Attachment } from '../../acp/attachments';
import type { ChatTranscript } from '../../acp/chatTranscript';
import { atSafePoint, type JoinedPrompt, PromptQueue, steerWaitMs, type PendingPrompt, type PromptExtras } from '../../acp/promptQueue';
import type { ReactionRequest } from '../../acp/reactions';
import type { ToWebview } from '../chatProtocol';
import type { ChatAttachments } from './chatAttachments';
import type { ChatControllerOptions, ChatHost } from './chatOptions';

/** What the queue needs of its chat. */
export interface QueueHost {
	isBusy(): boolean;
	setBusy(busy: boolean): void;
	/** A turn runs whose updates stay out of the transcript, such as Compact's summary: there is no turn to stop. */
	isQuiet(): boolean;
	/** The running turn still waits for its session: there is no turn to stop. */
	turnWaiting(): boolean;
	/** Sends a message as if typed in the view. */
	send(text: string, attachments: readonly Attachment[], from: 'coordinator' | undefined, when: 'now' | 'queue' | undefined, extras: PromptExtras): Promise<void>;
	/** Starts a prompt's turn, the chat being idle, with the notes of any reactions it carries. */
	startPrompt(text: string, attachments: readonly Attachment[], from: 'coordinator' | undefined, reactions: readonly ReactionRequest[]): Promise<void>;
	/** Starts the turn of messages taken out of the queue, `steer` after a turn stopped for them. */
	runNext(next: JoinedPrompt, steer: boolean): Promise<void>;
}

export class ChatQueue {

	/** Messages sent while the agent works: queued for after the turn, or steering it at its next safe point. */
	private readonly queue = new PromptQueue();
	/** The turn is being stopped to send the messages that steer it. */
	private steerStopping = false;
	/** Offers Stop Now on a message sent now that has waited `steerWaitMs` for a safe point. */
	private steerWaitTimer: ReturnType<typeof setTimeout> | undefined;
	private steerWaiting = false;

	constructor(
		private readonly service: Pick<ChatHost, 'permissions' | 'cancel'>,
		private readonly transcript: ChatTranscript,
		private readonly attachments: ChatAttachments,
		private readonly options: Pick<ChatControllerOptions, 'project'>,
		private readonly host: QueueHost,
		private readonly post: (message: ToWebview) => void,
	) { }

	/** Whether a message sent now waits to steer the turn. */
	get hasSteer(): boolean {
		return this.queue.hasSteer;
	}

	/** The turn is being stopped to send the messages that steer it. */
	get stopping(): boolean {
		return this.steerStopping;
	}

	/** The messages waiting, oldest first. */
	get pending(): readonly PendingPrompt[] {
		return this.queue.pending;
	}

	/** The coordinator is working: the message waits for its turn to end, never stopping it. */
	holdForCoordinator(text: string, attachments: readonly Attachment[], extras: PromptExtras): void {
		this.queue.add(text, attachments, false, undefined, extras);
		this.postQueue();
	}

	/**
	 * A message sent while a turn runs: a coordinator's note waits for the
	 * turn to end; the user's own message steers when sent now, except one
	 * with the user's edits, which can only go once the agent's turn is over.
	 * Without `when` or `from` the message is dropped, as before.
	 */
	holdOrSteer(text: string, attachments: readonly Attachment[], from: 'coordinator' | undefined, when: 'now' | 'queue' | undefined, extras: PromptExtras): void {
		if (when || from) {
			this.queue.add(text, attachments, when === 'now' && !extras.includeEdits, from, extras);
			this.postQueue();
			this.trySteer();
		} else {
			extras.settle?.(false);
		}
	}

	/** Whether a reaction to `turnEnd` with `emoji` waits in the queue. */
	hasReaction(turnEnd: string, emoji: string): boolean {
		return this.queue.hasReaction(turnEnd, emoji);
	}

	/** Queues a reaction's turn, `now` steering the running one. */
	addReaction(request: ReactionRequest, now: boolean): void {
		this.queue.addReaction(request, now);
		this.postQueue();
	}

	/** The turn ended: the messages that would have steered it wait like queued ones. */
	holdSteers(): void {
		this.queue.holdSteers();
		this.postQueue();
	}

	/** The turn stopped for the messages that steer it, or ended another way: the next turn starts afresh. */
	endSteerStop(): void {
		this.steerStopping = false;
	}

	/** Stop, as the Stop button does: messages sent now wait instead, for the user to send. */
	stopped(): void {
		this.steerStopping = false;
		this.setSteerWaiting(false);
		if (this.queue.hasSteer) {
			this.queue.holdSteers();
			this.postQueue();
		}
	}

	/** Takes every waiting message out, as a new conversation starts. */
	clear(): void {
		this.queue.clear();
		this.postQueue();
	}

	dispose(): void {
		clearTimeout(this.steerWaitTimer);
		this.queue.clear();
	}

	/**
	 * After a turn: messages sent now go at once, steering a stopped turn or
	 * starting the next one if the turn ended first; queued ones go when the
	 * turn finished, all together. A turn the user stopped, or that failed,
	 * keeps them waiting, and what was sent now waits like a queued message.
	 */
	async sendPending(outcome: 'done' | 'steer' | 'stopped'): Promise<void> {
		if (outcome !== 'steer' && this.host.isBusy()) {
			return;
		}
		if (outcome === 'stopped') {
			this.queue.holdSteers();
			this.queue.dropAwaited();
			this.postQueue();
			return;
		}
		const next = outcome === 'steer' || this.queue.hasSteer ? this.queue.takeSteers() : this.queue.takeAll();
		this.postQueue();
		if (!next) {
			if (outcome === 'steer') {
				this.host.setBusy(false);
			}
			return;
		}
		if (this.options.project) {
			// What waited in a project's chat goes to the hub, which wakes the coordinator again.
			await this.host.send(next.text, next.attachments, undefined, undefined, next);
			return;
		}
		await this.host.runNext(next, outcome === 'steer');
	}

	/** Stops the turn for the messages sent now, once no tool is running; a running tool's end calls this again. */
	trySteer(): void {
		// While the session still opens there is no turn to stop: the messages go when it ends.
		if (!this.host.isBusy() || this.host.isQuiet() || this.steerStopping || !this.queue.hasSteer || this.host.turnWaiting()) {
			return;
		}
		const waiting = this.service.permissions.pendingPermissions.length > 0;
		if (!atSafePoint(this.transcript.items, waiting)) {
			// A long tool chain may not reach one for a while: the queue then offers Stop Now.
			this.steerWaitTimer ??= setTimeout(() => {
				this.steerWaitTimer = undefined;
				if (this.host.isBusy() && this.queue.hasSteer && !this.steerStopping) {
					this.setSteerWaiting(true);
				}
			}, steerWaitMs);
			return;
		}
		this.stopForSteer();
	}

	/** Stops the turn for the messages sent now; Stop Now does it without waiting for a safe point. */
	private stopForSteer(): void {
		this.setSteerWaiting(false);
		this.steerStopping = true;
		void this.service.cancel();
	}

	setSteerWaiting(waiting: boolean): void {
		if (!waiting) {
			clearTimeout(this.steerWaitTimer);
			this.steerWaitTimer = undefined;
		}
		if (this.steerWaiting !== waiting) {
			this.steerWaiting = waiting;
			this.post({ type: 'steerWaiting', waiting });
		}
	}

	postQueue(): void {
		this.post({ type: 'queue', items: this.queue.view });
	}

	/** A pending message's buttons in the composer. */
	queueAction(id: string, action: 'send' | 'edit' | 'remove' | 'stopNow'): void {
		if (action === 'stopNow') {
			// As `trySteer`: no turn to stop while the session opens, nor a quiet one.
			if (this.host.isBusy() && !this.host.isQuiet() && !this.host.turnWaiting() && this.queue.hasSteer && !this.steerStopping) {
				this.stopForSteer();
			}
			return;
		}
		if (action === 'send') {
			if (!this.host.isBusy()) {
				const prompt = this.queue.remove(id);
				this.postQueue();
				if (prompt?.reactions?.length) {
					void this.host.startPrompt(prompt.text, prompt.attachments, prompt.from, prompt.reactions);
				} else if (prompt) {
					void this.host.send(prompt.text, prompt.attachments, prompt.from, undefined, prompt);
				}
				return;
			}
			// A coordinator's turn is never stopped: its messages go when it ends.
			if (!this.options.project && this.queue.steer(id)) {
				this.postQueue();
				this.trySteer();
			}
			return;
		}
		const prompt = this.queue.remove(id);
		this.postQueue();
		prompt?.settle?.(false);
		// A reaction has no text to edit: Edit only takes it out.
		if (action === 'edit' && prompt?.text) {
			this.post({ type: 'draft', text: prompt.text });
			if (prompt.attachments.length) {
				void this.attachments.add(prompt.attachments);
			}
		}
	}
}
