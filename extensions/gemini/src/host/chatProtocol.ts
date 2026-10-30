/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between an agent's chat (chatController.ts) and its webview
// (webview-src/chat.ts). Types only, so the webview bundle can import them.

import type { Attachment } from '../acp/attachments';
import type { ToolRef, ToolRefContext } from '../acp/toolLinks';
import type { ModelQuota } from '../acp/directRequest';
import type { ForkContext, NoticeAction, TranscriptItem } from '../acp/chatTranscript';
import type { ItemUpdate } from '../acp/textDeltas';
import type { SessionSettings } from '../acp/sessionSettings';
import type { SlashCommand } from '../acp/slashCommands';
import type { AgentPhase } from '../acp/status';
import type { TokenColors } from '../acp/tokenColors';
import type { ContextBreakdown } from '../acp/contextCost';
import type { PendingPromptView } from '../acp/promptQueue';

/**
 * Bumped when the messages change, so the host can tell when the webview
 * bundle in media/ is older than the extension (a stale development build).
 */
export const chatProtocolVersion = 49;

/** Commands the status line may offer; the host runs only these. */
export const statusCommands = ['gemini.restartAgent', 'gemini.signIn', 'gemini.completeSetupInTerminal', 'gemini.setProjectId', 'gemini.showLog', 'gemini.agents.openTerminal', 'gemini.designSystem.sync'] as const;
export type StatusCommand = typeof statusCommands[number];

export interface ViewStatus {
	readonly phase: AgentPhase;
	/** Shown above the composer when not empty. */
	readonly text: string;
	/** Buttons shown with the text, such as Start or Sign In. */
	readonly actions?: readonly { readonly label: string; readonly command: StatusCommand }[];
}

/** The stall notice: what it says, and its buttons. */
export interface ViewStall {
	readonly text: string;
	readonly actions: readonly NoticeAction[];
}

/** What a project chat's thread card buttons do. */
/** Project settings' buttons that need the extension: pick a repository folder, add or make a context file, open one, draft the Memory text, or clean up merged threads' folders. */
export type ProjectSettingsAction = 'pickRepository' | 'addFiles' | 'newFile' | 'openFile' | 'draft' | 'cleanUp';

/**
 * `startAnyway`: the side panel's Start Anyway, which starts the threads
 * today's quota holds. `merge` is Merge Back's merge commit; `tryMenu` is
 * the chevron beside the Try button, which picks what it does and remembers
 * it for the repository; the rest of the try actions are `TryAction`s.
 * `guide` shows the first-try guide, `dismissGuide` hides it.
 */
export type ThreadAction = 'open' | 'stop' | 'merge' | 'review' | 'remove' | 'approve' | 'retry' | 'startAnyway' | TryAction | 'tryMenu' | 'guide' | 'dismissGuide' | 'terminal' | 'checks';

/** Trying an agent's work in the user's checkout (agentTries.ts). */
export type TryAction = 'try' | 'keep' | 'takeBack' | 'send' | 'resolve' | 'discard' | 'restore';

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
	readonly counts: { readonly queued: number; readonly working: number; readonly waiting: number; readonly planned: number; readonly done: number; readonly merged: number };
	/** The repo's Conductor files, when it has a `conductor/` folder. */
	readonly conductor?: { readonly openTracks: number };
	/** The model the coordinator runs on, when known. */
	readonly model?: string;
	/**
	 * Every thread, oldest first, each opening its own chat: `requests`, how many its chat recorded
	 * ("148 requests"), and `detail` for a queued one ("Starts when a running thread finishes · 4 of 4 running").
	 */
	readonly threads: readonly { readonly id: string; readonly title: string; readonly state: 'queued' | 'working' | 'waiting' | 'planned' | 'done' | 'merged'; readonly requests?: string; readonly detail?: string }[];
	/** "This project: 382 requests across 6 threads", once its threads made any. */
	readonly requests?: string;
	/** New threads held because today's quota is over 90% used: the banner, with Start Anyway. */
	readonly held?: string;
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

/** The usage popover's context breakdown (contextCost.ts). */
export type ViewContextBreakdown = ContextBreakdown;

/** The @ picker's rows besides files: a folder, a symbol from the index, or one of the Workspace rows. */
export type ViewMention =
	| { readonly kind: 'folder'; readonly path: string; readonly relative: string }
	| { readonly kind: 'symbol'; readonly name: string; readonly symbolKind: string; readonly path: string; readonly relative: string; readonly line: number; readonly endLine: number }
	| { readonly kind: 'problems'; readonly errors: number; readonly warnings: number }
	| { readonly kind: 'changes'; readonly files: number }
	| { readonly kind: 'terminal'; readonly command: string; readonly failed: boolean };

/** How full the session's context window is, from the counts the CLI saved with its replies. */
export interface SharedPageView {
	readonly title: string;
	readonly url: string;
}

/** A link in an agent's or thread's side column, which opens that part of the agent beside its chat. */
export type SideLink = 'changes' | 'browser' | 'terminal' | 'files';

/** The side column's heading and the agent's change totals. */
export interface ViewSideLinks {
	/** The repository or folder the agent works on, for "On {0}". */
	readonly place: string;
	readonly added: number;
	readonly removed: number;
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

/** What the Fork dialog offers (`webview-src/fork.ts`). */
export interface ForkView {
	/** The agent forked, and the name suggested for the fork. */
	readonly parentTitle: string;
	readonly title: string;
	/** Fork from Here on a reply: the prompt item the fork stops before (none for the last reply), and the prompt the reply answered. */
	readonly fromHere?: { readonly before?: string; readonly answered: string };
	/** The fork's first message, filled in: a side question that needs tools. */
	readonly message?: string;
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
	/** The branch Commit commits to, when it isn't the repository's default branch; unset offers Create Branch & Commit. */
	readonly commitTo?: string;
	/** The mode the mode menu tags "Recommended here" for this folder. */
	readonly recommendMode?: string;
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
	/** `includeEdits`: the message box's "Include your edits", sending the user's edits to tried files to the agent first. */
	| { readonly type: 'prompt'; readonly text: string; readonly attachments: readonly Attachment[]; readonly when?: 'now' | 'queue'; readonly includeEdits?: boolean }
	/** A pending message's buttons: send it now, take it back into the box, or drop it. */
	/** `stopNow`: a message sent now that waited long for a safe point stops the turn anyway. */
	| { readonly type: 'queueAction'; readonly id: string; readonly action: 'send' | 'edit' | 'remove' | 'stopNow' }
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
	/** Set as Default for the CLI on the model menu: the model the Gemini CLI starts on, in the terminal too. */
	| { readonly type: 'setCliDefaultModel'; readonly id: string }
	/** The user picked one of a permission request's options. */
	| { readonly type: 'permission'; readonly id: string; readonly optionId: string }
	/** Retry or Continue on a failed or cut-short turn's notice (`itemId`). */
	| { readonly type: 'noticeAction'; readonly itemId: string; readonly action: 'retry' | 'continue' | 'newSession' | 'fixErrors' }
	/** Show All on a long tool output: the host answers with `output`. */
	| { readonly type: 'showOutput'; readonly itemId: string; readonly part: number }
	/** Show Its Changes on an edit another agent is changing the file too: opens that agent's changes. */
	| { readonly type: 'showAgentChanges'; readonly agent: string }
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
	| { readonly type: 'pickToolItem'; readonly tool: 'jira' | 'gitlab' | 'figma' | 'confluence' }
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
	/** The commit message box opened: answered with `commitMessage`. */
	| { readonly type: 'writeCommitMessage' }
	/** The message box's Commit: commit the agent's files to the current branch with `message`. */
	| { readonly type: 'commitToBranch'; readonly message: string }
	/** The usage popover's Measure Again. */
	| { readonly type: 'measureContext' }
	/** A Folders, Symbols or Workspace row of the @ picker: the extension answers with `attach`. */
	| { readonly type: 'attachMention'; readonly mention: ViewMention }
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
	/** A link in the side column was clicked. */
	| { readonly type: 'openSideLink'; readonly link: SideLink }
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
	| { readonly type: 'requestFork'; readonly turnEnd?: string; readonly message?: string }
	/** A side question (/btw): answered from the conversation without stopping the agent or entering its history. */
	/** A side question; with `readCode`, read-only workers read the folder first and the report answers. */
	| { readonly type: 'sideAsk'; readonly question: string; readonly readCode?: boolean }
	| { readonly type: 'sideCancel' }
	/** The Fork dialog's Fork. */
	| { readonly type: 'fork'; readonly fork: ForkRequest }
	/** A fork card's buttons, in its parent's chat. */
	| { readonly type: 'forkAction'; readonly agent: string; readonly action: ForkAction }
	| { readonly type: 'openTrace'; readonly file: string }
	/** Leave Plan mode and carry out the plan; only the latest turn offers it, when it ended in Plan mode. */
	| { readonly type: 'buildPlan'; readonly itemId: string; readonly mode?: string }
	| { readonly type: 'reviewPlan'; readonly itemId: string }
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
	/** `gemini.chat.foldFinishedWork` changed. */
	| { readonly type: 'foldWork'; readonly on: boolean }
	/** Whether reactions are on (`gemini.chat.reactions.enabled`), and the picker's Recent row. */
	| { readonly type: 'reactions'; readonly on: boolean; readonly recents: readonly string[]; readonly meanings: readonly (readonly [string, string])[] }
	| { readonly type: 'reset'; readonly items: readonly TranscriptItem[]; readonly busy: boolean; readonly status: ViewStatus; readonly settings: SessionSettings; readonly stall?: ViewStall }
	/** The running turn has had no update for a while, with Stop and Show Log; undefined once anything arrives. */
	| { readonly type: 'stall'; readonly stall: ViewStall | undefined }
	/** A long tool output in full, for Show All; undefined when the chat no longer keeps it. */
	| { readonly type: 'output'; readonly itemId: string; readonly part: number; readonly text: string | undefined }
	/** Added or changed items, in the order they first changed; streaming updates are batched. */
	| { readonly type: 'items'; readonly items: readonly ItemUpdate[] }
	| { readonly type: 'busy'; readonly busy: boolean }
	/** The messages sent while the agent works that have not gone yet, oldest first. */
	| { readonly type: 'queue'; readonly items: readonly PendingPromptView[] }
	/** The agent's tried files the user edited and hasn't sent it: the message box offers to include them. */
	| { readonly type: 'triedEdits'; readonly files: readonly string[] }
	/** A message sent now has waited long for a safe point: the queue offers Stop Now. */
	| { readonly type: 'steerWaiting'; readonly waiting: boolean }
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
	| { readonly type: 'files'; readonly requestId: number; readonly files: readonly { readonly path: string; readonly relative: string }[]; readonly mentions?: readonly ViewMention[] }
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
	/** The side column of an agent or thread; undefined hides it, as in a project's chat. */
	| { readonly type: 'sideLinks'; readonly links: ViewSideLinks | undefined }
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
	/** The usage popover's context breakdown. */
	| { readonly type: 'contextBreakdown'; readonly breakdown: ViewContextBreakdown }
	/** The message written for the commit box; unset when none could be written. */
	| { readonly type: 'commitMessage'; readonly message: string | undefined }
	/** The box's commit finished: committed, or not (the extension said why), so the box closes or stays. */
	| { readonly type: 'commitDone'; readonly ok: boolean }
	/** `gemini.chat.sendWith`: whether ⌘Return (Ctrl+Enter) sends and Return makes a new line. */
	| { readonly type: 'sendWith'; readonly cmdEnter: boolean }
	/** The context window's use; unset when unknown, such as before the first reply. */
	| { readonly type: 'context'; readonly context: ViewContext | undefined }
	/** Show Usage and Quota: open the usage popover, or close it if open; `open` (/context) only opens it. */
	| { readonly type: 'toggleUsage'; readonly open?: boolean }
	/** Open the Fork dialog. */
	| { readonly type: 'openFork'; readonly fork: ForkView }
	/**
	 * A side question's progress: `open` shows the panel empty, `asked` starts an answer, `text` is the
	 * answer so far, `done` the whole answer and `error` why there is none. `id` tells answers apart.
	 */
	| { readonly type: 'side'; readonly id: number; readonly state: 'open' | 'asked' | 'text' | 'done' | 'error'; readonly question?: string; readonly text?: string }
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
