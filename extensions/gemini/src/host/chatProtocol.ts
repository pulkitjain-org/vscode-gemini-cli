/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between an agent's chat (chatController.ts) and its webview
// (webview-src/chat.ts). Types only, so the webview bundle can import them.

import type { Attachment } from '../acp/attachments';
import type { IndexToolVerbs, TeamToolVerbs, ToolRef, ToolRefContext } from '../acp/toolLinks';
import type { ModelQuota } from '../acp/directRequest';
import type { ForkContext, TranscriptItem } from '../acp/chatTranscript';
import type { ItemUpdate } from '../acp/textDeltas';
import type { SessionSettings } from '../acp/sessionSettings';
import type { SlashCommand } from '../acp/slashCommands';
import type { AgentPhase } from '../acp/status';
import type { TokenColors } from '../acp/tokenColors';
import type { PendingPromptView } from '../acp/promptQueue';

/**
 * Bumped when the messages change, so the host can tell when the webview
 * bundle in media/ is older than the extension (a stale development build).
 */
export const chatProtocolVersion = 36;

/** Commands the status line may offer; the host runs only these. */
export const statusCommands = ['gemini.restartAgent', 'gemini.signIn', 'gemini.completeSetupInTerminal', 'gemini.setProjectId', 'gemini.showLog', 'gemini.agents.openTerminal'] as const;
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

/** The strings only a project's chat shows. */
export interface ProjectChatStrings {
	readonly placeholder: string;
	/** While the coordinator works, what the user writes waits for its turn to end. */
	readonly placeholderWorking: string;
	readonly sendAfterTurn: string;
	readonly queued: string;
	/** Retry on a failed coordinator turn. */
	readonly retryWake: string;
	/** The "+" menu's item to start a thread directly. */
	readonly newThread: string;
	/** The "+" menu's switch for the project's Plan first default, in place of the coordinator's own mode. */
	readonly planFirst: string;
	readonly planFirstTip: string;
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
export interface RunStrings {
	readonly run: string;
	/** The chevron button beside Run, which opens its menu. */
	readonly more: string;
	readonly insert: string;
	readonly newTerminal: string;
	/** `{0}` is a repository's name. */
	readonly runIn: string;
	/** A thread or project with several repositories, when the command names none. */
	readonly pick: string;
	readonly cancel: string;
	/** Run is off until the reply's block is finished. */
	readonly streaming: string;
	readonly running: string;
	/** `{0}` is how long it took. */
	readonly passed: string;
	/** `{0}` is the exit code, `{1}` how long it took. */
	readonly failed: string;
	readonly sendOutput: string;
	/** The "+" menu's Open Terminal, in the agent's folder. */
	readonly openTerminal: string;
	readonly openTerminalDetail: string;
}

/** How Run on a reply's shell blocks behaves, from `gemini.chat.runCommands`. */
export type RunMode = 'askWhenRisky' | 'alwaysAsk' | 'off';

/** Run on a reply's shell block: run it, type it in without Return, or run it in a new terminal. */
export type RunAction = 'run' | 'insert' | 'newTerminal';

/** Where a chat's Run runs: the names of its places, more than one only in a thread or project with several repositories. */
export interface RunView {
	readonly mode: RunMode;
	readonly places: readonly string[];
}

/** A shell block's Run, by the block's text. */
export type RunState =
	| { readonly kind: 'idle' }
	/** Asks before it runs: `text` says what the command does and where; `place` is the repository picked, if one was. */
	| { readonly kind: 'confirm'; readonly text: string; readonly place?: string }
	/** Asks which repository to run in, for `action`. */
	| { readonly kind: 'pick'; readonly action: RunAction }
	| { readonly kind: 'running' }
	/** How it ended; unset when the shell had no integration to say. */
	| { readonly kind: 'done'; readonly exitCode?: number; readonly ms?: number };

/** The reaction button, quick reactions, chips and picker. */
export interface ReactionStrings {
	/** The reaction button's tooltip. */
	readonly add: string;
	/** The quick bar's last button, which opens the picker. */
	readonly more: string;
	/** The quick reactions' tooltips, in order: thumbs up, thumbs down, question mark, heart. */
	readonly quick: readonly [string, string, string, string];
	/** `{0}` is the emoji: the line for a prompt that reacted, and the chip's label. */
	readonly reacted: string;
	readonly chip: string;
	/** `{0}` is the emoji: the agent's reaction to a prompt, as its badge's tooltip. */
	readonly agentReacted: string;
	/** `{0}` is the emoji, in the queue strip. */
	readonly queued: string;
	/** Jumps to the reply a reaction line points at. */
	readonly showReply: string;
	readonly picker: string;
	readonly search: string;
	readonly recent: string;
	readonly noResults: string;
	/** The picker's categories, in emojibase's group order without its component group. */
	readonly groups: readonly string[];
}

export interface ChatStrings {
	readonly placeholder: string;
	/** Set only in a project's chat. */
	readonly project?: ProjectChatStrings;
	/** Fork Agent's strings, in chats that can fork. */
	readonly fork?: ForkStrings;
	/** Emoji reactions' strings; unset in a project's chat, which has none. */
	readonly reactions?: ReactionStrings;
	/** The badge on a thread's brief and the notes its coordinator relays. */
	readonly fromCoordinator: string;
	readonly placeholderFollowUp: string;
	/** While the agent works: how Return sends now and ⌘Return queues. */
	readonly placeholderWorking: string;
	readonly send: string;
	/** Send while the agent works: it steers the running turn. */
	readonly sendNow: string;
	readonly stop: string;
	/** The strip of messages sent while the agent works. */
	readonly queued: string;
	/** A note from a thread's coordinator, waiting for the thread's turn to end. */
	readonly queuedFromCoordinator: string;
	readonly steering: string;
	readonly queueSendNow: string;
	readonly queueEdit: string;
	readonly queueRemove: string;
	/** "{0} attached", for a pending message with attachments. */
	readonly queueAttached: string;
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
	/** The strip's hint after one Esc: a second one stops the agent. */
	readonly activityStopAgain: string;
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
	/** Run on a reply's shell blocks. */
	readonly run: RunStrings;
	readonly mode: string;
	readonly model: string;
	readonly noFiles: string;
	readonly noCommands: string;
	/** The composer's menus' names for screen readers: files to attach, and slash commands. */
	readonly pickerFiles: string;
	readonly pickerCommands: string;
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
	/** A short time such as the first token's: "{0} s" (with one decimal) and "{0} ms". */
	readonly durationSeconds: string;
	readonly durationMs: string;
	/** Announced to screen readers as a question comes, whether or not focus moves to it; `{0}` is its title. */
	readonly permissionWaiting: string;
	/** The pill on a confirm-class card, and the line under its effect; `{0}` is the tool's name. */
	readonly confirmClass: string;
	readonly confirmWhy: string;
	/** `{0}` is the time to the agent's first reply text. */
	readonly firstToken: string;
	/** The compact card and divider (`webview-src/items.ts`). `suggested` takes the percent full; `done` takes the tokens before and after. */
	readonly compact: {
		readonly suggested: string; readonly suggestedText: string; readonly compact: string; readonly notNow: string;
		readonly running: string; readonly done: string; readonly keptOne: string; readonly kept: string; readonly keptNone: string;
		readonly undo: string; readonly viewSummary: string; readonly undone: string; readonly failed: string;
		/** The usage popover's button, and its note. */
		readonly popover: string; readonly popoverNote: string;
	};
	/** The card for a turn GeminiCode's quit cut off. */
	readonly cutOff: { readonly title: string; readonly text: string; readonly retry: string; readonly keep: string };
	/** The readout of where a turn's time went, while a trace is recording. */
	readonly trace: { readonly title: string; readonly source: string; readonly hop: string; readonly share: string; readonly thisTurn: string; readonly budget: string; readonly tokens: string; readonly file: string; readonly open: string };
	/** `{0}` is a duration such as "12s" or "2m 5s". */
	readonly workedFor: string;
	/** A turn's fold: its steps under one line once the turn is done (webview-src/work.ts). */
	readonly work: {
		/** The line of a turn that ended in an error, with and without its duration (`{0}`). */
		readonly stoppedAfter: string;
		readonly stopped: string;
		/** The line of a turn whose duration is not known: `{0}` is a number of steps. */
		readonly steps: string;
		readonly oneStep: string;
		/** What the turn did, as "read 1 file" and "read {0} files" for each kind of step. */
		readonly counts: Readonly<Record<'read' | 'search' | 'execute' | 'edit' | 'fetch' | 'other', readonly [one: string, many: string]>>;
		/** A run of steps of one kind: `{0}` is how many. */
		readonly runs: Readonly<Record<'read' | 'search' | 'execute' | 'edit' | 'fetch' | 'other', string>>;
		/** `{0}` is a number of failed steps; `failedFixed` when each was run again and got through. */
		readonly failed: string;
		readonly failedFixed: string;
		/** After a failed step's title, when the same step got through later. */
		readonly fixedLater: string;
		readonly changed: string;
		readonly showOutput: string;
	};
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
	/** The + menu's team tools section, and its rows. */
	readonly fromYourTools: string;
	readonly jiraTicket: string;
	readonly gitlabItem: string;
	readonly figmaFrame: string;
	readonly pasteLink: string;
	/** The + menu's row that opens the Open Merge Request page for the agent's branch, when GitLab is connected. */
	readonly openMergeRequest: string;
	readonly openMergeRequestTip: string;
	/** Friendly titles for the geminicode-tools calls. */
	readonly teamToolVerbs: TeamToolVerbs;
	/** Friendly titles for the geminicode-index calls. */
	readonly indexToolVerbs: IndexToolVerbs;
	/** Chip tooltip while a ticket or merge request is being read. */
	readonly toolChipLoading: string;
	/** A tool chip's label for opening its item; {0} is the item, such as ACME-412. */
	readonly openToolItem: string;
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
	/** Whether the session holds enough prompts for Compact to summarize. */
	readonly canCompact: boolean;
}

/** Fork Agent's button, dialog, cards and line (`webview-src/fork.ts`, `items.ts`). */
export interface ForkStrings {
	readonly button: string;
	readonly buttonTip: string;
	readonly fromHere: string;
	/** `{0}` is the agent's name. */
	readonly title: string;
	/** `{0}` is the prompt whose reply the fork ends with. */
	readonly fromHereNote: string;
	readonly name: string;
	readonly context: string;
	readonly whole: string;
	readonly wholeHint: string;
	readonly compact: string;
	readonly compactHint: string;
	readonly conversation: string;
	readonly conversationHint: string;
	/** `{0}` is a token count such as "38k". */
	readonly tokens: string;
	readonly wholeLarge: string;
	readonly where: string;
	/** `{0}` is the parent's branch. */
	readonly ownBranch: string;
	readonly ownBranchPlain: string;
	readonly ownBranchHint: string;
	readonly branch: string;
	readonly sameFolder: string;
	readonly sameFolderHint: string;
	/** Under the branch, for a project thread's fork, which is always a new thread. */
	readonly threadHint: string;
	readonly noGit: string;
	readonly message: string;
	readonly messagePlaceholder: string;
	readonly model: string;
	readonly sameModel: string;
	readonly cancel: string;
	readonly start: string;
	readonly close: string;
	/** A fork's card in its parent's chat: `{0}` is its name, `{1}` its branch. */
	readonly card: string;
	readonly cardBranch: string;
	readonly cardShared: string;
	readonly cardRemoved: string;
	readonly open: string;
	readonly merge: string;
	/** The line in a fork's chat: `{0}` is its parent's name. */
	readonly from: string;
	readonly fromContext: Readonly<Record<ForkContext, string>>;
}

/** What the Fork dialog offers (`webview-src/fork.ts`). */
export interface ForkView {
	/** The agent forked, and the name suggested for the fork. */
	readonly parentTitle: string;
	readonly title: string;
	/** Fork from Here on a reply: the prompt item the fork stops before (none for the last reply), and the prompt the reply answered. */
	readonly fromHere?: { readonly before?: string; readonly answered: string };
	/** About how many tokens each choice sends with every request; `compact` is unset when it can't be made now, with `compactWhy`. */
	readonly tokens: { readonly whole: number; readonly compact?: number; readonly conversation: number };
	readonly compactWhy?: string;
	readonly context: ForkContext;
	/** Whether the fork can have a branch of its own, the parent's branch it would start from, and the name suggested. */
	readonly git: boolean;
	readonly parentBranch?: string;
	readonly branch: string;
	/** The parent has no branch of its own: the fork's branch is named after the fork until the user types one. */
	readonly branchFollowsName: boolean;
	/** A project's thread: its fork is a new thread, which always has a branch of its own. */
	readonly branchOnly?: boolean;
}

/** The Fork dialog's choices. */
export interface ForkRequest {
	readonly title: string;
	readonly context: ForkContext;
	readonly ownBranch: boolean;
	readonly branch?: string;
	readonly model?: string;
	/** Sent to the fork once it starts. */
	readonly message?: string;
	/** Fork from Here: the prompt's item. */
	readonly before?: string;
}

/** What a fork card in the parent's chat can do with the fork. */
export type ForkAction = 'open' | 'merge';

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
	/** A reviewer agent's merge request review, which the chip opens. */
	readonly review?: { readonly label: string; readonly tip: string };
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
	/** `when` matters only while the agent works: `now` steers the running turn, `queue` waits for it to end. */
	| { readonly type: 'prompt'; readonly text: string; readonly attachments: readonly Attachment[]; readonly when?: 'now' | 'queue' }
	/** A pending message's buttons: send it now, take it back into the box, or drop it. */
	| { readonly type: 'queueAction'; readonly id: string; readonly action: 'send' | 'edit' | 'remove' }
	/** The user reacted to the reply that turnEnd item `turnEnd` ends; `name` is the emoji's name in the picker. */
	| { readonly type: 'react'; readonly turnEnd: string; readonly emoji: string; readonly name: string }
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
	/** The review chip: open the merge request review this agent works on. */
	| { readonly type: 'openReview' }
	/** The + menu: open the Open Merge Request page for this agent's branch. */
	| { readonly type: 'openMergeRequest' }
	/** Reopen saved session `id` in this chat. */
	| { readonly type: 'restoreSession'; readonly id: string }
	/** Pick from every saved session for the folder. */
	| { readonly type: 'pickSession' }
	/** The attach button: pick files from anywhere to attach. */
	| { readonly type: 'pickFiles' }
	/** Files dropped with paths (file: URIs), such as from the Explorer. */
	| { readonly type: 'attachUris'; readonly uris: readonly string[] }
	/** A Jira ticket, GitLab item or Figma frame the user named: the extension answers with toolRefResolved. */
	| { readonly type: 'resolveToolRef'; readonly ref: ToolRef }
	/** A click on a tool chip, in the composer or a sent message: open its item (`toolRefId`) in its tool. */
	| { readonly type: 'openToolRef'; readonly ref: string }
	/** The + menu's "From your tools": the extension asks which item, then sends attachToolRef. */
	| { readonly type: 'pickToolItem'; readonly tool: 'jira' | 'gitlab' | 'figma' }
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
	/** The "+" menu's Plan first switch: the project's default for new threads. */
	| { readonly type: 'setPlanFirst'; readonly on: boolean }
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
	/** A cut-off turn's card: send its prompt again, or keep things as they are. */
	| { readonly type: 'retryCutOff' | 'dismissCutOff'; readonly itemId: string }
	/** Compact the chat's session: from the usage popover, or answering the suggestion card `itemId`. */
	| { readonly type: 'compact'; readonly itemId?: string }
	/** A compact card's Undo, Not Now and View Summary. */
	| { readonly type: 'undoCompact' | 'dismissCompact' | 'viewCompactSummary'; readonly itemId: string }
	/** Open the Fork dialog: for the whole chat, or (Fork from Here) for the chat up to the reply that ends at `turnEnd`. */
	| { readonly type: 'requestFork'; readonly turnEnd?: string }
	/** The Fork dialog's Fork. */
	| { readonly type: 'fork'; readonly fork: ForkRequest }
	/** A fork card's buttons, in its parent's chat. */
	| { readonly type: 'forkAction'; readonly agent: string; readonly action: ForkAction }
	| { readonly type: 'openTrace'; readonly file: string }
	/** Leave Plan mode and carry out the plan; only the latest turn offers it, when it ended in Plan mode. */
	| { readonly type: 'buildPlan'; readonly itemId: string }
	/** The composer has text: get a rewrite session ready. */
	| { readonly type: 'prepareEnhance' }
	/** Rewrite the draft as a precise prompt; answered with `enhanced` or `enhanceFailed` carrying the same `requestId`. */
	| { readonly type: 'enhancePrompt'; readonly requestId: number; readonly text: string; readonly attachments: readonly Attachment[] }
	| { readonly type: 'cancelEnhance'; readonly requestId: number }
	/** The usage popover opened; answered with `quota`, once or twice. */
	| { readonly type: 'readQuota' }
	/** Run on a reply's shell block: `text` is the block, `place` a repository picked, `confirmed` after the block asked. */
	| { readonly type: 'runCommand'; readonly text: string; readonly language: string; readonly action: RunAction; readonly place?: string; readonly confirmed?: boolean }
	/** A failed Run's Send Output to Gemini: the command and its output go to the composer. */
	| { readonly type: 'sendRunOutput'; readonly text: string }
	/** "Get higher limits" in the usage popover, shown when a model's quota runs low. */
	| { readonly type: 'openUpgrade' };

export type ToWebview =
	/** The chat's tab came to the front: the message box takes the focus. */
	| { readonly type: 'focus' }
	/** `gemini.chat.spellCheck` changed. */
	| { readonly type: 'spellCheck'; readonly on: boolean }
	/** `gemini.chat.foldFinishedWork` changed. */
	| { readonly type: 'foldWork'; readonly on: boolean }
	/** Whether reactions are on (`gemini.chat.reactions.enabled`), and the picker's Recent row. */
	| { readonly type: 'reactions'; readonly on: boolean; readonly recents: readonly string[] }
	| { readonly type: 'reset'; readonly items: readonly TranscriptItem[]; readonly busy: boolean; readonly status: ViewStatus; readonly settings: SessionSettings }
	/** Added or changed items, in the order they first changed; streaming updates are batched. */
	| { readonly type: 'items'; readonly items: readonly ItemUpdate[] }
	| { readonly type: 'busy'; readonly busy: boolean }
	/** The messages sent while the agent works that have not gone yet, oldest first. */
	| { readonly type: 'queue'; readonly items: readonly PendingPromptView[] }
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
	/** The connected team tools and Jira projects, for finding tickets and links in the composer. */
	| { readonly type: 'toolRefs'; readonly context: ToolRefContext }
	/** A tool chip's title and content; replaces the chip whose `ref` matches. */
	| { readonly type: 'toolRefResolved'; readonly attachment: Attachment }
	/** Adds a chip for an item the user picked from the + menu. */
	| { readonly type: 'attachToolRef'; readonly ref: ToolRef }
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
	/** Open the Fork dialog. */
	| { readonly type: 'openFork'; readonly fork: ForkView }
	/** A project chat's side panel. */
	| { readonly type: 'projectPanel'; readonly panel: ProjectPanel }
	/** Open the New thread dialog, from the New Thread command. */
	| { readonly type: 'openNewThread' }
	/** Open Project settings, or refresh it while open. */
	| { readonly type: 'projectSettings'; readonly settings: ProjectSettingsView; readonly open: boolean }
	/** The folder picked for Project settings' Add repository. */
	| { readonly type: 'pickedRepository'; readonly repo: ProjectRepoView }
	/** A project thread's chat: the bar that leads back to its project chat. */
	| { readonly type: 'parentProject'; readonly parent: ParentProject }
	/** How Run on shell blocks behaves, and where it runs. */
	| { readonly type: 'run'; readonly run: RunView }
	/** A shell block's Run, by the block's text. */
	| { readonly type: 'runState'; readonly text: string; readonly state: RunState };
