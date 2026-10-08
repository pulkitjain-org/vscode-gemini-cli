/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between the chat view (chatView.ts) and its webview
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
export const chatProtocolVersion = 15;

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

/** Localised strings the webview shows; it has no l10n of its own. Placeholders are `{0}`. */
export interface ChatStrings {
	readonly placeholder: string;
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
	/** The jump-to-latest button's label, where it shows one (the Glass themes). */
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
	/** `{0}` is a number of files. */
	readonly undoTurnFiles: string;
	readonly turnUndone: string;
	readonly retry: string;
	readonly retryTooltip: string;
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
	/** Shown when a rewrite takes a while. */
	readonly stillEnhancing: string;
	/** Shown when a rewrite takes long enough that Gemini is likely waiting out a rate limit. */
	readonly enhanceWaiting: string;
	readonly cancel: string;
	readonly revert: string;
	readonly revertTooltip: string;
	/** `{0}` is the folder's path; the workspace pill's tooltip. */
	readonly workspaceTooltip: string;
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
	readonly close: string;
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
	/** `{0}` is the mode and what it does. */
	readonly modeChip: string;
	/** `{0}` is the default mode. */
	readonly modeChipReset: string;
	/** The context ring's tooltip; `{0}` is a percentage. */
	readonly usageRing: string;
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
}

/** How full the session's context window is, from the counts the CLI saved with its replies. */
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
	| { readonly type: 'pickBranch' }
	/** The workspace pill: copy its path, reveal it, or show the Agents list. */
	| { readonly type: 'workspaceMenu' }
	/** Reopen saved session `id` in this chat. */
	| { readonly type: 'restoreSession'; readonly id: string }
	/** Pick from every saved session for the folder. */
	| { readonly type: 'pickSession' }
	/** The attach button: pick files from anywhere to attach. */
	| { readonly type: 'pickFiles' }
	/** Files dropped with paths (file: URIs), such as from the Explorer. */
	| { readonly type: 'attachUris'; readonly uris: readonly string[] }
	/** The user dragged the input to `height` pixels, or reset it (0). */
	| { readonly type: 'composerHeight'; readonly height: number }
	/** The eye toggle: open each file the agent reads or edits. */
	| { readonly type: 'setFollow'; readonly on: boolean }
	| { readonly type: 'createBranchAndCommit' }
	/** Put back the files the turn ending with turnEnd item `itemId` changed, and those of later turns. */
	| { readonly type: 'undoTurn'; readonly itemId: string }
	/** Send the prompt of the turn ending with `itemId` again; only the latest turn offers it. */
	| { readonly type: 'retry'; readonly itemId: string }
	/** The composer has text: get a rewrite session ready. */
	| { readonly type: 'prepareEnhance' }
	/** Rewrite the draft as a precise prompt; answered with `enhanced` or `enhanceFailed` carrying the same `requestId`. */
	| { readonly type: 'enhancePrompt'; readonly requestId: number; readonly text: string; readonly attachments: readonly Attachment[] }
	| { readonly type: 'cancelEnhance'; readonly requestId: number }
	/** The usage popover opened; answered with `quota`, once or twice. */
	| { readonly type: 'readQuota' };

export type ToWebview =
	| { readonly type: 'reset'; readonly items: readonly TranscriptItem[]; readonly busy: boolean; readonly status: ViewStatus; readonly settings: SessionSettings }
	/** Added or changed items, in the order they first changed; streaming updates are batched. */
	| { readonly type: 'items'; readonly items: readonly ItemUpdate[] }
	| { readonly type: 'busy'; readonly busy: boolean }
	| { readonly type: 'status'; readonly status: ViewStatus }
	| { readonly type: 'settings'; readonly settings: SessionSettings }
	/** Whether the agent takes pasted images; sent with every session. */
	| { readonly type: 'capabilities'; readonly image: boolean }
	/** The input height the user dragged to last, in any chat; 0 for its natural height. */
	| { readonly type: 'composerHeight'; readonly height: number }
	/** Whether this chat follows the agent. */
	| { readonly type: 'follow'; readonly on: boolean }
	| { readonly type: 'files'; readonly requestId: number; readonly files: readonly { readonly path: string; readonly relative: string }[] }
	/** Every slash command this chat offers: the agent's, then the team's. */
	| { readonly type: 'commands'; readonly commands: readonly SlashCommand[] }
	/** Context to add to the composer, from the Add to Chat commands. */
	| { readonly type: 'attach'; readonly attachments: readonly Attachment[] }
	| { readonly type: 'git'; readonly git: ViewGit }
	/** Whether Send shows the accent colour (true) or the Gemini gradient. */
	| { readonly type: 'accent'; readonly solid: boolean }
	/** The colour theme's syntax colours, for code blocks. */
	| { readonly type: 'tokenColors'; readonly colors: TokenColors }
	/** The Enhance Prompt command: enhance what the composer holds. */
	| { readonly type: 'enhanceRequested' }
	| { readonly type: 'enhanced'; readonly requestId: number; readonly text: string }
	| { readonly type: 'enhanceFailed'; readonly requestId: number; readonly message: string }
	/** The text size in pixels (`gemini.chat.fontSize`). */
	| { readonly type: 'fontSize'; readonly size: number }
	/** The newest saved sessions the empty chat offers to reopen, of `total`. */
	| { readonly type: 'sessions'; readonly sessions: readonly ViewSession[]; readonly total: number }
	| { readonly type: 'quota'; readonly quota: ViewQuota }
	/** The context window's use; unset when unknown, such as before the first reply. */
	| { readonly type: 'context'; readonly context: ViewContext | undefined }
	/** Show Usage and Quota: open the usage popover, or close it if open. */
	| { readonly type: 'toggleUsage' };
