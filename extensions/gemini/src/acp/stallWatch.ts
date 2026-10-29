/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Whether a running turn has gone quiet: no update from the agent for a
// while, with no tool running and no question open for the user. The chat
// shows a stall notice from it (AgentClient.onDidChangeStall). One timer per
// turn, moved on only when it fires, so an update costs no timer work.

import type { CliRetry } from './errors';
import { Emitter } from './events';

/** A running turn that has had no update from the agent for a while. */
export interface TurnStall {
	/** When the agent was last heard from, in ms since the epoch. */
	readonly since: number;
	/** The CLI's last retry of its model call, when it logged one: the model, not the CLI, is what is slow. */
	readonly retry?: CliRetry;
}

export class StallWatch {

	private readonly onDidChangeEmitter = new Emitter<TurnStall | undefined>();
	/** The turn stalled, its stall changed (a retry was logged), or it ended (undefined). */
	readonly onDidChange = this.onDidChangeEmitter.event;

	private lastUpdateAt = 0;
	private readonly openToolCalls = new Set<string>();
	private waiting = 0;
	private lastRetry: CliRetry | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private _stall: TurnStall | undefined;

	constructor(
		/** How long without an update counts as stalled. */
		private readonly afterMs: number,
		/** Whether a turn runs now; nothing counts while none does. */
		private readonly running: () => boolean,
		private readonly now: () => number = Date.now,
	) { }

	/** The running turn's stall, while it has had no update for a while; undefined otherwise. */
	get stall(): TurnStall | undefined {
		return this._stall;
	}

	/** A turn started (the first of those running). */
	begin(): void {
		this.lastUpdateAt = this.now();
		this.lastRetry = undefined;
		this.openToolCalls.clear();
		this.arm(this.afterMs);
	}

	/** The last running turn ended. */
	end(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.openToolCalls.clear();
		this.lastRetry = undefined;
		this.set(undefined);
	}

	/** Something came from the agent for the running turn: it is not stalled. */
	noteActivity(): void {
		if (!this.running()) {
			return;
		}
		this.lastUpdateAt = this.now();
		this.lastRetry = undefined;
		if (this._stall) {
			this.set(undefined);
			this.arm(this.afterMs);
		}
	}

	/** A tool call started, went on or ended: while one runs, the agent is not stuck. A call without a status is pending. */
	toolCall(toolCallId: string, status: string | undefined | null, started: boolean): void {
		if (status === 'completed' || status === 'failed') {
			this.openToolCalls.delete(toolCallId);
		} else if (started || status) {
			this.openToolCalls.add(toolCallId);
		}
	}

	/** A question for the user is open; while they decide, the turn does not count as stalled. */
	waitBegin(): void {
		this.noteActivity();
		this.waiting++;
	}

	waitEnd(): void {
		this.waiting--;
		this.noteActivity();
	}

	/** The CLI retried its model call: shown with the stall, since the model is what is slow. */
	retry(retry: CliRetry): void {
		if (!this.running()) {
			return;
		}
		this.lastRetry = retry;
		if (this._stall) {
			this.set({ ...this._stall, retry });
		}
	}

	dispose(): void {
		this.end();
		this.onDidChangeEmitter.dispose();
	}

	private arm(ms: number): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.check(), ms);
	}

	private check(): void {
		this.timer = undefined;
		if (!this.running()) {
			return;
		}
		const quiet = this.now() - this.lastUpdateAt;
		if (this.openToolCalls.size || this.waiting) {
			// A running tool or a question for the user: the agent is not stuck.
			this.arm(this.afterMs);
		} else if (quiet >= this.afterMs) {
			this.set({ since: this.lastUpdateAt, ...(this.lastRetry ? { retry: this.lastRetry } : {}) });
		} else {
			this.arm(this.afterMs - quiet);
		}
	}

	private set(stall: TurnStall | undefined): void {
		if (stall || this._stall) {
			this._stall = stall;
			this.onDidChangeEmitter.fire(stall);
		}
	}
}
