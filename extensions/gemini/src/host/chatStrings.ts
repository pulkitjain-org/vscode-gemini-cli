/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat view's words, which the host writes (`vscode.l10n.t`) and the
// webview reads from its script tag: every string a person sees in the chat,
// its project panel, its side panel, Run and the fork dialog. Kept apart from
// chatProtocol.ts, whose version (`chatProtocolVersion`) counts the messages
// between host and view: a new word changes no message.

import type { IndexToolVerbs, TeamToolVerbs } from '../acp/toolLinks';
import type { ForkContext, NoticeAction } from '../acp/chatTranscript';
import type { ThreadAction } from './chatProtocol';
import type { TryChoiceStrings } from './panelStrings';

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
		readonly queued: string;
		readonly working: string;
		readonly waiting: string;
		readonly planned: string;
		readonly done: string;
		readonly merged: string;
		readonly repos: string;
	};
	readonly states: { readonly starting: string; readonly working: string; readonly waiting: string; readonly planned: string; readonly done: string; readonly error: string };
	readonly actions: { readonly [action in ThreadAction]: string };
	/** The Try button's label when the repository's remembered choice is a merge request. */
	readonly openMr: string;
	/** The Try button's chevron menu. */
	readonly tryChoices: TryChoiceStrings;
	/** Each action's tooltip, for the buttons that have one. */
	readonly tips: { readonly [action in ThreadAction]?: string };
	readonly openToAnswer: string;
	/** The three steps a thread's work goes through, on its card. */
	readonly steps: { readonly thread: string; readonly trying: string; readonly kept: string };
	/** The card's line for each try state; `{0}` is a number of files, `{1}` a list of them. */
	readonly tryLines: {
		readonly trying: string;
		readonly tryingOne: string;
		readonly updated: string;
		readonly working: string;
		readonly paused: string;
		readonly yourEdits: string;
		readonly kept: string;
		readonly keptOne: string;
		readonly discarded: string;
		readonly done: string;
		readonly doneOne: string;
		/** Files Try couldn't merge with the user's edits and left as they were; `{0}` lists them. */
		readonly unmerged: string;
	};
	/** The first-try guide: a title and its three steps. */
	readonly guide: { readonly title: string; readonly steps: readonly string[]; readonly gotIt: string };
	/** The card's ⋯ button's label. */
	readonly more: string;
	/** Open's label on a card whose work is tried or kept: the thread's chat, to ask for more. */
	readonly askForChanges: string;
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

/** The side question panel (/btw). */
export interface SideStrings {
	readonly title: string;
	readonly note: string;
	readonly placeholder: string;
	readonly ask: string;
	readonly close: string;
	readonly earlier: string;
	readonly later: string;
	readonly empty: string;
	readonly answering: string;
	readonly stop: string;
	readonly sendToAgent: string;
	readonly sendToAgentTip: string;
	readonly fork: string;
	readonly forkTip: string;
	readonly copy: string;
	readonly copied: string;
	readonly hint: string;
	/** The Read the code too switch: workers read the folder before answering. */
	readonly readCode: string;
	readonly readCodeTip: string;
	/** The progress a code-reading answer shows while the workers read. */
	readonly research: {
		readonly readOnly: string;
		readonly states: Readonly<Record<'planning' | 'reading' | 'verifying' | 'merging' | 'done' | 'stopped' | 'failed', string>>;
		readonly slice: Readonly<Record<'queued' | 'reading' | 'done' | 'failed', string>>;
		/** `{0}` files read so far. */
		readonly reading: string;
		/** `{0}` findings. */
		readonly findings: string;
	};
}

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
	/** The picker's first row: every emoji with a meaning. */
	readonly withMeaning: string;
	/** The picker's footer for an emoji with no meaning. */
	readonly readsIt: string;
	/** `{0}` is the emoji, `{1}` what it asks for: a chip's tooltip. */
	readonly chipMeaning: string;
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
	/** The side question panel's strings. */
	readonly side?: SideStrings;
	/** Emoji reactions' strings; unset in a project's chat, which has none. */
	readonly reactions?: ReactionStrings;
	/** The + menu's Debug with Gemini and its detail, while gemini.debugMode.enabled is on. */
	readonly debugStart?: readonly [string, string];
	/** The badge on a thread's brief and the notes its coordinator relays. */
	readonly fromCoordinator: string;
	readonly placeholderFollowUp: string;
	/** While the agent works: how Return sends now and ⌘Return queues. */
	readonly placeholderWorking: string;
	readonly send: string;
	/** Send while the agent works: it steers the running turn. */
	readonly sendNow: string;
	/** The checkbox above the message box for an agent whose work is tried; `{0}` lists the files the user edited. */
	readonly includeEdits: string;
	readonly includeEditsTip: string;
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
	/** The model menu's last row: makes the session's model the one the CLI starts on. */
	readonly modelDefaultCli: string;
	readonly modelDefaultCliDetail: string;
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
	/**
	 * A waiting card's choices and the keys that answer it from the chat box.
	 * `session` takes the command prefixes; `hint` and `hintNoSession` take the keys.
	 */
	readonly permission: {
		readonly once: string; readonly session: string; readonly reject: string;
		readonly hint: string; readonly hintNoSession: string;
		/** On another agent's unreviewed changes in the file: `{0}` is the agent's name. */
		readonly othersChanging: string; readonly othersDetail: string; readonly showTheirChanges: string;
	};
	/** A failed or cut-short turn's buttons, and the stall notice's. */
	readonly noticeActions: Readonly<Record<NoticeAction, string>>;
	/** A long tool output's line between its first and last lines: `{0}` is how many are hidden. */
	readonly outputHidden: string;
	readonly outputShowAll: string;
	readonly outputGone: string;
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
	/** A turn stopped for a message sent now; `{0}` is how long it ran. */
	readonly stoppedForMessage: string;
	/** A message sent now, waiting for the agent to reach a safe point, and the button that stops it anyway. */
	readonly steerWaiting: string;
	readonly steerStopNow: string;
	readonly steerStopNowTip: string;
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
	/** The side column's heading; `{0}` is the repository or folder. */
	readonly sideOn: string;
	readonly sideLinks: string;
	readonly sideChanges: string;
	/** The Changes link's tooltip; `{0}` lines added, `{1}` lines removed. */
	readonly sideChangesTip: string;
	readonly sideBrowser: string;
	readonly sideBrowserTip: string;
	readonly sideTerminal: string;
	readonly sideTerminalTip: string;
	readonly sideFiles: string;
	readonly sideFilesTip: string;
	/** Tooltip of a prompt's Rewind button. */
	readonly rewindPrompt: string;
	/** `{0}` is a number of files. */
	readonly undoTurnFiles: string;
	readonly turnUndone: string;
	readonly retry: string;
	readonly retryTooltip: string;
	readonly buildPlan: string;
	readonly buildPlanTooltip: string;
	/** Review Plan beside Approve Plan, opening the plan file in Plan Review. */
	readonly reviewPlan: string;
	readonly reviewPlanTooltip: string;
	/** Approve Plan's chevron and its menu, in the CLI's own words: `{0}` is a mode's name; the hint names the build's model, then the plan's. */
	readonly planBuild: {
		readonly more: string; readonly buildIn: string; readonly asking: string; readonly beforePlan: string; readonly defaultMode: string; readonly models: string;
		readonly autoAccept: string; readonly manualAccept: string; readonly editFirst: string; readonly notYet: string;
	};
	/** `{0}` is the branch; the branch pill's tooltip. */
	readonly switchBranch: string;
	/** The commit pill's tooltip, and its short label. */
	readonly createBranchAndCommit: string;
	readonly commit: string;
	/** Commit to the branch the folder is on (`{0}`), its chevron's menu, and the message box it opens. */
	readonly commitTo: {
		readonly button: string; readonly tip: string; readonly more: string; readonly newBranch: string;
		readonly message: string; readonly writing: string; readonly generated: string; readonly commit: string; readonly cancel: string;
	};
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
	readonly menuTeamTools: string;
	readonly menuTeamToolsDetail: string;
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
	readonly confluencePage: string;
	readonly figmaFrame: string;
	readonly pasteLink: string;
	/** Add Figma Design: a link for each screen size. */
	readonly figmaDesign: string;
	readonly figmaDesignEnd: string;
	readonly figmaDesignTitle: string;
	readonly figmaDesignHint: string;
	readonly figmaSetUpDesignSystem: string;
	readonly figmaSetUpDesignSystemTip: string;
	readonly figmaSize: string;
	/** `{0}` the size. */
	readonly figmaLinkFor: string;
	readonly figmaAddSize: string;
	readonly figmaAddDesign: string;
	readonly figmaUpdateDesign: string;
	/** `{0}` the sizes. */
	readonly figmaOtherFile: string;
	/** `{0}` the size. */
	readonly figmaRepeated: string;
	readonly figmaNotLink: string;
	readonly figmaDesignChip: string;
	/** Add Figma Design's chunk didn't load; the next try loads it again. */
	readonly figmaDesignFailed: string;
	readonly figmaEditDesign: string;
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
	/** The mode menu's tag on the mode suggested for this folder. */
	readonly modeRecommended: string;
	/** What each of the CLI's modes does, by mode id, in place of the CLI's own short descriptions. */
	readonly modeDetails: Readonly<Record<string, string>>;
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
	/** The usage popover's context readings and rule files (`/context`); `{0}` is a server, a name, a time or a size. */
	readonly contextParts: {
		readonly empty: string; readonly folder: string; readonly server: string; readonly geminicode: string; readonly all: string;
		readonly ruleFiles: string; readonly kilobytes: string; readonly large: string;
		readonly measured: string; readonly measureAgain: string; readonly measuring: string; readonly notMeasured: string; readonly failed: string;
	};
	/** The @ picker's groups and its Workspace rows; `{0}` and `{1}` are counts or a command. */
	readonly mentions: {
		readonly files: string; readonly folders: string; readonly symbols: string; readonly workspace: string;
		readonly problems: string; readonly problemsDetail: string; readonly changes: string; readonly changesDetail: string;
		readonly terminal: string; readonly terminalFailed: string;
	};
	/** With `gemini.chat.sendWith` set to cmdEnter: what the placeholder and Send say. */
	readonly cmdEnter: { readonly placeholderWorking: string; readonly send: string; readonly sendNow: string };
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
