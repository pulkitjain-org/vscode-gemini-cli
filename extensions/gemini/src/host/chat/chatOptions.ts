/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a chat (ChatController) is given: the agent session it talks to, the
// @-mention file list, and the options that set which of its features show.
// Types only.

import type * as acp from '@agentclientprotocol/sdk';
import type { AgentRuntime } from '../../acp/agentRuntime';
import type * as vscode from 'vscode';
import type { AgentClient } from '../../acp/agentClient';
import type { Attachment } from '../../acp/attachments';
import type { StoredCheckpoints } from '../../acp/checkpoints';
import type { PermissionBroker } from '../../acp/permissions';
import type { EnhancePromptInput } from '../../acp/quickPrompts';
import type { AgentStatus } from '../../acp/status';
import type { OtherAgentChanges, TranscriptItem } from '../../acp/chatTranscript';
import type { ConversationEntry, MessageRecord } from '../../acp/cliSessions';
import type { FinishedCommand, RunPlace } from '../../acp/runCommands';
import type { RunOutcome } from '../agentTerminals';
import type { ForkAction, ForkRequest, NewThread, ProjectSettingsAction, ProjectSettingsSave, SideLink, ThreadAction, ViewContextBreakdown, ViewSideLinks } from '../chatProtocol';
import type { TryChoice } from '../panelProtocol';
import type { DebugAction } from '../debug/debugProtocol';
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
	/** Starts the agent if needed and resolves once this session is ready; rejects with a `WaitAbortedError` when `signal` aborts. */
	ensureReady(signal?: AbortSignal): Promise<unknown>;
	/** Opens a session that waits to be opened until its chat is on screen; unset when sessions open at once. */
	open?(): void;
	/** Stops the current turn. */
	cancel(): Promise<void>;
	/** Asks to trust `folder` for the CLI, as on first use; resolves whether agents there run trusted now. The agent restarts once no prompt runs. */
	askToTrust(folder: string): Promise<boolean>;
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
	/** Copies the user's edits to the agent's tried files into its folder (Send My Edits); resolves whether it did. */
	sendTriedEdits?(): Promise<boolean>;
	/** Opens the plan file a Plan mode turn wrote in Plan Review. */
	reviewPlan?(file: string): void;
	/** Where Plan Review keeps its state: a plan rebuilt from the session's history prefers its copy there. */
	readonly planReviewFolder?: string;
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
	/**
	 * The team tools for this agent: listed to its sessions only once its task needs them
	 * (a ticket or merge request in a prompt or an attachment, a flow, or the user's choice).
	 */
	readonly teamTools?: {
		/** Whether any team tool is connected, so they can be turned on. */
		available(): boolean;
		enabled(): boolean;
		/** Turns them on for good; a running session hears through tools/list_changed. */
		enable(): void;
		/** Turns them on when `text` or `attachments` refer to a ticket, merge request, page or design. */
		notePrompt(text: string, attachments: readonly Attachment[]): void;
	};
	/** What Read the code too needs: the agent process, the folder, and the index's servers and outline for it. Unset in a project's chats, whose threads do the reading. */
	research?: ChatResearchHost;
	/** The notice for errors the language servers report in the folder's changed files after a turn that edited them; undefined without any. */
	errorsAfterTurn?(): Promise<string | undefined>;
	/** The note a prompt with a Figma design carries when the repository has a design-system skill (designSystem.ts). */
	designSystemNote?(): Promise<string | undefined>;
	/** The workspace pill; without it the composer shows none. */
	workspace?(): ChatWorkspace | undefined;
	/** Today's quota, for the usage popover; unset shows it as off. */
	usage?(): UsageMeter | undefined;
	/** Set in a project's chat. */
	readonly project?: ChatProject;
	/** A project thread's chat: names its project, and opens the project chat. */
	readonly parentProject?: { name(): string; open(): void };
	/** The side column's links (Changes, Browser, Terminal, Files); unset in chats without one, such as a project's. */
	readonly sideLinks?: ChatSideLinks;
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
	/** Other live agents in the same folder with changes still to review, for the warning on this agent's edits to the same file. */
	readonly sharedFiles?: {
		others(filePath: string): readonly OtherAgentChanges[];
		/** Show Its Changes: opens agent `agent`'s changes. */
		show(agent: string): void;
	};
	/** The usage popover's context breakdown (`/context`); unset shows none. */
	contextCost?(): ChatContextCost | undefined;
	/** The @ picker's Symbols: definitions named like `query` in the folder's index; undefined while the index is off, unavailable or not built. */
	symbols?(query: string): Promise<readonly ChatSymbol[] | undefined>;
	/** A note every prompt carries, such as Debug mode's phase and hypotheses; undefined adds none. */
	turnNote?(): string | undefined;
	/** A debug bar or card button (src/host/debug); unset where Debug mode is not offered. */
	debugAction?(action: DebugAction, arg?: string): void;
}

/** What the side column shows and opens. */
export interface ChatSideLinks {
	view(): ViewSideLinks;
	/** Fires when the totals change. */
	onDidChange(listener: () => void): { dispose(): void };
	open(link: SideLink): void;
}

/** A definition the workspace index found, for the @ picker. */
export interface ChatSymbol {
	readonly name: string;
	readonly kind: string;
	/** Absolute. */
	readonly path: string;
	/** 1-based, inclusive. */
	readonly line: number;
	readonly endLine: number;
}

/** What every model call in a folder carries, and the rule files loaded there (chatContext.ts). */
export interface ChatContextCost {
	view(folder: string): ViewContextBreakdown;
	/** Measures `folder` when its last measure is a day old, or at once with `force`; resolves once done. */
	measure(folder: string, force: boolean): Promise<void>;
	/** Fires with the folder whose breakdown changed. */
	onDidChange(listener: (folder: string) => void): { dispose(): void };
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
	/** The last command that finished in the agent's terminals, else in the terminal in front, with its output, for the @ picker. */
	lastCommand?(): FinishedCommand | undefined;
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
	/** `repo` names one repository of a thread in several, for Merge back; `choice` is the Try chevron menu's pick. */
	threadAction(thread: string, action: ThreadAction, repo?: string, choice?: TryChoice): void;
	/** The New thread dialog's Start thread. */
	startThread(thread: NewThread): void;
	/** Project settings: open it, save it, or one of its buttons that needs the extension. */
	openSettings(): void;
	saveSettings(settings: ProjectSettingsSave): void;
	/** The "+" menu's switch: whether new threads plan first by default. */
	setPlanFirst(on: boolean): void;
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
export interface ChatResearchHost {
	readonly runtime: AgentRuntime;
	/** The folder researched: the agent's own. */
	cwd(): string;
	/** A worker's MCP servers (the index's), and their release when it is done. */
	mcpServers(worker: string): acp.McpServer[];
	release(worker: string): void;
	/** The index's outline of the folder, for the planner. */
	outline(): Promise<string | undefined>;
}

export interface ChatEnhancer {
	/** Gets a rewrite ready, so the next one only waits for the model. */
	prepare(): void;
	/** `onText` is called with the rewrite so far as it arrives. */
	enhance(input: EnhancePromptInput, signal: AbortSignal, onText?: (text: string) => void): Promise<string>;
	/** A side question's answer, the same way: a quick request, else a Plan-mode session of its own (chatSide.ts). */
	ask(system: string, prompt: string, signal: AbortSignal, onText?: (text: string) => void): Promise<string>;
}

export interface ChatGit {
	/** The folder whose branch the chat shows; unset when there is none. */
	folder(): string | undefined;
	/** Create Branch & Commit, for chats that know which files their agent changed. */
	readonly commit?: {
		/** Absolute paths; empty hides the button. */
		files(): readonly string[];
		onDidChange(listener: () => void): { dispose(): void };
		/** The branch and message offered; `writeMessage` writes a better message from the changes, when it can. */
		suggestion(): { readonly branch: string; readonly message: string; readonly writeMessage?: () => Promise<string | undefined> };
		/** The files were committed. */
		committed(): void;
	};
	/** Set for an agent on its own branch: the chat must not switch it, or Merge Back would miss the work. */
	readonly ownBranch?: string;
}
