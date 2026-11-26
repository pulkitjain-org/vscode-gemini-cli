/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// When a reopened session's replay of its history is over. The CLI replays
// a saved session as ordinary updates (FINDINGS.md, "The replay"); the chat
// shows them as history, never as a turn, and a prompt waits until they
// stop. The replay's length comes from the session file, read while the
// replay runs; until it is known, and when it is not, a quiet spell ends it.

/** After this long without a replayed update, a replay whose length is not known is taken as over. */
const replayQuietMs = 250;
/** The same for a replay whose length is known, where it only covers a count that is off. */
const countedReplayQuietMs = 3_000;

interface Replay {
	received: number;
	remaining?: number;
	counting: boolean;
	quiet?: ReturnType<typeof setTimeout>;
	readonly done: Promise<void>;
	readonly end: () => void;
}

export class ReplayTracker {

	private replay: Replay | undefined;

	constructor(private readonly quietMs = replayQuietMs, private readonly countedQuietMs = countedReplayQuietMs) { }

	/** Whether a replay is running: updates are history, not a turn. */
	get active(): boolean {
		return !!this.replay;
	}

	/** Resolves once the running replay is over; undefined when none runs. */
	get done(): Promise<void> | undefined {
		return this.replay?.done;
	}

	/**
	 * Starts a replay; `count` resolves with how many updates it has, or
	 * undefined when that is not known. Until it does, the replay does not end
	 * on its own.
	 */
	begin(count: Promise<number | undefined>): void {
		this.end();
		let end!: () => void;
		const done = new Promise<void>(resolve => end = resolve);
		const replay: Replay = { received: 0, counting: true, done, end };
		this.replay = replay;
		void count.then(total => {
			if (this.replay !== replay) {
				return;
			}
			replay.counting = false;
			replay.remaining = total === undefined ? undefined : total - replay.received;
			if (replay.remaining !== undefined && replay.remaining <= 0) {
				this.end();
			} else {
				this.armQuiet();
			}
		});
	}

	/** One replayed update came. */
	received(): void {
		const replay = this.replay;
		if (!replay) {
			return;
		}
		replay.received++;
		if (replay.remaining !== undefined && --replay.remaining <= 0) {
			this.end();
		} else if (!replay.counting) {
			this.armQuiet();
		}
	}

	/** Ends the replay now: prompts waiting on it go. */
	end(): void {
		const replay = this.replay;
		this.replay = undefined;
		if (replay) {
			clearTimeout(replay.quiet);
			replay.end();
		}
	}

	/**
	 * Ends the replay when no update came for a while. With a known count it
	 * is a fallback for a count that is off, so it waits longer: a long
	 * history can pause between updates.
	 */
	private armQuiet(): void {
		const replay = this.replay;
		if (replay) {
			clearTimeout(replay.quiet);
			replay.quiet = setTimeout(() => this.replay === replay && this.end(), replay.remaining === undefined ? this.quietMs : this.countedQuietMs);
		}
	}
}
