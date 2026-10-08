/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the chat view's modules share: the host API, the localized strings,
// the page's fixed elements (found once, at startup) and the view's state.

import type { Attachment } from '../src/acp/attachments';
import type { TranscriptItem } from '../src/acp/chatTranscript';
import type { ChatStrings, FromWebview } from '../src/host/chatProtocol';

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

const modeSelect = byId('mode', HTMLSelectElement);
const modelSelect = byId('model', HTMLSelectElement);
const branchButton = byId('branch', HTMLButtonElement);
const commitButton = byId('commit', HTMLButtonElement);
const enhanceButton = byId('enhance', HTMLButtonElement);
const revertButton = byId('revert', HTMLButtonElement);
const workspaceButton = byId('workspace', HTMLButtonElement);

export const ui = {
	transcript: byId('transcript', HTMLElement),
	outline: byId('outline', HTMLElement),
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
	modeSelect,
	modeWrap: parentOf(modeSelect),
	modelSelect,
	modelWrap: parentOf(modelSelect),
	resizeHandle: byId('resize', HTMLElement),
	mentionButton: byId('mention', HTMLButtonElement),
	followButton: byId('follow', HTMLButtonElement),
	usageButton: byId('usage', HTMLButtonElement),
	usagePopover: byId('usage-popover', HTMLElement),
	writeTab: byId('tab-write', HTMLButtonElement),
	previewTab: byId('tab-preview', HTMLButtonElement),
	preview: byId('preview', HTMLElement),
	picker: byId('picker', HTMLElement),
	attachmentList: byId('attachments', HTMLElement),
	branchButton,
	branchLabel: within(branchButton, 'span', HTMLSpanElement),
	commitButton,
	commitLabel: within(commitButton, 'span', HTMLSpanElement),
	workspaceButton,
	workspaceLabel: within(workspaceButton, 'span', HTMLSpanElement),
	attachButton: byId('attach', HTMLButtonElement),
	scrollButton: byId('scroll-down', HTMLButtonElement),
	scrollLabel: within(byId('scroll-down', HTMLButtonElement), '.scroll-down-label', HTMLSpanElement),
	/** The working strip, status and composer; the Glass themes float it over the transcript. */
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

/** The view's state, shared by its modules. */
export const state = {
	/** The transcript, as the extension last sent it. */
	items: [] as TranscriptItem[],
	busy: false,
	/** What the next prompt sends along. */
	attachments: [] as Attachment[],
	/** Whether the agent takes images, so pasted ones are sent as images. */
	imageInput: false,
	/** Whether a rewrite of the draft is running; the draft cannot be sent meanwhile. */
	enhancing: false,
};

/** Each item's element in the transcript. */
export const elements = new Map<string, HTMLElement>();
/** When each thought started and, once something followed it, ended. Lost when the view reloads. */
export const thoughtTimes = new Map<string, { start: number; end?: number }>();
/** Tool calls the user expanded, kept across re-renders. */
export const expanded = new Set<string>();
