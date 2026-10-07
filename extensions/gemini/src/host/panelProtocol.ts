/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between the extension and its page webviews: Agents mode's Changes
// panel (webview-src/changes.ts) and Agent Home (webview-src/home.ts), and the
// Project Helpers page (webview-src/settings.ts).

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

export type ToHome =
	| { readonly type: 'view'; readonly view: HomeView }
	| { readonly type: 'focus' }
	/** The text size in pixels (`gemini.chat.fontSize`). */
	| { readonly type: 'fontSize'; readonly size: number }
	/**
	 * The agent asked for could not start (the user has been told why); put the
	 * task back in the prompt box. Sent only on failure: on success the agent's
	 * tab covers Home, whose hidden webview would not get a message anyway.
	 */
	| { readonly type: 'startFailed'; readonly text: string };

export type FromHome =
	| { readonly type: 'ready' }
	| { readonly type: 'start'; readonly folder: string; readonly text: string; readonly ownBranch: boolean }
	| { readonly type: 'addWorkspace' }
	| { readonly type: 'open' | 'stop' | 'review' | 'mergeBack'; readonly id: string };

// --- Project Helpers

export interface McpServerView {
	readonly name: string;
	/** "Personal", or the project folder's name. */
	readonly scope: string;
	readonly transport: 'stdio' | 'http' | 'sse';
	readonly target: string;
	readonly file: string;
	readonly enabled: boolean;
	/** Why it failed to start in the running agent. */
	readonly problem?: string;
}

export interface RulesFileView {
	readonly label: string;
	/** Shown as `~/...` or relative to the folder. */
	readonly display: string;
	readonly path: string;
	readonly exists: boolean;
	/** The first line of text, to recognise it by. */
	readonly preview?: string;
}

export interface SkillView {
	readonly name: string;
	readonly description: string;
	/** "Personal", or the project folder's name. */
	readonly scope: string;
	readonly file: string;
}

export interface HookView {
	readonly event: string;
	readonly matcher?: string;
	readonly command: string;
	/** What `hooksConfig.disabled` lists. */
	readonly name: string;
	readonly enabled: boolean;
	readonly scope: string;
	readonly file: string;
}

export interface ExtensionView {
	readonly name: string;
	readonly version: string;
	readonly active: boolean;
	readonly source?: string;
	/** "2 MCP servers · 3 skills", already localised; empty when it adds nothing. */
	readonly detail: string;
}

export interface MemoryFileView {
	readonly path: string;
	/** Shown as `~/...`. */
	readonly display: string;
	readonly preview?: string;
}

/** What the running Gemini CLI reports; `loading` until it answers, `unavailable` when it cannot. */
export type CliReport<T> =
	| { readonly state: 'loading' }
	| { readonly state: 'unavailable'; readonly message: string }
	| { readonly state: 'ready'; readonly items: readonly T[] };

export interface SettingsPageView {
	readonly servers: readonly McpServerView[];
	readonly skills: readonly SkillView[];
	readonly hooks: readonly HookView[];
	readonly extensions: CliReport<ExtensionView>;
	readonly memory: CliReport<MemoryFileView>;
	readonly rules: readonly RulesFileView[];
}

export interface SettingsPageStrings {
	readonly title: string;
	readonly subtitle: string;
	readonly restart: string;
	readonly servers: string;
	readonly serversHint: string;
	readonly addServer: string;
	readonly noServers: string;
	readonly edit: string;
	readonly enable: string;
	readonly failed: string;
	readonly skills: string;
	readonly skillsHint: string;
	readonly newSkill: string;
	readonly noSkills: string;
	readonly hooks: string;
	readonly hooksHint: string;
	readonly addHook: string;
	readonly noHooks: string;
	/** `{0}` is the tool names a hook applies to. */
	readonly hookMatcher: string;
	readonly enableHook: string;
	readonly extensions: string;
	readonly extensionsHint: string;
	readonly installExtension: string;
	readonly noExtensions: string;
	readonly enableExtension: string;
	readonly updateExtension: string;
	readonly uninstallExtension: string;
	readonly memory: string;
	readonly memoryHint: string;
	readonly addMemory: string;
	readonly refresh: string;
	readonly noMemory: string;
	readonly loading: string;
	readonly rules: string;
	readonly rulesHint: string;
	readonly open: string;
	readonly create: string;
	readonly missing: string;
}

export type ToSettingsPage = { readonly type: 'view'; readonly view: SettingsPageView };

export type FromSettingsPage =
	| { readonly type: 'ready' | 'restart' | 'addServer' | 'newSkill' | 'addHook' | 'installExtension' | 'addMemory' | 'refreshMemory' }
	| { readonly type: 'toggle'; readonly name: string; readonly enabled: boolean }
	| { readonly type: 'toggleHook'; readonly file: string; readonly name: string; readonly enabled: boolean }
	| { readonly type: 'extension'; readonly action: 'enable' | 'disable' | 'update' | 'uninstall'; readonly name: string }
	| { readonly type: 'openFile'; readonly path: string; readonly server?: string; readonly needle?: string }
	| { readonly type: 'createRules'; readonly path: string };
