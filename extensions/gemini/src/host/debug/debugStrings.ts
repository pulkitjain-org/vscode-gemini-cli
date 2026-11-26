/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Debug mode's words for the user, in dist/debug.js with the code they serve:
// the debug bar's and cards' (sent to the chat with each view), the Evidence
// page's, and the phases' names.

import * as vscode from 'vscode';
import type { DebugPhase } from '../../acp/debug/debugState';
import type { PointKind } from '../../acp/debug/points';
import type { DebugBarStrings, EvidenceStrings } from './debugProtocol';

let bar: DebugBarStrings | undefined;

export function barStrings(): DebugBarStrings {
	return bar ??= {
		debug: vscode.l10n.t("Debug"),
		evidence: vscode.l10n.t("Evidence"),
		evidenceTip: vscode.l10n.t("Open the Evidence page: every event by point, and the runs side by side"),
		stop: vscode.l10n.t("Stop"),
		stopTip: vscode.l10n.t("Stop Debug mode: remove every point and marked line, and end what it started"),
		showPoints: vscode.l10n.t("Show points"),
		hidePoints: vscode.l10n.t("Hide points"),
		points: vscode.l10n.t("Points"),
		noPoints: vscode.l10n.t("No points yet."),
		remove: vscode.l10n.t("Remove"),
		removeTip: vscode.l10n.t("Remove this point"),
		phases: vscode.l10n.t("Debug mode's phases"),
		skipToFix: vscode.l10n.t("Skip to fix"),
		backToInvestigate: vscode.l10n.t("Back to investigate"),
		restartProgram: vscode.l10n.t("Restart program"),
		stopProgram: vscode.l10n.t("Stop program"),
		removeAllPoints: vscode.l10n.t("Remove all points"),
		logFile: vscode.l10n.t("Log file"),
		stopLog: vscode.l10n.t("Stop reading"),
		reproduced: vscode.l10n.t("Reproduced"),
		didntHappen: vscode.l10n.t("Didn't happen"),
		fixed: vscode.l10n.t("Fixed"),
		stillBroken: vscode.l10n.t("Still broken"),
		regressionTest: vscode.l10n.t("Add a regression test"),
		keepGoing: vscode.l10n.t("Keep going"),
		hint: vscode.l10n.t("Give a hint"),
		removeAnyway: vscode.l10n.t("Remove anyway"),
		keep: vscode.l10n.t("Keep"),
		showDiff: vscode.l10n.t("Show diff"),
		dismiss: vscode.l10n.t("Dismiss"),
		before: vscode.l10n.t("Before"),
		after: vscode.l10n.t("After"),
		same: vscode.l10n.t("same"),
	};
}

export function evidenceStrings(): EvidenceStrings {
	return {
		title: vscode.l10n.t("Evidence"),
		run: vscode.l10n.t("Run"),
		allRuns: vscode.l10n.t("All runs"),
		allHypotheses: vscode.l10n.t("All hypotheses"),
		allPoints: vscode.l10n.t("All points"),
		search: vscode.l10n.t("Search values"),
		time: vscode.l10n.t("Time"),
		point: vscode.l10n.t("Point"),
		where: vscode.l10n.t("Where"),
		values: vscode.l10n.t("Values"),
		snapshot: vscode.l10n.t("Snapshot"),
		empty: vscode.l10n.t("No evidence yet: it arrives as the program runs past the points."),
		more: vscode.l10n.t("Show more"),
		compare: vscode.l10n.t("Before and after"),
		before: vscode.l10n.t("Before"),
		after: vscode.l10n.t("After"),
		ended: vscode.l10n.t("Debug mode has ended; this is what it had."),
	};
}

export function phaseLabel(phase: DebugPhase): string {
	switch (phase) {
		case 'investigate': return vscode.l10n.t("Investigate");
		case 'instrument': return vscode.l10n.t("Instrument");
		case 'reproduce': return vscode.l10n.t("Reproduce");
		case 'analyse': return vscode.l10n.t("Analyse");
		case 'fix': return vscode.l10n.t("Fix");
		case 'verify': return vscode.l10n.t("Verify");
		case 'cleanup': return vscode.l10n.t("Clean up");
	}
}

export function kindLabel(kind: PointKind): string {
	switch (kind) {
		case 'logpoint': return vscode.l10n.t("logpoint");
		case 'breakpoint': return vscode.l10n.t("breakpoint");
		case 'marked': return vscode.l10n.t("marked line");
	}
}

export function hitsLabel(hits: number): string {
	return hits === 1 ? vscode.l10n.t("1 hit") : vscode.l10n.t("{0} hits", hits);
}
