/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The working strip above the composer: shown for the whole turn, with a
// clock and what the agent is doing now, then "Done in 1:12" for a moment.
// It reads the transcript the view already has, so it costs no messages.

import { currentActivity, format, formatClock, turnStart } from './chatLogic';
import { state, strings, ui } from './view';

const { activity: strip, activityLabel: label, activityClock: clock, activityDetail: detail, activityHint: hint } = ui;

/** How long "Done in …" stays before the strip goes. */
const doneFor = 4000;

let started: number | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let doneTimer: ReturnType<typeof setTimeout> | undefined;
let wasBusy = false;

hint.textContent = strings.activityStopHint;

/** Brings the strip up to date; call when the turn starts or ends and when items change. */
export function updateActivity(): void {
	if (state.busy) {
		if (!wasBusy) {
			// A view that reloads mid-turn picks up the prompt's send time, so the clock carries on.
			started = turnStart(state.items) ?? Date.now();
			clearTimeout(doneTimer);
			ticker ??= setInterval(tick, 1000);
		}
		wasBusy = true;
		showWorking();
		return;
	}
	if (wasBusy) {
		wasBusy = false;
		clearInterval(ticker);
		ticker = undefined;
		showDone(Date.now() - (started ?? Date.now()));
	}
}

/**
 * Shows what the agent is doing. It runs on every update batch, about 30
 * times a second while a reply streams, so it only writes what changed.
 */
function showWorking(): void {
	const activity = currentActivity(state.items);
	const waiting = activity.kind === 'waiting';
	setClass(`activity ${waiting ? 'waiting' : 'running'}`);
	setText(label, waiting ? strings.activityWaiting : strings.activityWorking);
	setHidden(clock, waiting);
	tick();
	const text = activity.kind === 'writing' ? strings.activityWriting : activity.detail || (activity.kind === 'thinking' ? strings.thinking : '');
	setText(detail, text);
	setHidden(detail, !text);
	setHidden(hint, waiting);
	setHidden(strip, false);
}

function setClass(name: string): void {
	if (strip.className !== name) {
		strip.className = name;
	}
}

function setText(node: HTMLElement, text: string): void {
	if (node.textContent !== text) {
		node.textContent = text;
	}
}

function setHidden(node: HTMLElement, hidden: boolean): void {
	if (node.hidden !== hidden) {
		node.hidden = hidden;
	}
}

function showDone(elapsed: number): void {
	strip.className = 'activity done';
	label.textContent = format(strings.activityDone, formatClock(elapsed));
	clock.hidden = true;
	detail.hidden = true;
	hint.hidden = true;
	strip.hidden = false;
	doneTimer = setTimeout(() => {
		strip.hidden = true;
	}, doneFor);
}

function tick(): void {
	setText(clock, formatClock(Date.now() - (started ?? Date.now())));
}
