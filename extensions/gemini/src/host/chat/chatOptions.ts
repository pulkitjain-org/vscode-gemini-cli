/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a chat (ChatController) is given: the agent session it talks to, the
// @-mention file list, and the options that set which of its features show.
// Types only.

import type * as vscode from 'vscode';
import type { AgentClient } from '../../acp/agentClient';
import type { Attachment } from '../../acp/attachments';
import type { StoredCheckpoints } from '../../acp/checkpoints';
import type { PermissionBroker } from '../../acp/permissions';
import type { EnhancePromptInput } from '../../acp/quickPrompts';
import type { AgentStatus } from '../../acp/status';
import type { TranscriptItem } from '../../acp/chatTranscript';
import type { ConversationEntry, MessageRecord } from '../../acp/cliSessions';
import type { RunPlace } from '../../acp/runCommands';
import type { RunOutcome } from '../agentTerminals';
import type { ForkAction, ForkRequest, NewThread, ProjectSettingsAction, ProjectSettingsSave, ThreadAction } from '../chatProtocol';
import type { ToolChips } from '../toolChips';
import type { UsageMeter } from '../usageMeter';
import type { FileMatch } from '../workspaceFiles';

/** The agent session a chat talks to: the sidebar's, or one agent's in the Agents pane. */
export interface ChatHost {
	readonly client: AgentClient;
	/** This session's permission requests, answered in its chat. */
	readonly permissions: PermissionBroker;
	readonly status: AgentStatus;
	readonly onDidChangeStatus: vscode.Event<AgentStatus>;
	/** Starts the agent if needed and resolves once this session is ready. */
	ensureReady(): Promise<unknown>;
	/** Opens a session that waits to be opened until its chat is on screen; unset when sessions open at once. */
	open?(): void;
	/** Stops the current turn. */
	cancel(): Promise<void>;
	/** Trusts `folder` for the CLI and restarts the agent; returns whether the restart waits for running prompts. */
	trustFolder(folder: string): Promise<boolean>;
	/** Writes to the Gemini log. */
	writeLog?(message: string): void;
}

/** The files the @-mention picker offers. */
export interface FileSearch {
	warm(): void;
	search(query: string, limit: number): Promise<readonly FileMatch[]>;
}

export interface ChatControllerOptions {
	/** Brings the chat into view, for example when the user adds files to it. */
	reveal(preserveFocus: boolean): Promise<void>;
	/** Whether the chat is in view now; unset counts as in view. */
	isShown?(): boolean;
	/** The user picked a model in this chat. */
	onDidPickModel?(modelId: string): void;
	/** A context key kept equal to whether a turn runs, for menus. */
	readonly busyContextKey?: string;
	/** The branch pill and Create Branch & Commit; without it the composer shows neither. */
	readonly git?: ChatGit;
	/** Where files and diffs open; unset opens them in the active editor group. */
	editorColumn?(): Promise<vscode.ViewColumn>;
	/** Rewrites the composer's draft for Enhance prompt. */
	readonly enhancer: ChatEnhancer;
	/** What the folder's index finds for a draft, for Enhance prompt; undefined without a built index. */
	indexContext?(draft: string): Promise<string | undefined>;
	/** A note telling the agent to use the index tools, when its folder's index is built; sent once per session. */
	indexHint?(): string | undefined;
	/** The workspace pill; without it the composer shows none. */
	workspace?(): ChatWorkspace | undefined;
	/** Today's quota, for the usage popover; unset shows it as off. */
	usage?(): UsageMeter | undefined;
	/** Set in a project's chat. */
	readonly project?: ChatProject;
	/** A project thread's chat: names its project, and opens the project chat. */
	readonly parentProject?: { name(): string; open(): void };
	/** The page the user shared with this agent in the GeminiCode browser; unset in chats that never have one. */
	readonly sharedPage?: ChatSharedPage;
	/** Saves the chat's checkpoints after each change, so Undo and Rewind outlast a reload; unset keeps them in memory only. */
	saveCheckpoints?(stored: StoredCheckpoints): void;
	/** Offers to reopen the CLI's saved sessions for the folder (and /resume); unset in chats that do not. */
	readonly savedSessions?: {
		/** Sessions other chats have open, which this one must not take. */
		inUse(): ReadonlySet<string>;
	};
	/** Chips for Jira tickets, GitLab items and Figma frames named in the composer; unset when the team tools aren't set up. */
	toolChips?(): ToolChips | undefined;
	/** The merge request review a reviewer agent works on, for the chip beside its branch. */
	review?(): { readonly label: string; readonly tip: string } | undefined;
	openReview?(): void;
	/** Opens the Open Merge Request page for the agent's branch; unset when the team tools aren't set up. */
	openMergeRequest?(): void;
	/** The agent's name, for Fork Agent. */
	title?(): string;
	/** Fork Agent: makes forks of this chat's agent; unset in chats that can't fork, such as a project's. */
	readonly fork?: ChatForker;
	/** Run on a reply's shell blocks, in the agent's own terminals; unset hides Run. */
	readonly terminal?: ChatTerminal;
}

/** Where and how Run on a reply's command runs it. */
export interface ChatTerminal {
	/** Where Run can run: the agent's folder, or each repository of a thread or project. */
	places(): readonly RunPlace[];
	/** Every Run asks first, as in a project chat, whose repositories are the user's own checkouts. */
	readonly alwaysAsk?: boolean;
	/** Runs `command` in the agent's terminal in `place` (a new one with `fresh`), and resolves when it ends. */
	run(place: RunPlace, command: string, fresh: boolean): Promise<RunOutcome>;
	/** Types `command` into the agent's terminal in `place`, and leaves Return to the user. */
	insert(place: RunPlace, command: string): void;
}

/** What Fork Agent asks of the Agents pane, which makes the fork. */
export interface ChatForker {
	/** Whether the agent's folder is in Git, the branch it has checked out, and a free name for a fork's own branch. */
	place(): Promise<{ readonly git: boolean; readonly branch?: string; readonly forkBranch: string; readonly ownBranch: boolean; readonly branchOnly?: boolean }>;
	/** Makes the fork, opens it and sends it its first message; rejects with a reason to show. */
	start(start: ForkStart): Promise<void>;
	/** A fork card's button. */
	action(agent: string, action: ForkAction): void;
}

/** A fork to make, as the chat has prepared it. */
export interface ForkStart {
	readonly request: ForkRequest;
	/** The session to copy (whole or compacted); unset for Conversation only. */
	readonly messages?: readonly MessageRecord[];
	/** The conversation a Conversation only fork is given with its first prompt. */
	readonly conversation?: readonly ConversationEntry[];
	/** What the fork's chat shows of its parent's. */
	readonly items: readonly TranscriptItem[];
	/** The fork's line in its parent's chat is added once it starts. */
	readonly onStarted: (agent: string, branch: string | undefined) => void;
}

/** A page shared with the agent: pinned to the composer, and named in every prompt until the user stops sharing it. */
export interface ChatSharedPage {
	/** The page shared now, checked against the browser, with the note a prompt carries about it. */
	current(): Promise<{ readonly title: string; readonly url: string; readonly note: string } | undefined>;
	/** Gives the page back to the user. */
	stop(): Promise<void>;
	/** Brings the page's tab to the front; false when the page is no longer shared. */
	reveal(): Promise<boolean>;
}

/** Makes a chat a project's chat: the coordinator's, fed through the project's hub. */
export interface ChatProject {
	/** What the user sends goes to the hub, which wakes the coordinator with it. */
	post(text: string, attachments: readonly Attachment[]): void;
	/** Tool calls the chat leaves out: the project's own tools, which show as posts and thread cards. */
	hidesToolCall(title: string): boolean;
	/** `repo` names one repository of a thread in several, for Merge back. */
	threadAction(thread: string, action: ThreadAction, repo?: string): void;
	/** The New thread dialog's Start thread. */
	startThread(thread: NewThread): void;
	/** Project settings: open it, save it, or one of its buttons that needs the extension. */
	openSettings(): void;
	saveSettings(settings: ProjectSettingsSave): void;
	settingsAction(action: ProjectSettingsAction, name?: string): void;
	/** The pointer is on a thread's card or panel row: start its agent ahead of the click. */
	prepareThread(thread: string): void;
	/** Retry on a failed wake: the hub sends what that wake carried again. */
	retryWake(): void;
	/** The coordinator moved to another session (Compact, its Undo, a full context): the next wake carries the role brief again. */
	sessionReplaced(): void;
}

export interface ChatWorkspace {
	/** The workspace folder, which names the pill. */
	readonly folder: string;
	/** Where the agent runs: the folder, or its place in the agent's own worktree. */
	readonly cwd: string;
	readonly worktree: boolean;
	/** A project's several repositories, each named and where this agent sees it; they take the folder and branch pills' place. */
	readonly repos?: readonly { readonly name: string; readonly folder: string }[];
}

/** Rewrites drafts as precise prompts; one, shared by every chat. */
export interface ChatEnhancer {
	/** Gets a rewrite ready, so the next one only waits for the model. */
	prepare(): void;
	/** `onText` is called with the rewrite so far as it arrives. */
	enhance(input: EnhancePromptInput, signal: AbortSignal, onText?: (text: string) => void): Promise<string>;
}

export interface ChatGit {
	/** The folder whose branch the chat shows; unset when there is none. */
	folder(): string | undefined;
	/** Create Branch & Commit, for chats that know which files their agent changed. */
	readonly commit?: {
		/** Absolute paths; empty hides the button. */
		files(): readonly string[];
		onDidChange(listener: () => void): { dispose(): void };
		suggestion(): { readonly branch: string; readonly message: string };
		/** The files were committed. */
		committed(): void;
	};
	/** Set for an agent on its own branch: the chat must not switch it, or Merge Back would miss the work. */
	readonly ownBranch?: string;
}
