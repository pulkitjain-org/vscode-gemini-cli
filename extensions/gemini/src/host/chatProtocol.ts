/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between an agent's chat (chatController.ts) and its webview
// (webview-src/chat.ts). Types only, so the webview bundle can import them.

import type { Attachment } from '../acp/attachments';
import type { ModelQuota } from '../acp/directRequest';
import type { TranscriptItem } from '../acp/chatTranscript';
import type { ItemUpdate } from '../acp/textDeltas';
import type { SessionSettings } from '../acp/sessionSettings';
import type { SlashCommand } from '../acp/slashCommands';
import type { AgentPhase } from '../acp/status';
import type { TokenColors } from '../acp/tokenColors';

/**
 * Bumped when the messages change, so the host can tell when the webview
 * bundle in media/ is older than the extension (a stale development build).
 */
export const chatProtocolVersion = 28;

/** Commands the status line may offer; the host runs only these. */
export const statusCommands = ['gemini.restartAgent', 'gemini.completeSetupInTerminal', 'gemini.setProjectId', 'gemini.showLog'] as const;
export type StatusCommand = typeof statusCommands[number];

export interface ViewStatus {
	readonly phase: AgentPhase;
	/** Shown above the composer when not empty. */
	readonly text: string;
	/** Buttons shown with the text, such as Start or Sign In. */
	readonly actions?: readonly { readonly label: string; readonly command: StatusCommand }[];
}

/** What a project chat's thread card buttons do. */
/** Project settings' buttons that need the extension: pick a repository folder, add or make a context file, open one, draft the Memory text, or clean up merged threads' folders. */
export type ProjectSettingsAction = 'pickRepository' | 'addFiles' | 'newFile' | 'openFile' | 'draft' | 'cleanUp';

export type ThreadAction = 'open' | 'stop' | 'merge' | 'review' | 'undo' | 'approve' | 'retry';

/** A thread the user starts from the project chat's New thread dialog. */
export interface NewThread {
	readonly title: string;
	readonly brief: string;
	/** The branch to create; a free name is picked from the title when empty or taken. */
	readonly branch?: string;
	/** The model the thread starts on; unset for the one new agents get. */
	readonly model?: string;
	readonly planFirst: boolean;
	/** In a project with several repositories, the ones the thread works in. */
	readonly repos?: readonly string[];
}

/** A project's defaults for new threads, as Project settings shows them. */
export interface ProjectDefaultsView {
	readonly threadModel?: string;
	readonly planFirst: boolean;
	readonly branchPrefix: string;
}

/** One of a project's repositories in Project settings. */
export interface ProjectRepoView {
	readonly key: string;
	/** Its top folder, which Save sends back. */
	readonly folder: string;
	/** The folder for display, with ~ for the home folder. */
	readonly label: string;
}

/** The Project settings popup's contents. */
export interface ProjectSettingsView {
	readonly name: string;
	readonly repos: readonly ProjectRepoView[];
	readonly defaults: ProjectDefaultsView;
	/** The Memory text. */
	readonly instructions: string;
	readonly maxChars: number;
	/** When Gemini drafted the Memory text, until the user saves their own. */
	readonly draftedAt?: number;
	/** Gemini is drafting the Memory text now. */
	readonly drafting?: boolean;
	/** Why the last draft failed. */
	readonly draftError?: string;
	/** Context files, with each one's length for the token estimate. */
	readonly files: readonly { readonly name: string; readonly coordinator: boolean; readonly threads: boolean; readonly chars?: number }[];
	/** The memory folder for display. */
	readonly memoryFolder: string;
	/** Each repository's own rules files, which every agent reads as well. */
	readonly repoRules: readonly { readonly key: string; readonly files: readonly string[] }[];
	readonly stats: { readonly open: number; readonly merged: number; readonly added: number; readonly removed: number };
}

/** What Save in Project settings sends. */
export interface ProjectSettingsSave {
	readonly name: string;
	readonly repos: readonly { readonly key: string; readonly folder: string }[];
	readonly defaults: ProjectDefaultsView;
	readonly instructions: string;
	readonly files: readonly { readonly name: string; readonly coordinator: boolean; readonly threads: boolean }[];
	/** Context files to delete. */
	readonly removedFiles: readonly string[];
	/** The Memory tab was shown, so a draft of Gemini's counts as reviewed once saved. */
	readonly reviewedDraft?: boolean;
}

/** The project chat's side panel: what the threads are doing and what the coordinator reads. */
export interface ProjectPanel {
	/** The project's name, which the New thread dialog's title shows. */
	readonly name: string;
	/** How many threads are in each state; merged and undone threads are left out. */
	readonly counts: { readonly working: number; readonly waiting: number; readonly planned: number; readonly done: number; readonly merged: number };
	/** The repo's Conductor files, when it has a `conductor/` folder. */
	readonly conductor?: { readonly openTracks: number };
	/** The model the coordinator runs on, when known. */
	readonly model?: string;
	/** Every thread, oldest first, each opening its own chat. */
	readonly threads: readonly { readonly id: string; readonly title: string; readonly state: 'working' | 'waiting' | 'planned' | 'done' | 'merged' }[];
	/** The project's repositories by key, when it has more than one; the New thread dialog offers them. */
	readonly repos?: readonly string[];
	/** What the New thread dialog starts with. */
	readonly defaults?: ProjectDefaultsView;
}

/** A project thread's way back to its project chat. */
export interface ParentProject {
	/** "Thread in vca-qa-automation" */
	readonly label: string;
	/** "Open project chat" */
	readonly action: string;
}

/** The strings only a project's chat shows (Projects preview). */
export interface ProjectChatStrings {
	readonly placeholder: string;
	/** The "+" menu's item to start a thread directly. */
	readonly newThread: string;
	/** The New thread dialog; `{0}` in its title is the project's name. */
	readonly dialog: {
		readonly title: string;
		readonly titleLabel: string;
		readonly briefLabel: string;
		readonly briefPlaceholder: string;
		readonly branchLabel: string;
		readonly modelLabel: string;
		readonly defaultModel: string;
		readonly worktreeHint: string;
		readonly planFirst: string;
		readonly planFirstHint: string;
		readonly startsAtOnce: string;
		readonly cancel: string;
		readonly start: string;
		readonly close: string;
		/** A project with several repositories: the repository checkboxes. */
		readonly reposLabel: string;
		readonly reposHint: string;
		readonly branchLabelShared: string;
	};
	/** Project settings; `{0}` is a name, count or date. */
	readonly settings: {
		readonly open: string;
		readonly title: string;
		readonly general: string;
		readonly memory: string;
		readonly nameLabel: string;
		readonly nameHint: string;
		readonly reposLabel: string;
		readonly reposHint: string;
		readonly addRepo: string;
		readonly removeRepo: string;
		readonly mainRepo: string;
		readonly defaultsLabel: string;
		readonly threadModel: string;
		readonly planFirst: string;
		readonly planFirstHint: string;
		readonly branchPrefix: string;
		readonly branchPrefixHint: string;
		readonly statOpen: string;
		readonly statMerged: string;
		readonly statLines: string;
		readonly statRepos: string;
		readonly cleanUpLabel: string;
		readonly cleanUpHint: string;
		readonly cleanUp: string;
		readonly connectLabel: string;
		readonly connectHint: string;
		readonly instructionsLabel: string;
		readonly instructionsHint: string;
		readonly drafted: string;
		readonly drafting: string;
		readonly draft: string;
		readonly redraft: string;
		readonly draftFailed: string;
		readonly filesLabel: string;
		readonly filesHint: string;
		readonly fileColumn: string;
		readonly coordinatorColumn: string;
		readonly threadsColumn: string;
		readonly noFiles: string;
		readonly addFiles: string;
		readonly newFile: string;
		readonly newFilePrompt: string;
		readonly removeFile: string;
		readonly alsoRead: string;
		readonly alsoReadHint: string;
		readonly noRules: string;
		readonly tokens: string;
		readonly unsaved: string;
		readonly unsavedOne: string;
		readonly appliesWhen: string;
		readonly discard: string;
		readonly discardConfirm: string;
		readonly keepEditing: string;
		readonly cancel: string;
		readonly save: string;
	};
	/** The side panel; `{0}` is a count or a model's name. */
	readonly panel: {
		readonly title: string;
		readonly noThreads: string;
		readonly working: string;
		readonly waiting: string;
		readonly planned: string;
		readonly done: string;
		readonly merged: string;
		readonly context: string;
		readonly conductorTracks: string;
		readonly noConductor: string;
		readonly model: string;
		readonly repos: string;
	};
	readonly states: { readonly starting: string; readonly working: string; readonly waiting: string; readonly planned: string; readonly done: string; readonly error: string };
	readonly actions: { readonly [action in ThreadAction]: string };
	readonly openToAnswer: string;
	readonly merged: string;
	/** A thread in several repositories: one repository merged, and how many of how many are. */
	readonly repoMerged: string;
	readonly mergedCount: string;
	readonly undone: string;
	/** `{0}` is a Conductor track's id. */
	readonly track: string;
}

/** Localised strings the webview shows; it has no l10n of its own. Placeholders are `{0}`. */
export interface ChatStrings {
	readonly placeholder: string;
	/** Set only in a project's chat. */
	readonly project?: ProjectChatStrings;
	/** The badge on a thread's brief and the notes its coordinator relays. */
	readonly fromCoordinator: string;
	readonly placeholderFollowUp: string;
	readonly send: string;
	readonly stop: string;
	/** Read out by screen readers when a turn ends. */
	readonly replyFinished: string;
	/** The empty chat's heading, and the line and hints under it. */
	readonly welcomeTitle: string;
	readonly welcome: string;
	readonly hintMention: string;
	readonly hintNewLine: string;
	readonly hintCommands: string;
	/** The button that jumps back to the latest message. */
	readonly scrollToBottom: string;
	/** The jump-to-latest button's label. */
	readonly latest: string;
	readonly thinking: string;
	/** The working strip above the composer: what the agent is doing while a turn runs. */
	readonly activityWorking: string;
	readonly activityWaiting: string;
	readonly activityWriting: string;
	/** `{0}` is a clock such as "1:12". */
	readonly activityDone: string;
	readonly activityStopHint: string;
	/** `{0}` is a number of seconds. */
	readonly thoughtFor: string;
	/** A thought whose duration is not known (the view reloaded). */
	readonly thought: string;
	readonly plan: string;
	/** A subagent's row: `{0}` is its name; then how long it took, `{0}` a duration. */
	readonly subagent: string;
	readonly subagentWorking: string;
	readonly subagentFinished: string;
	readonly subagentFailed: string;
	/** `{0}` is the update kind. */
	readonly unknownUpdate: string;
	readonly terminal: string;
	readonly openDiff: string;
	readonly copy: string;
	readonly copied: string;
	readonly mode: string;
	readonly model: string;
	readonly noFiles: string;
	readonly noCommands: string;
	/** Labels for a command from the agent and one from .gemini/commands. */
	readonly commandFromCli: string;
	readonly commandFromTeam: string;
	readonly commandFromSkill: string;
	readonly remove: string;
	/** `{0}` is the shared page's title. */
	readonly sharedPage: string;
	readonly stopSharing: string;
	/** `{0}` is the file's name. */
	readonly fileTooLarge: string;
	readonly attachFiles: string;
	readonly dropFiles: string;
	readonly cannotAttach: string;
	readonly calloutNote: string;
	readonly calloutTip: string;
	readonly calloutImportant: string;
	readonly calloutWarning: string;
	readonly calloutCaution: string;
	readonly openFile: string;
	/** `{0}` is the chosen option's name. */
	readonly permissionAnswered: string;
	readonly permissionCancelled: string;
	readonly permissionHint: string;
	/** `{0}` is a duration such as "12s" or "2m 5s". */
	readonly workedFor: string;
	readonly copyReply: string;
	readonly copyMessage: string;
	readonly undoTurn: string;
	readonly undoTurnTooltip: string;
	/** Tooltip of the Shared page chip; `{0}` is the page's address. */
	readonly showSharedPage: string;
	/** Tooltip of a prompt's Rewind button. */
	readonly rewindPrompt: string;
	/** `{0}` is a number of files. */
	readonly undoTurnFiles: string;
	readonly turnUndone: string;
	readonly retry: string;
	readonly retryTooltip: string;
	readonly buildPlan: string;
	readonly buildPlanTooltip: string;
	/** `{0}` is the branch; the branch pill's tooltip. */
	readonly switchBranch: string;
	/** The commit pill's tooltip, and its short label. */
	readonly createBranchAndCommit: string;
	readonly commit: string;
	/** The Enhance prompt pill, its tooltip, and what screen readers hear while and after it works. */
	readonly enhance: string;
	/** The floating button's own label, short as it follows the text. */
	readonly enhanceShort: string;
	readonly enhanceTooltip: string;
	/** The Preview tab's tooltip; `{0}` is its shortcut. */
	readonly previewMarkdown: string;
	/** The composer's tabs: the draft, and the draft as it will look once sent. */
	readonly previewLabel: string;
	readonly writeLabel: string;
	/** The eye toggle in the composer bar. */
	readonly followAgent: string;
	/** The outline of the user's prompts, with its keys. */
	readonly promptOutline: string;
	readonly previewEmpty: string;
	readonly enhancing: string;
	readonly enhanced: string;
	/** Under the draft while it is rewritten. */
	readonly enhancingNote: string;
	/** Under the rewrite; {0} is the undo shortcut. */
	readonly enhancedNote: string;
	/** Shown when a rewrite takes a while. */
	readonly stillEnhancing: string;
	/** Shown when a rewrite takes long enough that Gemini is likely waiting out a rate limit. */
	readonly enhanceWaiting: string;
	readonly cancel: string;
	readonly revert: string;
	readonly revertTooltip: string;
	/** `{0}` is the folder's path; the workspace pill's tooltip. */
	readonly workspaceTooltip: string;
	/** "Repository {0} on {1}, at {2}", for a project's repositories in the footer. */
	readonly repoTooltip: string;
	readonly repositories: string;
	/** After the workspace's name when the agent works in its own copy of it. */
	readonly worktree: string;
	/** The saved sessions card in an empty agent chat. */
	readonly restoreTitle: string;
	readonly restoreHint: string;
	readonly restore: string;
	/** `{0}` is how many sessions there are. */
	readonly showAllSessions: string;
	readonly commandFromApp: string;
	/** The usage popover's title. */
	readonly usage: string;
	readonly usageThisChat: string;
	/** `{0}` is a number of replies. */
	readonly usageTurns: string;
	readonly usageOneTurn: string;
	readonly usageInput: string;
	readonly usageOutput: string;
	readonly usageModel: string;
	readonly usageTotal: string;
	/** Under the chat's counts: what input counts. */
	readonly usageInputNote: string;
	readonly usageNoTurns: string;
	/** Only replies from before GeminiCode kept counts. */
	readonly usageNoCounts: string;
	/** `{0}` and `{1}` are numbers of replies. */
	readonly usageSomeCounted: string;
	readonly usageQuota: string;
	/** `{0}` is a percentage. */
	readonly usageUsed: string;
	/** `{0}` is a number of hours or minutes. */
	readonly usageResetsHours: string;
	readonly usageResetsMinutes: string;
	readonly usageChecking: string;
	/** `{0}` is a time such as "2 min ago", already short. */
	readonly usageCheckedJustNow: string;
	readonly usageCheckedMinutes: string;
	readonly usageQuotaOff: string;
	readonly usageQuotaNone: string;
	readonly usageQuotaFailed: string;
	readonly usageUpgrade: string;
	/** The "+" button's tooltip and its menu. */
	readonly plusMenu: string;
	readonly menuSearch: string;
	readonly menuFiles: string;
	readonly menuFilesDetail: string;
	readonly menuContext: string;
	readonly menuContextDetail: string;
	readonly menuFollow: string;
	readonly menuFollowDetail: string;
	/** Follow the agent's tooltip while it is on. */
	readonly followAgentOn: string;
	/** `{0}` is a percentage. */
	readonly menuUsageDetail: string;
	readonly menuCommands: string;
	readonly back: string;
	/** The model, branch and folder menus under and beside the composer. */
	readonly branchSearch: string;
	readonly createBranch: string;
	readonly newBranchName: string;
	/** `{0}` is the new branch's name. */
	readonly createBranchNamed: string;
	readonly invalidBranchName: string;
	readonly noBranches: string;
	readonly loading: string;
	readonly currentBranch: string;
	readonly copyPath: string;
	readonly revealFolder: string;
	readonly showAgents: string;
	readonly addFolder: string;
	/** `{0}` is the mode and what it does. */
	readonly modeChip: string;
	/** `{0}` is the default mode. */
	readonly modeChipReset: string;
	/** The context ring's tooltip; `{0}` is a percentage. */
	readonly usageRing: string;
	readonly followedFile: string;
	readonly closeFollowed: string;
	readonly usageContext: string;
	readonly usageThisChatScope: string;
	readonly usageAccount: string;
	readonly usageContextNone: string;
	/** `{0}` is a short token count such as 1M. */
	readonly usageContextOf: string;
	/** `{0}` is a percentage. */
	readonly usageContextNote: string;
	/** `{0}` is a short token count. */
	readonly usageCached: string;
	readonly usageCachedNote: string;
	readonly usageDetails: string;
	readonly usageHideDetails: string;
	readonly usageAllModels: string;
	readonly usageFewerModels: string;
}

/** How full the session's context window is, from the counts the CLI saved with its replies. */
export interface SharedPageView {
	readonly title: string;
	readonly url: string;
}

export interface ViewContext {
	/** The latest request's input tokens. */
	readonly used: number;
	readonly limit: number;
	/** Input tokens served from the cache over the session. */
	readonly cached: number;
	readonly model?: string;
}

/** Today's quota for the usage popover. */
export type ViewQuota =
	| { readonly kind: 'ok'; readonly quota: readonly ModelQuota[]; /** When it was read, in ms since the epoch. */ readonly at: number; /** A newer read is on its way. */ readonly checking?: boolean }
	/** Being read, with nothing to show yet. */
	| { readonly kind: 'checking' }
	/** Signed in with an API key, which has no quota to read. */
	| { readonly kind: 'none' }
	| { readonly kind: 'failed' }
	/** Turned off with `gemini.usageMeter.enabled`. */
	| { readonly kind: 'off' };

/** A saved Gemini CLI session the chat can reopen. */
export interface ViewSession {
	readonly id: string;
	readonly title: string;
	/** "3 prompts · 2h", already localised. */
	readonly detail: string;
}

/** The chat folder's git state, for the branch pill and Create Branch & Commit. */
export interface ViewGit {
	/** Unset outside a repository. */
	readonly branch?: string;
	/** Whether there are agent changes to commit. */
	readonly canCommit: boolean;
	/** The workspace the chat's agent works in, for the workspace pill. */
	readonly workspace?: ViewWorkspace;
	/** A project's several repositories, each with its branch, in place of the branch and workspace pills. */
	readonly repos?: readonly ViewRepo[];
}

export interface ViewRepo {
	readonly name: string;
	/** Where the agent sees it, with the home folder as ~. */
	readonly path: string;
	/** Unset when its branch can't be read. */
	readonly branch?: string;
}

export interface ViewBranch {
	readonly name: string;
	readonly current: boolean;
	/** How long ago its last commit was, already localised. */
	readonly age?: string;
}

export interface ViewWorkspace {
	readonly name: string;
	/** Where the agent runs, with the home folder as ~. */
	readonly path: string;
	/** Whether the agent works in its own copy (a worktree) rather than the folder itself. */
	readonly worktree: boolean;
}

export type FromWebview =
	| { readonly type: 'ready'; readonly protocol?: number }
	/** The transcript from `reset` is on screen. */
	| { readonly type: 'shown' }
	| { readonly type: 'prompt'; readonly text: string; readonly attachments: readonly Attachment[] }
	/** The @-mention picker wants files matching `query`; answered with `files` carrying the same `requestId`. */
	| { readonly type: 'searchFiles'; readonly requestId: number; readonly query: string }
	/** The "/" menu opened; answered with `commands`. */
	| { readonly type: 'listCommands' }
	| { readonly type: 'stop' }
	| { readonly type: 'command'; readonly command: StatusCommand }
	| { readonly type: 'setMode'; readonly id: string }
	| { readonly type: 'setModel'; readonly id: string }
	/** The user picked one of a permission request's options. */
	| { readonly type: 'permission'; readonly id: string; readonly optionId: string }
	/** Show the diff for a file a tool call or permission request changes; `itemId` is the transcript item. */
	| { readonly type: 'openDiff'; readonly itemId: string; readonly path: string }
	| { readonly type: 'openLocation'; readonly path: string; readonly line?: number }
	/** A file named in the reply's text: absolute, relative to the agent's folder, or a bare name to look for. */
	| { readonly type: 'openPath'; readonly path: string; readonly line?: number }
	/** The branch menu opened; answered with `branches`. */
	| { readonly type: 'listBranches' }
	/** Switch to branch `name`, or create it from the current one. */
	| { readonly type: 'switchBranch'; readonly name: string; readonly create: boolean }
	/** The folder menu: copy the folder's path, reveal it, or show the Agents list. */
	/** `repo` names one of a project's several repositories (ViewGit.repos) to act on instead of the workspace. */
	| { readonly type: 'workspaceAction'; readonly action: 'copyPath' | 'reveal' | 'showAgents' | 'addFolder'; readonly repo?: string }
	/** Reopen saved session `id` in this chat. */
	| { readonly type: 'restoreSession'; readonly id: string }
	/** Pick from every saved session for the folder. */
	| { readonly type: 'pickSession' }
	/** The attach button: pick files from anywhere to attach. */
	| { readonly type: 'pickFiles' }
	/** Files dropped with paths (file: URIs), such as from the Explorer. */
	| { readonly type: 'attachUris'; readonly uris: readonly string[] }
	/** The × on the shared page's chip: give the page back to the user. */
	| { readonly type: 'stopSharing' }
	/** The user dragged the input to `height` pixels, or reset it (0). */
	| { readonly type: 'composerHeight'; readonly height: number }
	/** The eye toggle: open each file the agent reads or edits. */
	| { readonly type: 'setFollow'; readonly on: boolean }
	/** Show the file Follow the agent opened last. */
	| { readonly type: 'showFollowed' }
	/** Close the file Follow the agent opened last. */
	| { readonly type: 'closeFollowed' }
	| { readonly type: 'createBranchAndCommit' }
	/** A project chat's thread card button. */
	| { readonly type: 'threadAction'; readonly thread: string; readonly action: ThreadAction; readonly repo?: string }
	/** The New thread dialog: start a thread directly; the coordinator hears afterwards. */
	| { readonly type: 'startThread'; readonly thread: NewThread }
	| { readonly type: 'openParentProject' }
	/** Open Project settings. */
	| { readonly type: 'openProjectSettings' }
	| { readonly type: 'saveProjectSettings'; readonly settings: ProjectSettingsSave }
	/** One of Project settings' buttons that need the extension. */
	| { readonly type: 'projectSettingsAction'; readonly action: ProjectSettingsAction; readonly name?: string }
	/** The pointer is on a thread's card or panel row: it is likely opened next, so its agent can start now. */
	| { readonly type: 'prepareThread'; readonly thread: string }
	/** Put back the files the turn ending with turnEnd item `itemId` changed, and those of later turns. */
	| { readonly type: 'undoTurn'; readonly itemId: string }
	/** Rewind to before the user's prompt `itemId`: the chat, the code since, or both, as the user picks. */
	| { readonly type: 'rewind'; readonly itemId: string }
	/** A Shared page chip was clicked: show the page's tab. */
	| { readonly type: 'openSharedPage' }
	/** Esc twice in an empty message box: pick a prompt to rewind to. */
	| { readonly type: 'pickRewind' }
	/** Send the prompt of the turn ending with `itemId` again; only the latest turn offers it. */
	| { readonly type: 'retry'; readonly itemId: string }
	/** Leave Plan mode and carry out the plan; only the latest turn offers it, when it ended in Plan mode. */
	| { readonly type: 'buildPlan'; readonly itemId: string }
	/** The composer has text: get a rewrite session ready. */
	| { readonly type: 'prepareEnhance' }
	/** Rewrite the draft as a precise prompt; answered with `enhanced` or `enhanceFailed` carrying the same `requestId`. */
	| { readonly type: 'enhancePrompt'; readonly requestId: number; readonly text: string; readonly attachments: readonly Attachment[] }
	| { readonly type: 'cancelEnhance'; readonly requestId: number }
	/** The usage popover opened; answered with `quota`, once or twice. */
	| { readonly type: 'readQuota' }
	/** "Get higher limits" in the usage popover, shown when a model's quota runs low. */
	| { readonly type: 'openUpgrade' };

export type ToWebview =
	/** The chat's tab came to the front: the message box takes the focus. */
	| { readonly type: 'focus' }
	/** `gemini.chat.spellCheck` changed. */
	| { readonly type: 'spellCheck'; readonly on: boolean }
	| { readonly type: 'reset'; readonly items: readonly TranscriptItem[]; readonly busy: boolean; readonly status: ViewStatus; readonly settings: SessionSettings }
	/** Added or changed items, in the order they first changed; streaming updates are batched. */
	| { readonly type: 'items'; readonly items: readonly ItemUpdate[] }
	| { readonly type: 'busy'; readonly busy: boolean }
	/** The view's tab or pane went out of sight, or came back: a hidden view keeps updates and renders them when shown. */
	| { readonly type: 'visibility'; readonly hidden: boolean }
	| { readonly type: 'status'; readonly status: ViewStatus }
	| { readonly type: 'settings'; readonly settings: SessionSettings }
	/** Whether the agent takes pasted images; sent with every session. */
	| { readonly type: 'capabilities'; readonly image: boolean }
	/** The input height the user dragged to last, in any chat; 0 for its natural height. */
	| { readonly type: 'composerHeight'; readonly height: number }
	/** Whether this chat follows the agent. */
	| { readonly type: 'follow'; readonly on: boolean }
	/** The file Follow the agent opened last, while it is still open. */
	| { readonly type: 'followed'; readonly file: { readonly name: string; readonly path: string } | undefined }
	| { readonly type: 'files'; readonly requestId: number; readonly files: readonly { readonly path: string; readonly relative: string }[] }
	/** Every slash command this chat offers: the agent's, then the team's. */
	| { readonly type: 'commands'; readonly commands: readonly SlashCommand[] }
	/** Context to add to the composer, from the Add to Chat commands. */
	| { readonly type: 'attach'; readonly attachments: readonly Attachment[] }
	/** The page the user shared with this agent in the GeminiCode browser, pinned to the composer until they stop sharing it. */
	| { readonly type: 'sharedPage'; readonly page: SharedPageView | undefined }
	| { readonly type: 'git'; readonly git: ViewGit }
	/** The folder's local branches for the branch menu, or why it cannot switch (`notice`). */
	| { readonly type: 'branches'; readonly branches: readonly ViewBranch[]; readonly notice?: string }
	/** The colour theme's syntax colours, for code blocks. */
	| { readonly type: 'tokenColors'; readonly colors: TokenColors }
	/** The Enhance Prompt command: enhance what the composer holds. */
	| { readonly type: 'enhanceRequested' }
	/** The rewrite so far, while it arrives; `enhanced` follows with the whole of it. */
	| { readonly type: 'enhanceProgress'; readonly requestId: number; readonly text: string }
	| { readonly type: 'enhanced'; readonly requestId: number; readonly text: string }
	/** Puts `text` in the message box, such as a prompt the chat was rewound to. */
	| { readonly type: 'draft'; readonly text: string }
	| { readonly type: 'enhanceFailed'; readonly requestId: number; readonly message: string }
	/** The newest saved sessions the empty chat offers to reopen, of `total`. */
	/** `retention` says how long the CLI keeps saved chats. */
	| { readonly type: 'sessions'; readonly sessions: readonly ViewSession[]; readonly total: number; readonly retention: string }
	| { readonly type: 'quota'; readonly quota: ViewQuota }
	/** The context window's use; unset when unknown, such as before the first reply. */
	| { readonly type: 'context'; readonly context: ViewContext | undefined }
	/** Show Usage and Quota: open the usage popover, or close it if open. */
	| { readonly type: 'toggleUsage' }
	/** A project chat's side panel. */
	| { readonly type: 'projectPanel'; readonly panel: ProjectPanel }
	/** Open the New thread dialog, from the New Thread command. */
	| { readonly type: 'openNewThread' }
	/** Open Project settings, or refresh it while open. */
	| { readonly type: 'projectSettings'; readonly settings: ProjectSettingsView; readonly open: boolean }
	/** The folder picked for Project settings' Add repository. */
	| { readonly type: 'pickedRepository'; readonly repo: ProjectRepoView }
	/** A project thread's chat: the bar that leads back to its project chat. */
	| { readonly type: 'parentProject'; readonly parent: ParentProject };
