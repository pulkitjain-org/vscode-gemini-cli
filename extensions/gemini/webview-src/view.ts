/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the chat view's modules share: the host API, the localized strings,
// the page's fixed elements (found once, at startup) and the view's state.

import type { Attachment } from '../src/acp/attachments';
import type { PendingPromptView } from '../src/acp/promptQueue';
import type { TranscriptItem } from '../src/acp/chatTranscript';
import type { SessionSettings } from '../src/acp/sessionSettings';
import type { ChatStrings, FromWebview, SharedPageView } from '../src/host/chatProtocol';

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };

export const vscode = acquireVsCodeApi();
export const strings: ChatStrings = JSON.parse(document.querySelector<HTMLScriptElement>('script[data-strings]')?.dataset.strings ?? '{}');

/** `node` if it is a `type`; the page must have it, so anything else is a bug. */
function found<T extends Element>(node: Element | null, type: abstract new () => T, what: string): T {
	if (!(node instanceof type)) {
		throw new Error(`Chat view: ${what} is missing or not a ${type.name}`);
	}
	return node;
}

function byId<T extends HTMLElement>(id: string, type: abstract new () => T): T {
	return found(document.getElementById(id), type, `#${id}`);
}

function within<T extends HTMLElement>(parent: HTMLElement, selector: string, type: abstract new () => T): T {
	return found(parent.querySelector(selector), type, `#${parent.id} ${selector}`);
}

function parentOf(node: HTMLElement): HTMLElement {
	return found(node.parentElement, HTMLElement, `the parent of #${node.id}`);
}

const modelButton = byId('model', HTMLButtonElement);
const modeChip = byId('mode-chip', HTMLElement);
const branchButton = byId('branch', HTMLButtonElement);
const commitButton = byId('commit', HTMLButtonElement);
const enhanceButton = byId('enhance', HTMLButtonElement);
const revertButton = byId('revert', HTMLButtonElement);
const workspaceButton = byId('workspace', HTMLButtonElement);
const reviewChip = byId('review-chip', HTMLButtonElement);

export const ui = {
	transcript: byId('transcript', HTMLElement),
	outline: byId('outline', HTMLElement),
	sideLinks: byId('side-links', HTMLElement),
	status: byId('status', HTMLElement),
	activity: byId('activity', HTMLElement),
	activityLabel: within(byId('activity', HTMLElement), '.activity-label', HTMLElement),
	activityClock: within(byId('activity', HTMLElement), '.activity-clock', HTMLElement),
	activityDetail: within(byId('activity', HTMLElement), '.activity-detail', HTMLElement),
	activityHint: within(byId('activity', HTMLElement), '.activity-hint', HTMLElement),
	announce: byId('announce', HTMLElement),
	form: byId('composer', HTMLFormElement),
	input: byId('input', HTMLTextAreaElement),
	sendButton: byId('send', HTMLButtonElement),
	stopButton: byId('stop', HTMLButtonElement),
	modeChip,
	modeChipLabel: within(modeChip, '.mode-chip-label', HTMLButtonElement),
	modeChipReset: within(modeChip, '.mode-chip-reset', HTMLButtonElement),
	modelButton,
	modelLabel: within(modelButton, 'span', HTMLSpanElement),
	modelMenu: byId('model-menu', HTMLElement),
	resizeHandle: byId('resize', HTMLElement),
	plusButton: byId('plus', HTMLButtonElement),
	plusMenu: byId('plus-menu', HTMLElement),
	usageRing: byId('usage-ring', HTMLButtonElement),
	followed: byId('followed', HTMLElement),
	usagePopover: byId('usage-popover', HTMLElement),
	writeTab: byId('tab-write', HTMLButtonElement),
	previewTab: byId('tab-preview', HTMLButtonElement),
	preview: byId('preview', HTMLElement),
	picker: byId('picker', HTMLElement),
	attachmentList: byId('attachments', HTMLElement),
	queueList: byId('queue', HTMLElement),
	branchButton,
	branchLabel: within(branchButton, 'span', HTMLSpanElement),
	commitButton,
	commitLabel: within(commitButton, 'span', HTMLSpanElement),
	commitMore: byId('commit-more', HTMLButtonElement),
	commitMenu: byId('commit-menu', HTMLElement),
	commitBox: byId('commit-box', HTMLElement),
	workspaceButton,
	workspaceLabel: within(workspaceButton, 'span', HTMLSpanElement),
	reviewChip,
	reviewLabel: within(reviewChip, 'span', HTMLSpanElement),
	branchMenu: byId('branch-menu', HTMLElement),
	workspaceMenu: byId('workspace-menu', HTMLElement),
	repos: byId('repos', HTMLElement),
	reposMenu: byId('repos-menu', HTMLElement),
	scrollButton: byId('scroll-down', HTMLButtonElement),
	scrollLabel: within(byId('scroll-down', HTMLButtonElement), '.scroll-down-label', HTMLSpanElement),
	/** The working strip, status and composer, under the transcript. */
	dock: byId('dock', HTMLElement),
	dropLabel: byId('drop-label', HTMLElement),
	enhanceRow: byId('enhance-row', HTMLElement),
	enhanceFloat: byId('enhance-float', HTMLElement),
	enhanceButton,
	enhanceLabel: within(enhanceButton, 'span', HTMLSpanElement),
	revertButton,
	revertLabel: within(revertButton, 'span', HTMLSpanElement),
	enhanceNote: byId('enhance-note', HTMLElement),
	inputWrap: parentOf(byId('input', HTMLTextAreaElement)),
};

const noSettings: SessionSettings = {};

/** The view's state, shared by its modules. */
export const state = {
	/** The transcript, as the extension last sent it. */
	items: [] as TranscriptItem[],
	busy: false,
	/** What the next prompt sends along. */
	attachments: [] as Attachment[],
	/** Messages sent while the agent works that have not gone yet, oldest first. */
	queue: [] as PendingPromptView[],
	/** Team tool items (toolRefId) whose chip the user removed, so typing on doesn't bring them back. */
	dismissedToolRefs: new Set<string>(),
	/** The page shared with the agent, pinned to the composer; every prompt tells the agent about it. */
	sharedPage: undefined as SharedPageView | undefined,
	/** Whether the agent takes images, so pasted ones are sent as images. */
	imageInput: false,
	/** Whether a rewrite of the draft is running; the draft cannot be sent meanwhile. */
	enhancing: false,
	/** The session's mode and model choices. */
	settings: noSettings,
	/** Whether the chat opens each file the agent reads or edits. */
	following: false,
	/** Whether each turn's steps fold under one line once it is done (`gemini.chat.foldFinishedWork`). */
	foldWork: document.querySelector<HTMLScriptElement>('script[data-strings]')?.dataset.foldWork !== 'false',
	/** Whether replies offer reactions (`gemini.chat.reactions.enabled`); never in a project's chat. */
	reactions: document.querySelector<HTMLScriptElement>('script[data-strings]')?.dataset.reactions === 'true',
	/** Whether this chat has /research: every chat but a project's. */
	research: document.querySelector<HTMLScriptElement>('script[data-strings]')?.dataset.research === 'true',
	/** The picker's Recent row, newest first. */
	recents: [] as readonly string[],
	/** The meanings people gave emoji in `gemini.chat.reactions.meanings`. */
	meanings: [] as readonly (readonly [string, string])[],
	/** `gemini.chat.sendWith` is cmdEnter: ⌘Return (Ctrl+Enter) sends, Return makes a new line. */
	cmdEnter: false,
	/** The mode the mode menu tags "Recommended here" for this folder. */
	recommendMode: undefined as string | undefined,
};

/** Each item's element in the transcript. */
export const elements = new Map<string, HTMLElement>();
/** When each thought started and, once something followed it, ended. Lost when the view reloads. */
export const thoughtTimes = new Map<string, { start: number; end?: number }>();
/** When each subagent call was first seen working and when it finished, for its duration. Lost when the view reloads. */
export const subagentTimes = new Map<string, { start: number; end?: number }>();
/** Tool calls the user expanded, kept across re-renders. */
export const expanded = new Set<string>();
/** Turns' folds the user opened or closed, by their prompt's id; the rest follow the turn. Lost when the view reloads. */
export const foldOpen = new Map<string, boolean>();
/** Runs of steps the user opened or closed, by run id. Lost when the view reloads. */
export const runOpen = new Map<string, boolean>();
/** Failed tool calls whose output was opened for the user once, so closing it sticks. */
export const autoOpened = new Set<string>();
