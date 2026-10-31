/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between the extension and its page webviews: Agents mode's Changes
// panel (webview-src/changes.ts) and Agent Home (webview-src/home.ts), and the
// Project Helpers page (webview-src/settings.ts).

import type { ChangeTotals } from '../acp/agentChanges';
import type { Attachment } from '../acp/attachments';
import type { JiraCommentVisibility } from '../acp/jira';
import type { AdfDocument } from '../acp/jiraAdf';
import type { SettingControl, SettingTarget } from '../acp/settingsModel';
import type { ChangesTeamView, FromChangesTeam } from './teamFlowProtocol';

/** Where an agent is at, for the title bar, Agent Home and the Changes panel. */
export type AgentStateKind = 'working' | 'waiting' | 'done' | 'error' | 'idle' | 'stopped' | 'kept';

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

/** What the Try button does with the work of an agent on its own branch (`agents/tryChoices.ts`). */
export type TryChoice = 'try' | 'merge' | 'mr';

export interface ChangesPanelView {
	readonly agent?: {
		readonly title: string;
		readonly busy: boolean;
		/** Its own branch, when it has one: Merge Back instead of Commit. */
		readonly branch?: string;
		readonly canCommit: boolean;
		/** Its work is being tried in the user's checkout: Keep Changes and Take Back instead of Merge Back. */
		readonly trying?: boolean;
		/** What the Try button does, when not Try in Workspace. */
		readonly tryChoice?: 'merge' | 'mr';
		/** GitLab is connected: the chevron's menu offers Open Merge Request. */
		readonly mergeRequests?: boolean;
	};
	readonly totals: ChangeTotals;
	readonly files: readonly ChangedFileView[];
	/** The team tools' part (src/host/mrPanel.ts), when GitLab, Snyk or SonarQube is connected. */
	readonly team?: ChangesTeamView;
}

export type ToChangesPanel = { readonly type: 'view'; readonly view: ChangesPanelView };

export type FromChangesPanel =
	| { readonly type: 'ready' }
	| { readonly type: 'keep' | 'undo'; readonly path: string; readonly index: number }
	| { readonly type: 'keepFile' | 'undoFile' | 'openFile'; readonly path: string }
	| { readonly type: 'keepAll' | 'undoAll' | 'openAll' | 'commit' | 'mergeBack' | 'keepTried' | 'takeBack' }
	/** A pick from the Try button's chevron menu. */
	| { readonly type: 'tryChoice'; readonly choice: TryChoice }
	| FromChangesTeam;

// --- Agent Home

/** A project on Agent Home: its coordinator's chat, and how many threads it has. */
export interface HomeProject {
	readonly id: string;
	readonly title: string;
	readonly workspace: string;
	/** The repository folder the project works in, one of the view's workspaces. */
	readonly folder: string;
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
	/** Whether agents here run trusted by the Gemini CLI, by the folder's own entry or a parent's; unset while folder trust is off. */
	readonly trust?: 'trusted' | 'parent' | 'untrusted';
}

export interface HomeView {
	readonly workspaces: readonly HomeWorkspace[];
	/** Every project, newest first, for On a branch's chevron; absent while Projects are off. */
	readonly projects?: readonly HomeProject[];
	/** Whether new agents start on their own branch by default (`gemini.agents.ownBranch`). */
	readonly ownBranch: boolean;
	/** The approval modes a new agent can start in, as policy allows. */
	readonly modes: readonly HomeMode[];
	/** The mode picked until the user picks one: `gemini.agents.defaultMode`. */
	readonly defaultMode?: string;
	/** The model a new agent starts on, when the user picked one. */
	readonly model?: string;
	/** The dashboard around the composer: the banners, Get started and the cards. */
	readonly dashboard: HomeDashboard;
}

export type HomeToolId = 'jira' | 'confluence' | 'gitlab' | 'sonar' | 'snyk' | 'figma';
export type HomeCardId = 'unfinished' | 'startup' | 'agents' | 'tickets' | 'mergeRequests' | 'quality' | 'gemini';

/** What a button on the dashboard does. */
export type HomeAction =
	| { readonly kind: 'command'; readonly command: string; readonly args?: readonly unknown[] }
	| { readonly kind: 'link'; readonly url: string }
	| { readonly kind: 'agent'; readonly id: string; readonly do: 'open' | 'stop' | 'review' | 'mergeBack' }
	/** Opens Home's comment box for Jira ticket `key`; `visibility` is the project role the team's comments are limited to. */
	| { readonly kind: 'comment'; readonly key: string; readonly title: string; readonly visibility?: string; /** The ticket's link, which says its Jira site when several are connected. */ readonly url?: string }
	/** Checks `tool`'s server again now, as a banner's Retry does, and reads its data. */
	| { readonly kind: 'retry'; readonly tool: HomeToolId };

export interface HomeButton {
	readonly label: string;
	readonly action: HomeAction;
	readonly primary?: boolean;
	readonly title?: string;
}

/** A tone for a short status word: a dot plus one coloured word. */
export type HomeTone = 'ok' | 'warn' | 'error' | 'info' | 'muted';

/** A ticket type's colour, after Jira's own: green stories, red bugs, blue tasks, purple epics. */
export type HomeTypeColor = 'green' | 'red' | 'blue' | 'purple' | 'orange' | 'muted';

export interface HomeRow {
	readonly tool?: HomeToolId | 'gemini';
	/** A codicon when there is no tool logo. */
	readonly icon?: string;
	/** The ticket's type before its key (Story, Bug, Task), as a codicon in the type's colour, named in its tooltip. */
	readonly type?: { readonly name: string; readonly icon: string; readonly color: HomeTypeColor };
	/** A monospace lead, such as ACME-415 or !322. */
	readonly key?: string;
	/** The merge request's repository, `group/repo`: its last part shows after the key in Show All's popup. */
	readonly repo?: string;
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
	/** What is behind that heading (the sprint's progress, a site's state), in the heading's tooltip. */
	readonly groupQuery?: string;
	/** The heading's tone: warn for a Jira site that can't be reached now. */
	readonly groupTone?: HomeTone;
	/** Dimmed: the last answer of a server that can't be reached now. */
	readonly dim?: boolean;
}

export interface HomeCard {
	readonly id: HomeCardId;
	readonly title: string;
	readonly tool?: HomeToolId | 'gemini';
	readonly icon?: string;
	/** A link at the right of the heading. */
	readonly link?: HomeButton;
	/** The query that fills the card, in the title's tooltip, so its numbers can be checked against the tool. */
	readonly query?: string;
	readonly rows: readonly HomeRow[];
	/** How many rows the card's whole list has, when that is more than it shows: Show All opens them in a popup. */
	readonly total?: number;
	/** Shown when there are no rows, or under them for a state such as VPN off. */
	readonly note?: string;
	/** The last data, shown dimmed with its time, while the tool can't answer. */
	readonly stale?: boolean;
	/** When a stale card's data came, as "10:42", beside its title. */
	readonly asOf?: string;
	/** For a tool that isn't connected: what the card will show, and a Connect button. */
	readonly connect?: { readonly text: string; readonly button: HomeButton };
}

/** A card's whole list, in the popup Show All opens. */
export interface HomeList {
	readonly card: HomeCardId;
	readonly title: string;
	readonly tool?: HomeToolId | 'gemini';
	readonly icon?: string;
	readonly query?: string;
	readonly rows: readonly HomeRow[];
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
	/** Review and Run checks..., under Actions in the composer's + menu. */
	readonly quickActions: readonly (HomeButton & { readonly tool?: HomeToolId; readonly icon?: string })[];
	readonly cards: readonly HomeCard[];
	/** First run: nothing connected yet. */
	readonly setup?: readonly HomeSetupStep[];
	/** One per team server that can't be reached or refused the token; each clears by itself once the server answers. */
	readonly banners?: readonly HomeBanner[];
	/** While the tools are being read again: "Showing results from 14:31 · refreshing". */
	readonly stale?: string;
	/** For Customize: every card with whether it shows, in the user's order. */
	readonly layout: readonly { readonly id: HomeCardId; readonly title: string; readonly visible: boolean }[];
	readonly releaseBranches: readonly string[];
	readonly qualityBranch?: string;
	readonly refreshing: boolean;
	/** The card whose whole list is open in a popup, kept current while it is open. */
	readonly list?: HomeList;
}

/** "GitLab is unreachable, probably the VPN. Showing results from 10:42." with Retry; "Jira rejected your token." with Replace Token. */
export interface HomeBanner {
	readonly tool: HomeToolId;
	/** warn: unreachable; error: the token was refused. */
	readonly tone: 'warn' | 'error';
	readonly text: string;
	readonly button: HomeButton;
}

export interface HomeMode {
	readonly id: string;
	readonly name: string;
	readonly description: string;
}

export type ToHome =
	| { readonly type: 'view'; readonly view: HomeView }
	| { readonly type: 'focus' }
	/**
	 * The agent asked for could not start (the user has been told why); put the
	 * task back in the prompt box. Sent only on failure: on success the agent's
	 * tab covers Home, whose hidden webview would not get a message anyway.
	 */
	| { readonly type: 'startFailed'; readonly text: string }
	/** Open Folder... added `folder` for agents: the composer picks it. */
	| { readonly type: 'folderAdded'; readonly folder: string }
	/** Files the user picked to send with the task. */
	| { readonly type: 'attached'; readonly attachments: readonly Attachment[] }
	/** The comment on `key` was posted, or why it wasn't, for the comment box. */
	| { readonly type: 'commented'; readonly key: string; readonly error?: string }
	| { readonly type: 'commentPeople'; readonly id: number; readonly people: readonly { readonly accountId: string; readonly name: string; readonly email?: string }[]; readonly error?: string }
	| { readonly type: 'commentOptions'; readonly key: string; readonly roles: readonly string[]; readonly groups: readonly string[] }
	| { readonly type: 'commentFiles'; readonly files: readonly HomeCommentFile[] };

export type FromHome =
	| { readonly type: 'ready' }
	/**
	 * Start an agent on `text`: in `folder`, or on its own branch; or send it to
	 * a project's coordinator (`project`: its id, or 'new' to start a project).
	 */
	| { readonly type: 'start'; readonly folder: string; readonly text: string; readonly ownBranch: boolean; readonly project?: string; readonly mode: string; readonly attachments: readonly Attachment[] }
	/** The user picked `folder` for agents, so its first-use trust question can be asked; `trust` is Trust... (always asks). */
	| { readonly type: 'folderPicked' | 'trust'; readonly folder: string }
	/** The user is typing a task, so the agent and a session for it can get ready. */
	| { readonly type: 'typing'; readonly folder: string; readonly ownBranch: boolean }
	| { readonly type: 'addFolder' | 'pickFiles' }
	/** An Agents card row's title or Review button (a `HomeAction` of kind 'agent'). */
	| { readonly type: 'open' | 'stop' | 'review' | 'mergeBack'; readonly id: string }
	| { readonly type: 'action'; readonly action: HomeAction }
	| { readonly type: 'refresh' }
	| { readonly type: 'layout'; readonly card: HomeCardId; readonly visible?: boolean; readonly move?: number }
	| { readonly type: 'qualityBranch'; readonly branch: string }
	/** Show All opened a card's list in its popup; no card when the popup closed. */
	| { readonly type: 'showList'; readonly card?: HomeCardId }
	/**
	 * Post a comment on Jira ticket `key` from Home's comment box: `document`,
	 * the `markdown` as Jira rich text with the people picked with @, the
	 * `files` (paths) and `pasted` files (base64) attached, and who may see it
	 * (unset: the team's default).
	 */
	| { readonly type: 'comment'; readonly key: string; readonly url?: string; readonly markdown: string; readonly document: AdfDocument; readonly files: readonly string[]; readonly pasted: readonly HomePastedFile[]; readonly visibility?: JiraCommentVisibility | 'everyone' }
	/** People who can see `key` matching `query`, for @ in the comment box; `id` pairs the answer with the question. */
	| { readonly type: 'commentPeople'; readonly key: string; readonly url?: string; readonly query: string; readonly id: number }
	/** The roles and groups a comment on `key` can be limited to. */
	| { readonly type: 'commentOptions'; readonly key: string; readonly url?: string }
	/** Files for the comment box: the dropped `uris`, or a file picker without them. */
	| { readonly type: 'commentFiles'; readonly uris?: readonly string[] };

/** A file pasted or dropped into the comment box without a path, sent with its contents. */
export interface HomePastedFile {
	readonly name: string;
	/** Base64. */
	readonly data: string;
}

/** A file on disk to attach to a comment. */
export interface HomeCommentFile {
	readonly path: string;
	readonly name: string;
	readonly size: number;
}

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
	/** `general.defaultApprovalMode`, and its choices with the CLI's names. */
	readonly defaultApprovalMode: string;
	readonly defaultApprovalModeChoices: readonly { readonly value: string; readonly label: string }[];
	/** The name of the mode `gemini.agents.defaultMode` sets, when it is set: it wins over the CLI's. */
	readonly ownDefaultMode?: string;
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
	/** Its size in characters, with the files it imports. */
	readonly characters?: number;
}

/** What every model call carries before the prompt (contextCost.ts), for the page's Context cost section. */
export interface ContextCostView {
	readonly state: 'none' | 'measuring' | 'ready' | 'failed';
	/** The folder measured, by name, and its path. */
	readonly folder: string;
	readonly folderPath: string;
	/** The window's folders to pick from, in a multi-root window: each folder's agents get its own context. */
	readonly folders?: readonly { readonly path: string; readonly name: string }[];
	/** What every model call carries: the last reading. */
	readonly total?: number;
	/** One row per test prompt, with its input tokens as the CLI reported them. */
	readonly readings: readonly { readonly label: string; readonly tokens: number }[];
	/** "2 hours ago, with gemini-3.1-flash-lite". */
	readonly measured?: string;
	/** What accounts for much of the total, in words. */
	readonly tips: readonly string[];
	/** How many test prompts measuring runs, from the user's Gemini quota. */
	readonly note: string;
	readonly error?: string;
}

/** What the running Gemini CLI reports; `loading` until it answers, `unavailable` when it cannot. */
export type CliReport<T> =
	| { readonly state: 'loading' }
	| { readonly state: 'unavailable'; readonly message: string }
	| { readonly state: 'ready'; readonly items: readonly T[] };

/** One row of the Storage section: an area, what it holds and its size. */
export interface StorageRowView {
	readonly id: 'worktrees' | 'index' | 'cli' | 'checkpoints' | 'chats' | 'logs';
	readonly label: string;
	readonly detail: string;
	/** "2.3 GB"; empty until measured. */
	readonly size: string;
	readonly action?: { readonly kind: 'showIndex' | 'openFolder'; readonly label: string };
}

/** The Storage section: measured the first time it scrolls into view, never at startup. */
/** The Storage section's messages (webview-src/settingsStorage.ts), on the Storage & Audit tab. */
export type StorageMessage =
	| { readonly type: 'measureStorage' | 'cleanUp' }
	| { readonly type: 'storageAction'; readonly action: 'showIndex' | 'openFolder' }
	| { readonly type: 'setKeepLogs'; readonly days: string };

/** The Storage section's words. */
export interface StorageStrings {
	readonly storage: string;
	readonly storageHint: string;
	readonly storageMeasuring: string;
	readonly keepLogs: string;
}

export interface StorageView {
	readonly state: 'waiting' | 'measuring' | 'ready';
	readonly rows: readonly StorageRowView[];
	/** Clean Up's button when it has something to remove, such as "Clean Up 4..."; it lists everything and asks first. */
	readonly cleanup?: string;
	/** `gemini.audit.keepDays`, as the logs row's menu shows it. */
	readonly keepLogs: { readonly value: string; readonly choices: readonly { readonly value: string; readonly label: string }[] };
	readonly error?: string;
}

/** One row of Trusted Folders: a rule of the Gemini CLI's trust file, in plain words. */
export interface TrustRowView {
	/** The folder, with ~ for the home folder. */
	readonly folder: string;
	/** "Trusted", "Never trust". */
	readonly status: string;
	readonly tone: 'ok' | 'warn' | 'muted';
	readonly detail?: string;
	/** The rule's key, which Remove deletes; unset for GeminiCode's own rules. */
	readonly rule?: string;
}

/** Trusted Folders: the trust file's rules, or one line when folder trust is off or the file isn't JSON. */
export type TrustView =
	| { readonly state: 'ready'; readonly rows: readonly TrustRowView[] }
	| { readonly state: 'off' | 'unreadable'; readonly message: string };

/** One `gemini.*` setting on the page, from the extension's contribution (src/acp/settingsModel.ts) with its value in effect. */
export interface SettingRowView {
	readonly key: string;
	readonly label: string;
	/** The description, with `code` marks and `#gemini.key#` references; `%key%` strings already resolved. */
	readonly help: string;
	readonly control: SettingControl;
	/** What `get` returns: a policy's value when one applies, else the settings files'. */
	readonly value: unknown;
	readonly default: unknown;
	readonly choices?: readonly { readonly value: unknown; readonly label: string; readonly help?: string }[];
	readonly minimum?: number;
	readonly maximum?: number;
	/** Where a change goes: the user's settings, or the workspace's for a resource-scoped setting while a folder is open. */
	readonly target: SettingTarget;
	/** The value differs from the default, so Reset shows. */
	readonly modified: boolean;
	readonly advanced: boolean;
	readonly deprecated?: string;
}

/** A contributed section of settings, in package.json's order, with its anchor id and its resolved title. */
export interface SettingSectionView {
	readonly id: string;
	readonly title: string;
	readonly settings: readonly SettingRowView[];
}

export interface SettingsPageView {
	/** Every contributed section with every setting, advanced and deprecated ones included; the page hides those until searched for. */
	readonly settings: readonly SettingSectionView[];
	readonly servers: readonly McpServerView[];
	readonly skills: readonly SkillView[];
	readonly hooks: readonly HookView[];
	readonly extensions: CliReport<ExtensionView>;
	readonly memory: CliReport<MemoryFileView>;
	readonly rules: readonly RulesFileView[];
	readonly preferences: PreferencesView;
	readonly contextCost: ContextCostView;
	/** `gemini.developer.showTools`: the Measure buttons show. */
	readonly developer: boolean;
	readonly trust: TrustView;
}

export type ToSettingsPage = { readonly type: 'view'; readonly view: SettingsPageView };

export type FromSettingsPage =
	| { readonly type: 'ready' | 'restart' | 'addServer' | 'connections' | 'newSkill' | 'addHook' | 'installExtension' | 'addMemory' | 'refreshMemory' | 'measureContext' }
	/** The folder Context per model call shows, by path. */
	| { readonly type: 'contextFolder'; readonly folder: string }
	| { readonly type: 'toggle'; readonly name: string; readonly enabled: boolean }
	| { readonly type: 'toggleHook'; readonly file: string; readonly name: string; readonly enabled: boolean }
	| { readonly type: 'toggleSkill'; readonly file: string; readonly name: string; readonly enabled: boolean }
	/** Sign in to a remote MCP server, through the CLI's /mcp auth in a terminal. */
	| { readonly type: 'signIn'; readonly name: string }
	| { readonly type: 'setPreference'; readonly key: 'permanentApproval' | 'planRouting' | 'usageStatistics'; readonly value: boolean }
	| { readonly type: 'setPreference'; readonly key: 'keepChats' | 'defaultApprovalMode'; readonly value: string }
	| { readonly type: 'extension'; readonly action: 'enable' | 'disable' | 'update' | 'uninstall'; readonly name: string }
	| { readonly type: 'openFile'; readonly path: string; readonly server?: string; readonly needle?: string }
	| { readonly type: 'createRules'; readonly path: string }
	/** Trust Folder..., Trust a Parent Folder... and Never Trust a Folder..., which ask for the folder. */
	| { readonly type: 'trustFolder'; readonly kind: 'folder' | 'parent' | 'never' }
	| { readonly type: 'removeTrust'; readonly rule: string }
	/** A `gemini.*` setting's new value from its control; the host checks it against the contribution and writes it where `SettingRowView.target` says. */
	| { readonly type: 'setSetting'; readonly key: string; readonly value: unknown }
	/** Clears a setting in the user's and the workspace's settings, so the default applies again. */
	| { readonly type: 'resetSetting'; readonly key: string }
	/** One of the other Agent Setup pages, from the side index; the page shell answers it (PagePanel's `openTab`). */
	| { readonly type: 'openTab'; readonly tab: string };
