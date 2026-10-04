/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between the extension and Agents mode's two webviews: the Changes
// panel (webview-src/changes.ts) and Agent Home (webview-src/home.ts).

import type { ChangeTotals } from '../acp/agentChanges';

/** Where an agent is at, for the title bar, Agent Home and the Changes panel. */
export type AgentStateKind = 'working' | 'waiting' | 'done' | 'error' | 'idle' | 'stopped';

// --- Changes panel

export interface DiffLine {
	readonly kind: 'add' | 'del' | 'ctx';
	readonly text: string;
}

export interface HunkView {
	/** The change's index in the file, as Keep and Undo take it. */
	readonly index: number;
	readonly lines: readonly DiffLine[];
	/** Lines left out of a long change. */
	readonly hidden: number;
}

export interface ChangedFileView {
	readonly path: string;
	readonly name: string;
	/** The folder, relative to the agent's. */
	readonly dir: string;
	readonly created: boolean;
	readonly added: number;
	readonly removed: number;
	/** Unset when the file's text before the agent is unknown (too large to keep). */
	readonly hunks?: readonly HunkView[];
}

export interface ChangesPanelView {
	readonly agent?: {
		readonly title: string;
		readonly busy: boolean;
		/** Its own branch, when it has one: Merge Back instead of Commit. */
		readonly branch?: string;
		readonly canCommit: boolean;
	};
	readonly totals: ChangeTotals;
	readonly files: readonly ChangedFileView[];
}

export interface ChangesPanelStrings {
	readonly empty: string;
	readonly noAgent: string;
	readonly keep: string;
	readonly undo: string;
	readonly keepAll: string;
	readonly undoAll: string;
	readonly keepFile: string;
	readonly undoFile: string;
	readonly openFile: string;
	readonly openAll: string;
	readonly commit: string;
	readonly mergeBack: string;
	readonly newFile: string;
	readonly hiddenLines: string;
	readonly noDiff: string;
	readonly working: string;
	readonly oneFile: string;
	readonly files: string;
}

export type ToChangesPanel = { readonly type: 'view'; readonly view: ChangesPanelView };

export type FromChangesPanel =
	| { readonly type: 'ready' }
	| { readonly type: 'keep' | 'undo'; readonly path: string; readonly index: number }
	| { readonly type: 'keepFile' | 'undoFile' | 'openFile'; readonly path: string }
	| { readonly type: 'keepAll' | 'undoAll' | 'openAll' | 'commit' | 'mergeBack' };

// --- Agent Home

export interface HomeAgent {
	readonly id: string;
	readonly title: string;
	readonly workspace: string;
	readonly state: AgentStateKind;
	readonly status: string;
	/** "+12 -3 in 2 files" */
	readonly changes?: string;
	readonly branch?: string;
	/** "5m" */
	readonly updated: string;
}

export interface HomeWorkspace {
	readonly folder: string;
	readonly name: string;
	readonly description: string;
	readonly git: boolean;
}

export interface HomeView {
	readonly workspaces: readonly HomeWorkspace[];
	/** Agents working, waiting, done or with changes to review. */
	readonly active: readonly HomeAgent[];
	/** The rest, newest first, to resume. */
	readonly earlier: readonly HomeAgent[];
	readonly ownBranch: boolean;
}

export interface HomeStrings {
	readonly title: string;
	readonly subtitle: string;
	readonly placeholder: string;
	readonly start: string;
	readonly ownBranch: string;
	readonly ownBranchHint: string;
	readonly workspace: string;
	readonly addWorkspace: string;
	readonly active: string;
	readonly earlier: string;
	readonly open: string;
	readonly stop: string;
	readonly review: string;
	readonly mergeBack: string;
	readonly noAgents: string;
	readonly noWorkspace: string;
}

export type ToHome = { readonly type: 'view'; readonly view: HomeView } | { readonly type: 'focus' };

export type FromHome =
	| { readonly type: 'ready' }
	| { readonly type: 'start'; readonly folder: string; readonly text: string; readonly ownBranch: boolean }
	| { readonly type: 'addWorkspace' }
	| { readonly type: 'open' | 'stop' | 'review' | 'mergeBack'; readonly id: string };
