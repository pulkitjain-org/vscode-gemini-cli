/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat's webview messages (chatProtocol.ts), each routed to the feature
// that answers it. The table names every message type, so a type added to
// `FromWebview` without a handler fails to compile.

import type { Attachment } from '../../acp/attachments';
import type { ChatTranscript } from '../../acp/chatTranscript';
import type { PromptExtras } from '../../acp/promptQueue';
import * as vscode from 'vscode';
import { type FromWebview, statusCommands, type ToWebview } from '../chatProtocol';
import { rememberComposerHeight } from '../modelPreference';
import type { ChatAttachments } from './chatAttachments';
import type { ChatCheckpoints } from './chatCheckpoints';
import type { ChatCommands } from './chatCommands';
import type { ChatCompact } from './chatCompact';
import type { ChatEnhance } from './chatEnhance';
import type { ChatFileLinks } from './chatFiles';
import type { ChatFollow } from './chatFollow';
import type { ChatFork } from './chatFork';
import type { ChatGitControls } from './chatGit';
import type { ChatControllerOptions, ChatHost } from './chatOptions';
import type { ChatPermissions } from './chatPermissions';
import type { ChatPlan } from './chatPlan';
import type { ChatProjectView } from './chatProject';
import type { ChatQueue } from './chatQueue';
import type { ChatReactions } from './chatReactions';
import type { ChatRun } from './chatRun';
import type { ChatSessions } from './chatSessions';
import type { ChatSettings } from './chatSettings';
import type { SharedPageChip } from './chatSharedPage';
import type { ChatSide } from './chatSide';
import type { SideLinksColumn } from './chatSideLinks';
import type { ChatTurn } from './chatTurn';
import type { ChatUsage } from './chatUsage';

/** The messages of type `K`; a member whose `type` is a union of names (`retryCutOff | dismissCutOff`) answers to each. */
type MessageOf<M, K> = M extends { readonly type: infer T } ? K extends T ? M : never : never;

/** One handler per message type, each given the message of its type. */
type ChatHandlers = { readonly [K in FromWebview['type']]: (message: MessageOf<FromWebview, K>) => void };

/** The chat's features, each answering its own messages. */
export interface RouterFeatures {
	readonly files: ChatFileLinks;
	readonly permissions: ChatPermissions;
	readonly follow: ChatFollow;
	readonly git: ChatGitControls;
	readonly usage: ChatUsage;
	readonly attachments: ChatAttachments;
	readonly sharedPage: SharedPageChip;
	readonly sideLinks: SideLinksColumn;
	readonly settings: ChatSettings;
	readonly enhance: ChatEnhance;
	readonly commands: ChatCommands;
	readonly sessions: ChatSessions;
	readonly checkpoints: ChatCheckpoints;
	readonly compacting: ChatCompact;
	readonly forks: ChatFork;
	readonly side: ChatSide;
	readonly project: ChatProjectView;
	readonly runs: ChatRun;
	readonly queue: ChatQueue;
	readonly reactions: ChatReactions;
	readonly plan: ChatPlan;
	readonly turn: ChatTurn;
}

/** What the messages need of the chat itself. */
export interface RouterHost {
	isBusy(): boolean;
	/** The view's script is ready: the chat sends it everything it shows. */
	ready(message: Extract<FromWebview, { readonly type: 'ready' }>): void;
	/** Sends a message as if typed in the view. */
	send(text: string, attachments?: readonly Attachment[], from?: 'coordinator', when?: 'now' | 'queue', extras?: PromptExtras): Promise<void>;
	/** Stops the running turn, as the Stop button does. */
	stop(): void;
	post(message: ToWebview): void;
}

/** Routes each of the view's messages to its handler. */
export function chatRouter(
	service: Pick<ChatHost, 'open' | 'writeLog'>,
	transcript: ChatTranscript,
	options: Pick<ChatControllerOptions, 'project' | 'reviewPlan' | 'sharedFiles' | 'teamTools' | 'debugAction'>,
	features: RouterFeatures,
	host: RouterHost,
): (message: FromWebview) => void {
	const f = features;

	/** A failed or cut-short turn's Retry or Continue, from its notice, while that notice still offers it. */
	const noticeAction = (itemId: string, action: 'retry' | 'continue' | 'newSession' | 'fixErrors'): void => {
		const notice = host.isBusy() ? undefined : transcript.noticeOffering(itemId, action);
		if (!notice) {
			return;
		}
		const lastPrompt = f.turn.lastPrompt;
		if (action === 'fixErrors') {
			void host.send(`Fix these errors in the files you changed, then check again with code_diagnostics:\n${notice.text.split('\n').slice(1).join('\n')}`);
		} else if (action === 'newSession') {
			void f.turn.continueAfterOverflow(lastPrompt?.text, 'refused');
		} else if (action === 'continue') {
			// Carries on where the request limit stopped the turn, as the CLI's own "continue" does.
			void host.send('Continue.');
		} else if (lastPrompt?.reactions) {
			void f.turn.startPrompt(lastPrompt.text, lastPrompt.attachments, undefined, lastPrompt.reactions);
		} else if (lastPrompt) {
			// A session that failed to open is opened again first (`ensureReady`, `AgentClient.retryOpen`).
			void host.send(lastPrompt.text, lastPrompt.attachments);
		}
	};

	const handlers = {
		shown: () => service.open?.(),
		useTeamTools: () => {
			if (options.teamTools) {
				options.teamTools.enable();
				host.post({ type: 'teamTools', state: 'on' });
			}
		},
		turnRendered: message => {
			// One line per turn in the Gemini log: the agent's time, the model's first output, and the view's share.
			const item = transcript.items.find(i => i.id === message.turnEnd);
			if (item?.kind === 'turnEnd') {
				transcript.updateTurnEnd(item.id, { renderMs: message.renderMs, renderedUpdates: message.updates });
				const firstToken = item.firstTokenMs === undefined ? '' : `, first output ${item.firstTokenMs} ms after send`;
				service.writeLog?.(`Turn: ${item.durationMs} ms${firstToken}; the view rendered ${message.updates} updates in ${message.renderMs} ms`);
			}
		},
		ready: message => host.ready(message),
		prompt: message => void host.send(message.text, message.attachments ?? [], undefined, message.when, { includeEdits: !!message.includeEdits }),
		queueAction: message => f.queue.queueAction(message.id, message.action),
		react: message => f.reactions.react(message.turnEnd, message.emoji, message.name),
		composerHeight: message => rememberComposerHeight(message.height),
		// Stop means stop: messages sent now wait instead, for the user to send.
		stop: () => host.stop(),
		command: message => {
			if (statusCommands.includes(message.command)) {
				void vscode.commands.executeCommand(message.command);
			}
		},
		retry: message => {
			const lastPrompt = f.turn.lastPrompt;
			if (options.project) {
				// A project's failed wake: the hub sends its events again.
				transcript.clearRetry();
				options.project.retryWake();
			} else if (lastPrompt?.reactions && message.itemId === f.turn.retryItemId && !host.isBusy()) {
				void f.turn.startPrompt(lastPrompt.text, lastPrompt.attachments, undefined, lastPrompt.reactions);
			} else if (lastPrompt && message.itemId === f.turn.retryItemId) {
				void host.send(lastPrompt.text, lastPrompt.attachments);
			}
		},
		retryCutOff: message => {
			const item = transcript.items.find(i => i.id === message.itemId);
			if (item?.kind === 'cutOff' && item.prompt) {
				transcript.dismissCutOff(item.id);
				void host.send(item.prompt);
			}
		},
		dismissCutOff: message => transcript.dismissCutOff(message.itemId),
		buildPlan: message => void f.plan.buildPlan(message.itemId, typeof message.mode === 'string' ? message.mode : undefined),
		reviewPlan: message => {
			const item = transcript.items.find(each => each.id === message.itemId);
			if (item?.kind === 'turnEnd' && item.planFile) {
				const file = item.planFile;
				void f.plan.rebuildPlan(file).then(() => options.reviewPlan?.(file));
			}
		},
		listCommands: () => void f.commands.postCommands(),
		permission: message => f.permissions.onMessage(message),
		noticeAction: message => noticeAction(message.itemId, message.action),
		showOutput: message => host.post({ type: 'output', itemId: message.itemId, part: message.part, text: f.files.outputs.get(message.itemId, message.part) }),
		showAgentChanges: message => options.sharedFiles?.show(message.agent),
		setMode: message => f.settings.onMessage(message),
		setModel: message => f.settings.onMessage(message),
		setCliDefaultModel: message => f.settings.onMessage(message),
		openDiff: message => f.files.onMessage(message),
		openLocation: message => f.files.onMessage(message),
		openPath: message => f.files.onMessage(message),
		openTrace: message => f.files.onMessage(message),
		pickFiles: message => f.attachments.onMessage(message),
		attachUris: message => f.attachments.onMessage(message),
		searchFiles: message => f.attachments.onMessage(message),
		resolveToolRef: message => f.attachments.onMessage(message),
		openToolRef: message => f.attachments.onMessage(message),
		pickToolItem: message => f.attachments.onMessage(message),
		attachMention: message => f.attachments.onMessage(message),
		stopSharing: message => f.sharedPage.onMessage(message),
		openSharedPage: message => f.sharedPage.onMessage(message),
		openSideLink: message => f.sideLinks.onMessage(message),
		setFollow: message => f.follow.onMessage(message),
		showFollowed: message => f.follow.onMessage(message),
		closeFollowed: message => f.follow.onMessage(message),
		listBranches: message => f.git.onMessage(message),
		switchBranch: message => f.git.onMessage(message),
		createBranchAndCommit: message => f.git.onMessage(message),
		writeCommitMessage: message => f.git.onMessage(message),
		commitToBranch: message => f.git.onMessage(message),
		workspaceAction: message => f.git.onMessage(message),
		openReview: message => f.git.onMessage(message),
		openMergeRequest: message => f.git.onMessage(message),
		restoreSession: message => f.sessions.onMessage(message),
		pickSession: message => f.sessions.onMessage(message),
		undoTurn: message => f.checkpoints.onMessage(message),
		rewind: message => f.checkpoints.onMessage(message),
		pickRewind: message => f.checkpoints.onMessage(message),
		requestFork: message => f.forks.onMessage(message),
		fork: message => f.forks.onMessage(message),
		forkAction: message => f.forks.onMessage(message),
		sideAsk: message => f.side.onMessage(message),
		sideCancel: message => f.side.onMessage(message),
		compact: message => f.compacting.onMessage(message),
		undoCompact: message => f.compacting.onMessage(message),
		dismissCompact: message => f.compacting.onMessage(message),
		viewCompactSummary: message => f.compacting.onMessage(message),
		threadAction: message => f.project.onMessage(message),
		prepareThread: message => f.project.onMessage(message),
		openProjectSettings: message => f.project.onMessage(message),
		saveProjectSettings: message => f.project.onMessage(message),
		setPlanFirst: message => f.project.onMessage(message),
		projectSettingsAction: message => f.project.onMessage(message),
		startThread: message => f.project.onMessage(message),
		openParentProject: message => f.project.onMessage(message),
		prepareEnhance: message => f.enhance.onMessage(message),
		enhancePrompt: message => f.enhance.onMessage(message),
		cancelEnhance: message => f.enhance.onMessage(message),
		readQuota: message => f.usage.onMessage(message),
		openUpgrade: message => f.usage.onMessage(message),
		measureContext: message => f.usage.onMessage(message),
		runCommand: message => f.runs.onMessage(message),
		sendRunOutput: message => f.runs.onMessage(message),
		debugAction: message => options.debugAction?.(message.action, message.arg),
	} satisfies ChatHandlers;

	// A type the table lacks (a view script older than the protocol) does nothing, as before.
	return message => (handlers[message.type] as ((message: FromWebview) => void) | undefined)?.(message);
}
