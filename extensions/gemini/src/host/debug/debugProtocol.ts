/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What Debug mode shows in the chat (the debug bar and its cards, drawn by
// webview-src/debugCard.ts) and on the Evidence page (webview-src/evidence.ts),
// and what their buttons send back. Types only: the chat's bundle and the
// pages import them, and every word comes from the host already localised.

/** What a debug bar or card button asks for; `arg` names a point, a region or a hypothesis where one is meant. */
export type DebugAction =
	| 'start' | 'stop' | 'evidence' | 'skipToFix' | 'backToInvestigate' | 'restartProgram' | 'stopProgram' | 'removeAllPoints'
	| 'removePoint' | 'openPoint' | 'reproduced' | 'didntHappen' | 'fixed' | 'stillBroken' | 'regressionTest'
	| 'keepGoing' | 'hint' | 'removeAnyway' | 'keepRegion' | 'showDiff' | 'dismiss' | 'stopLog' | 'fold';

export interface DebugBarStrings {
	readonly debug: string;
	readonly evidence: string;
	readonly evidenceTip: string;
	readonly stop: string;
	readonly stopTip: string;
	readonly showPoints: string;
	readonly hidePoints: string;
	readonly points: string;
	readonly noPoints: string;
	readonly remove: string;
	readonly removeTip: string;
	readonly phases: string;
	readonly skipToFix: string;
	readonly backToInvestigate: string;
	readonly restartProgram: string;
	readonly stopProgram: string;
	readonly removeAllPoints: string;
	readonly logFile: string;
	readonly stopLog: string;
	readonly reproduced: string;
	readonly didntHappen: string;
	readonly fixed: string;
	readonly stillBroken: string;
	readonly regressionTest: string;
	readonly keepGoing: string;
	readonly hint: string;
	readonly removeAnyway: string;
	readonly keep: string;
	readonly showDiff: string;
	readonly dismiss: string;
	readonly before: string;
	readonly after: string;
	readonly same: string;
}

export interface DebugPointView {
	readonly id: string;
	/** `cart.ts:42`. */
	readonly where: string;
	readonly hypothesis: string;
	readonly kind: 'logpoint' | 'breakpoint' | 'marked';
	/** The kind in words: logpoint, breakpoint, marked line. */
	readonly kindLabel: string;
	/** `12 hits`, `0 hits - not bound`. */
	readonly hits: string;
}

export type DebugCardView =
	/** The steps for the user, the live count, and a hint after 20 seconds with nothing. */
	| { readonly kind: 'reproduce'; readonly title: string; readonly steps: readonly string[]; readonly status: string; readonly hint?: string; readonly canRestart: boolean }
	| { readonly kind: 'verify'; readonly title: string; readonly rows: readonly { readonly point: string; readonly where: string; readonly before: string; readonly after: string; readonly changed: boolean }[]; readonly note?: string; readonly offerTest: boolean }
	/** Several rounds confirmed nothing: Keep Going, Give a Hint, or Stop and Clean Up. */
	| { readonly kind: 'rounds'; readonly title: string; readonly text: string }
	| { readonly kind: 'cleanup'; readonly title: string; readonly lines: readonly string[]; readonly left: readonly { readonly id: string; readonly text: string; readonly diff?: string }[] };

export interface DebugBarView {
	readonly strings: DebugBarStrings;
	/** The phase line: each phase in words, the current one marked. */
	readonly phases: readonly { readonly label: string; readonly state: 'done' | 'current' | 'todo' }[];
	/** `2 hypotheses open - 4 points - 37 events`. */
	readonly summary: string;
	readonly points: readonly DebugPointView[];
	/** The picked log file and since when, while the grant lasts. */
	readonly logFile?: string;
	/** Debug mode started the program, so it can restart or stop it. */
	readonly launched: boolean;
	readonly folded: boolean;
	readonly card?: DebugCardView;
	/** Debug mode has ended: only the clean-up card shows. */
	readonly ended?: boolean;
}

/** One row of the Evidence page. */
export interface EvidenceRow {
	readonly point: string;
	readonly event: number;
	readonly run: number;
	/** `+0.012 s`. */
	readonly time: string;
	readonly where: string;
	readonly hypothesis: string;
	readonly kind: 'values' | 'snapshot' | 'output' | 'exit';
	readonly text: string;
}

export interface EvidenceStrings {
	readonly title: string;
	readonly run: string;
	readonly allRuns: string;
	readonly allHypotheses: string;
	readonly allPoints: string;
	readonly search: string;
	readonly time: string;
	readonly point: string;
	readonly where: string;
	readonly values: string;
	readonly snapshot: string;
	readonly empty: string;
	readonly more: string;
	readonly compare: string;
	readonly before: string;
	readonly after: string;
	readonly ended: string;
}

export interface EvidenceView {
	readonly title: string;
	readonly runs: readonly { readonly id: number; readonly label: string }[];
	readonly hypotheses: readonly string[];
	readonly points: readonly { readonly id: string; readonly where: string; readonly hypothesis: string }[];
	readonly rows: readonly EvidenceRow[];
	/** Rows the store has past this page. */
	readonly more: boolean;
	/** `412 events - 38 dropped (rate) - 2 values redacted`. */
	readonly totals: string;
	/** The last two runs side by side, once there are two. */
	readonly comparison?: readonly { readonly point: string; readonly where: string; readonly before: string; readonly after: string; readonly changed: boolean }[];
	/** Debug mode ended: the page shows what it had. */
	readonly ended?: boolean;
	/** The event to scroll to, such as from a hypothesis's evidence link. */
	readonly focus?: string;
}

export interface EvidenceFilter {
	readonly run?: number;
	readonly hypothesis?: string;
	readonly point?: string;
	readonly search?: string;
	/** How many rows to show: pages of 200. */
	readonly limit: number;
}

export type ToEvidence = { readonly type: 'view'; readonly view: EvidenceView };

export type FromEvidence =
	| { readonly type: 'ready' }
	| { readonly type: 'filter'; readonly filter: EvidenceFilter }
	| { readonly type: 'open'; readonly point: string };
