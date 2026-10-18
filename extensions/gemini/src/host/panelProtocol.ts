/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between the extension and its page webviews: Agents mode's Changes
// panel (webview-src/changes.ts) and Agent Home (webview-src/home.ts), and the
// Project Helpers page (webview-src/settings.ts).

import type { ChangeTotals } from '../acp/agentChanges';
import type { Attachment } from '../acp/attachments';
import type { ChangesTeamView, FromChangesTeam } from './teamFlowProtocol';

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
	/** The team tools' part (src/host/mrPanel.ts), when GitLab, Snyk or SonarQube is connected. */
	readonly team?: ChangesTeamView;
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
	| { readonly type: 'keepAll' | 'undoAll' | 'openAll' | 'commit' | 'mergeBack' }
	| FromChangesTeam;

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

/** A project on Agent Home: its coordinator's chat, and how many threads it has. */
export interface HomeProject {
	readonly id: string;
	readonly title: string;
	readonly workspace: string;
	readonly state: AgentStateKind;
	/** "3 threads" */
	readonly threads: string;
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
	/** Every project, newest first; absent while Projects are off. Neither list above has projects or their threads. */
	readonly projects?: readonly HomeProject[];
	readonly ownBranch: boolean;
	/** The approval modes a new agent can start in, as policy allows. */
	readonly modes: readonly HomeMode[];
	/** The model a new agent starts on, when the user picked one. */
	readonly model?: string;
	/** The dashboard around the composer: the team tools, what needs the user, the cards. */
	readonly dashboard: HomeDashboard;
}

export type HomeToolId = 'jira' | 'gitlab' | 'sonar' | 'snyk' | 'figma';
export type HomeCardId = 'unfinished' | 'startup' | 'agents' | 'tickets' | 'mergeRequests' | 'quality' | 'gemini';

/** What a button on the dashboard does. */
export type HomeAction =
	| { readonly kind: 'command'; readonly command: string; readonly args?: readonly unknown[] }
	| { readonly kind: 'link'; readonly url: string }
	| { readonly kind: 'agent'; readonly id: string; readonly do: 'open' | 'stop' | 'review' | 'mergeBack' };

export interface HomeButton {
	readonly label: string;
	readonly action: HomeAction;
	readonly primary?: boolean;
	readonly title?: string;
}

/** A tool's connection, as a logo with a state. */
export interface HomeTool {
	readonly id: HomeToolId;
	readonly name: string;
	/** ok: connected; warn: can't reach it (VPN off); off: not connected; error: its token was refused. */
	readonly tone: 'ok' | 'warn' | 'off' | 'error' | 'checking';
	/** "Connected as pulkit.jain", "VPN off". */
	readonly label: string;
}

/** A tone for a short status word: a dot plus one coloured word. */
export type HomeTone = 'ok' | 'warn' | 'error' | 'info' | 'muted';

export interface HomeRow {
	readonly tool?: HomeToolId | 'gemini';
	/** A codicon when there is no tool logo. */
	readonly icon?: string;
	/** A monospace lead, such as ACME-415 or !322. */
	readonly key?: string;
	readonly title: string;
	readonly detail?: string;
	readonly pill?: { readonly text: string; readonly tone: HomeTone };
	/** A bar after the title, 0 to 1: the sprint's progress, today's quota. */
	readonly bar?: number;
	readonly button?: HomeButton;
	/** A link at the end of the row, such as "Usage details". */
	readonly link?: HomeButton;
	/** More actions, in the row's themed "..." menu (Log Time, Move, Open in Jira). */
	readonly menu?: readonly HomeButton[];
	/** What clicking the row's title does. */
	readonly open?: HomeAction;
	/** A small heading above this row, such as "Mine". */
	readonly group?: string;
	/** The query behind that heading, faint beside it. */
	readonly groupQuery?: string;
}

export interface HomeCard {
	readonly id: HomeCardId;
	readonly title: string;
	readonly tool?: HomeToolId | 'gemini';
	readonly icon?: string;
	/** A link at the right of the heading. */
	readonly link?: HomeButton;
	/** The query that fills the card, faint beside the title, so its numbers can be checked against the tool. */
	readonly query?: string;
	readonly rows: readonly HomeRow[];
	/** Shown when there are no rows, or under them for a state such as VPN off. */
	readonly note?: string;
	/** The last data, shown dimmed with its time, while the tool can't answer. */
	readonly stale?: boolean;
	/** For a tool that isn't connected: what the card will show, and a Connect button. */
	readonly connect?: { readonly text: string; readonly button: HomeButton };
}

export interface HomeNeed {
	readonly tool: HomeToolId | 'gemini';
	readonly title: string;
	readonly detail: string;
	readonly pill?: { readonly text: string; readonly tone: HomeTone };
	readonly button: HomeButton;
}

export interface HomeSetupStep {
	readonly title: string;
	readonly detail: string;
	readonly done: boolean;
	readonly button?: HomeButton;
}

export interface HomeDashboard {
	/** "Good morning, Pulkit" */
	readonly greeting: string;
	/** "Friday 17 October · acme-checkout · Sprint 42, 6 days left" */
	readonly context: string;
	readonly tools: readonly HomeTool[];
	readonly quickActions: readonly (HomeButton & { readonly tool?: HomeToolId; readonly icon?: string })[];
	readonly needs: readonly HomeNeed[];
	/** What Needs you is made of, faint beside its title. */
	readonly needsQuery: string;
	readonly cards: readonly HomeCard[];
	/** First run: nothing connected yet. */
	readonly setup?: readonly HomeSetupStep[];
	/** "GitLab, SonarQube and Snyk can't be reached. Turn on your VPN to refresh them." */
	readonly banner?: string;
	/** While the tools are being read again: "Showing results from 14:31 · refreshing". */
	readonly stale?: string;
	/** For Customize: every card with whether it shows, in the user's order. */
	readonly layout: readonly { readonly id: HomeCardId; readonly title: string; readonly visible: boolean }[];
	readonly releaseBranches: readonly string[];
	readonly qualityBranch?: string;
	readonly refreshing: boolean;
}

export interface HomeMode {
	readonly id: string;
	readonly name: string;
	readonly description: string;
}

export interface HomeStrings {
	readonly title: string;
	readonly writeLabel: string;
	readonly previewLabel: string;
	/** Preview's tooltip; {0} is the shortcut. */
	readonly previewMarkdown: string;
	readonly previewEmpty: string;
	readonly calloutNote: string;
	readonly calloutTip: string;
	readonly calloutImportant: string;
	readonly calloutWarning: string;
	readonly calloutCaution: string;
	readonly subtitle: string;
	readonly placeholder: string;
	readonly start: string;
	readonly ownBranch: string;
	readonly ownBranchHint: string;
	readonly workspace: string;
	readonly addFolder: string;
	readonly projectHelpers: string;
	readonly projectHelpersHint: string;
	readonly plusMenu: string;
	readonly mode: string;
	readonly files: string;
	readonly filesDetail: string;
	readonly remove: string;
	readonly active: string;
	readonly earlier: string;
	readonly projects: string;
	readonly noProjects: string;
	readonly newProject: string;
	readonly open: string;
	readonly stop: string;
	readonly review: string;
	readonly mergeBack: string;
	readonly noAgents: string;
	readonly noWorkspace: string;
	readonly customize: string;
	readonly refresh: string;
	readonly needsYou: string;
	readonly showCard: string;
	readonly moveUp: string;
	readonly moveDown: string;
	readonly cards: string;
	readonly qualityBranch: string;
	readonly getStarted: string;
	readonly composerPlaceholder: string;
	readonly moreActions: string;
	/** "From Your Tools...": a ticket or merge request to start on. */
	readonly fromTools: string;
	readonly fromToolsEmpty: string;
	readonly tickets: string;
	readonly mergeRequests: string;
}

export type ToHome =
	| { readonly type: 'view'; readonly view: HomeView }
	/** `gemini.chat.spellCheck` changed. */
	| { readonly type: 'spellCheck'; readonly on: boolean }
	| { readonly type: 'focus' }
	/**
	 * The agent asked for could not start (the user has been told why); put the
	 * task back in the prompt box. Sent only on failure: on success the agent's
	 * tab covers Home, whose hidden webview would not get a message anyway.
	 */
	| { readonly type: 'startFailed'; readonly text: string }
	/** Files the user picked to send with the task. */
	| { readonly type: 'attached'; readonly attachments: readonly Attachment[] };

export type FromHome =
	| { readonly type: 'ready' }
	| { readonly type: 'start'; readonly folder: string; readonly text: string; readonly ownBranch: boolean; readonly mode: string; readonly attachments: readonly Attachment[] }
	/** The user is typing a task, so the agent and a session for it can get ready. */
	| { readonly type: 'typing'; readonly folder: string; readonly ownBranch: boolean }
	| { readonly type: 'addFolder' | 'projectHelpers' | 'pickFiles' | 'newProject' }
	| { readonly type: 'open' | 'stop' | 'review' | 'mergeBack'; readonly id: string }
	| { readonly type: 'action'; readonly action: HomeAction }
	| { readonly type: 'refresh' }
	| { readonly type: 'layout'; readonly card: HomeCardId; readonly visible?: boolean; readonly move?: number }
	| { readonly type: 'qualityBranch'; readonly branch: string };

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

/** A Gemini CLI setting the page offers, from the user's own settings.json. */
export interface PreferencesView {
	readonly permanentApproval: boolean;
	readonly planRouting: boolean;
	readonly usageStatistics: boolean;
	/** "30d" and so on, or "forever". */
	readonly keepChats: string;
	/** The choices, in order, with their labels; includes `keepChats` when it was set by hand. */
	readonly keepChatsChoices: readonly { readonly value: string; readonly label: string }[];
	/** The settings file, shown as `~/...`. */
	readonly display: string;
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
	readonly enabled: boolean;
	/** The settings file whose `skills.disabled` switches it off. */
	readonly settingsFile: string;
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
	readonly preferences: PreferencesView;
}

export interface SettingsPageStrings {
	readonly title: string;
	readonly subtitle: string;
	readonly restart: string;
	readonly servers: string;
	readonly serversHint: string;
	readonly addServer: string;
	/** Opens the team tools' Connections page. */
	readonly connections: string;
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
	readonly enableSkill: string;
	readonly signIn: string;
	readonly preferences: string;
	/** `{0}` is the settings file. */
	readonly preferencesHint: string;
	readonly permanentApproval: string;
	readonly permanentApprovalHint: string;
	readonly planRouting: string;
	readonly planRoutingHint: string;
	readonly usageStatistics: string;
	readonly usageStatisticsHint: string;
	readonly keepChats: string;
	readonly keepChatsHint: string;
}

export type ToSettingsPage = { readonly type: 'view'; readonly view: SettingsPageView };

export type FromSettingsPage =
	| { readonly type: 'ready' | 'restart' | 'addServer' | 'connections' | 'newSkill' | 'addHook' | 'installExtension' | 'addMemory' | 'refreshMemory' }
	| { readonly type: 'toggle'; readonly name: string; readonly enabled: boolean }
	| { readonly type: 'toggleHook'; readonly file: string; readonly name: string; readonly enabled: boolean }
	| { readonly type: 'toggleSkill'; readonly file: string; readonly name: string; readonly enabled: boolean }
	/** Sign in to a remote MCP server, through the CLI's /mcp auth in a terminal. */
	| { readonly type: 'signIn'; readonly name: string }
	| { readonly type: 'setPreference'; readonly key: 'permanentApproval' | 'planRouting' | 'usageStatistics'; readonly value: boolean }
	| { readonly type: 'setPreference'; readonly key: 'keepChats'; readonly value: string }
	| { readonly type: 'extension'; readonly action: 'enable' | 'disable' | 'update' | 'uninstall'; readonly name: string }
	| { readonly type: 'openFile'; readonly path: string; readonly server?: string; readonly needle?: string }
	| { readonly type: 'createRules'; readonly path: string };
