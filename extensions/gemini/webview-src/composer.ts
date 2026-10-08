/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The composer: sending a prompt, the mode and model selects, the git pills
// and the status line above it.

import type { SessionSelector, SessionSettings } from '../src/acp/sessionSettings';
import type { ViewGit, ViewStatus } from '../src/host/chatProtocol';
import { renderAttachments } from './attachmentChips';
import { format } from './chatLogic';
import { button, el, icon, setLabel } from './dom';
import { autoGrow, updateSendState } from './inputBox';
import { onEnhanceKey } from './enhance';
import { continueList, formatShortcut, toggleWrap, type TextEdit } from './markdownEdit';
import { closePreview, isPreviewShortcut, togglePreview, updatePreview } from './markdownPreview';
import { closePicker, onPickerKey, updatePicker } from './picker';
import { modeIcon, openPlusMenu, updatePlusMenu } from './plusMenu';
import { setTranscriptBusy } from './transcript';
import { state, strings, ui, vscode } from './view';

const { form, input, status, modelSelect, branchButton, commitButton } = ui;
const mac = /Mac/.test(navigator.platform);

export function setBusy(value: boolean): void {
	ui.stopButton.hidden = !value;
	ui.sendButton.hidden = value;
	form.classList.toggle('busy', value);
	if (!value && document.activeElement === ui.stopButton) {
		input.focus();
	}
	if (!value && state.busy !== value) {
		ui.announce.textContent = strings.replyFinished;
	} else if (value) {
		ui.announce.textContent = '';
	}
	setTranscriptBusy(value);
	updateSendState();
}

export function setStatus(value: ViewStatus): void {
	status.className = `status ${value.phase}`;
	status.replaceChildren();
	if (value.text) {
		if (value.phase === 'error') {
			status.append(icon('warning'));
		} else if (value.phase === 'starting' || value.phase === 'restarting') {
			status.append(icon('loading', 'codicon-modifier-spin'));
		}
		status.append(el('span', 'status-text', value.text));
		for (const action of value.actions ?? []) {
			status.append(button('status-action', action.label, () => vscode.postMessage({ type: 'command', command: action.command })));
		}
	}
	status.hidden = !value.text;
}

const measureContext = document.createElement('canvas').getContext('2d');

/** A select is as wide as its longest option; size it to the chosen one instead. */
function fitSelect(select: HTMLSelectElement): void {
	const text = select.selectedOptions[0]?.textContent ?? '';
	const style = getComputedStyle(select);
	if (!measureContext) {
		return;
	}
	measureContext.font = style.font;
	const chrome = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
	select.style.width = `${Math.ceil(measureContext.measureText(text).width + chrome)}px`;
}

function fillSelect(select: HTMLSelectElement, wrap: HTMLElement, selector: SessionSelector | undefined): void {
	wrap.hidden = !selector;
	if (!selector) {
		return;
	}
	select.replaceChildren(...selector.available.map(choice => {
		const option = el('option', undefined, choice.name);
		option.value = choice.id;
		if (choice.description) {
			option.title = choice.description;
		}
		return option;
	}));
	select.value = selector.currentId;
	fitSelect(select);
	const current = selector.available.find(choice => choice.id === selector.currentId);
	select.title = current?.description ? `${select.getAttribute('aria-label')}: ${current.description}` : select.getAttribute('aria-label') ?? '';
}

export function setSettings(settings: SessionSettings): void {
	state.settings = settings;
	fillSelect(modelSelect, ui.modelWrap, settings.model);
	updateModeChip();
	updatePlusMenu();
}

/** A mode other than the first (the agent's default) shows as a chip beside "+"; its × goes back to the default. */
function updateModeChip(): void {
	const mode = state.settings.mode;
	const current = mode?.available.find(choice => choice.id === mode.currentId);
	const base = mode?.available[0];
	ui.modeChip.hidden = !current || !base || current.id === base.id;
	if (ui.modeChip.hidden || !current || !base) {
		return;
	}
	ui.modeChip.dataset.mode = current.id;
	ui.modeChipLabel.querySelector('.codicon')!.className = `codicon codicon-${modeIcon(current.id)}`;
	ui.modeChipLabel.querySelector('span')!.textContent = current.name;
	setLabel(ui.modeChipLabel, format(strings.modeChip, current.description ? `${current.name}: ${current.description}` : current.name));
	setLabel(ui.modeChipReset, format(strings.modeChipReset, base.name));
}

export function setGit(git: ViewGit): void {
	branchButton.hidden = !git.branch;
	ui.branchLabel.textContent = git.branch ?? '';
	const branchLabel = format(strings.switchBranch, git.branch ?? '');
	branchButton.title = branchLabel;
	branchButton.setAttribute('aria-label', branchLabel);
	commitButton.hidden = !git.canCommit || !git.branch;
	const workspace = git.workspace;
	ui.workspaceButton.hidden = !workspace;
	if (workspace) {
		ui.workspaceLabel.textContent = workspace.worktree ? `${workspace.name} \u00b7 ${strings.worktree}` : workspace.name;
		setLabel(ui.workspaceButton, format(strings.workspaceTooltip, workspace.path));
	}
	ui.commitLabel.textContent = strings.commit;
	commitButton.title = strings.createBranchAndCommit;
	commitButton.setAttribute('aria-label', strings.createBranchAndCommit);
}

/** Follow the agent: whether the chat opens each file the agent reads or edits; a switch in the "+" menu. */
export function setFollow(on: boolean): void {
	state.following = on;
	updatePlusMenu();
}

const followedName = ui.followed.querySelector<HTMLButtonElement>('.followed-name')!;
const followedClose = ui.followed.querySelector<HTMLButtonElement>('.followed-close')!;
followedName.addEventListener('click', () => vscode.postMessage({ type: 'showFollowed' }));
followedClose.addEventListener('click', () => vscode.postMessage({ type: 'closeFollowed' }));

/** Names the file Follow the agent opened last, with a button to close it, while it is open. */
export function setFollowed(file: { readonly name: string; readonly path: string } | undefined): void {
	ui.followed.hidden = !file;
	if (file) {
		followedName.querySelector('span')!.textContent = file.name;
		setLabel(followedName, format(strings.followedFile, file.path));
		setLabel(followedClose, format(strings.closeFollowed, file.name));
	}
}

/** Prompts sent from this view, newest last, for Up and Down in an empty input. */
const sent: string[] = [];
let recalled = -1;

/** Up or Down at the edge of the input steps through earlier prompts, as in a terminal. */
function recall(event: KeyboardEvent): boolean {
	const up = event.key === 'ArrowUp';
	if ((!up && event.key !== 'ArrowDown') || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || !sent.length) {
		return false;
	}
	const browsing = recalled >= 0 && input.value === sent[recalled];
	if (!browsing && input.value) {
		return false;
	}
	if (up) {
		recalled = browsing ? Math.max(0, recalled - 1) : sent.length - 1;
	} else if (!browsing) {
		return false;
	} else {
		recalled++;
	}
	input.value = recalled < sent.length ? sent[recalled] : '';
	if (recalled >= sent.length) {
		recalled = -1;
	}
	autoGrow();
	updateSendState();
	updatePreview();
	return true;
}

/** ⌘B and ⌘E wrap the selection in bold or code, as does typing ` over a selection; Shift+Enter continues a list. */
function onMarkdownKey(event: KeyboardEvent): boolean {
	const { selectionStart: start, selectionEnd: end, value } = input;
	const marker = formatShortcut(event, mac) ?? (event.key === '`' && start !== end && !event.metaKey && !event.ctrlKey && !event.altKey ? '`' : undefined);
	if (marker) {
		applyEdit(toggleWrap(value, start, end, marker));
		return true;
	}
	if (event.key === 'Enter' && event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && start === end) {
		const edit = continueList(value, start);
		if (edit) {
			applyEdit(edit);
			return true;
		}
	}
	return false;
}

/** Applies an edit as one step the user can undo. */
function applyEdit(edit: TextEdit): void {
	input.setSelectionRange(edit.start, edit.end);
	// insertText keeps the textarea's undo history; setRangeText would not.
	const done = edit.text ? document.execCommand('insertText', false, edit.text) : edit.start === edit.end || document.execCommand('delete');
	if (!done) {
		input.setRangeText(edit.text, edit.start, edit.end);
		input.dispatchEvent(new Event('input'));
	}
	input.setSelectionRange(edit.selectionStart, edit.selectionEnd);
}

function submit(): void {
	const text = input.value;
	if (state.busy || state.enhancing || (!text.trim() && !state.attachments.length)) {
		return;
	}
	if (text.trim() && sent[sent.length - 1] !== text) {
		sent.push(text);
	}
	recalled = -1;
	vscode.postMessage({ type: 'prompt', text, attachments: state.attachments });
	state.attachments = [];
	renderAttachments();
	closePicker();
	input.value = '';
	autoGrow();
	updateSendState();
	closePreview();
}

form.addEventListener('submit', event => {
	event.preventDefault();
	submit();
});
form.addEventListener('click', event => {
	if (event.target === form) {
		input.focus();
	}
});
input.addEventListener('keydown', event => {
	if (!event.isComposing && onPickerKey(event)) {
		event.preventDefault();
		event.stopPropagation();
		return;
	}
	if (!event.isComposing && onEnhanceKey(event)) {
		event.preventDefault();
		event.stopPropagation();
		return;
	}
	if (event.key === 'Escape' && state.busy) {
		event.preventDefault();
		vscode.postMessage({ type: 'stop' });
		return;
	}
	if (!event.isComposing && isPreviewShortcut(event)) {
		event.preventDefault();
		event.stopPropagation();
		togglePreview();
		return;
	}
	if (!event.isComposing && onMarkdownKey(event)) {
		event.preventDefault();
		event.stopPropagation();
		return;
	}
	if (!event.isComposing && recall(event)) {
		event.preventDefault();
		return;
	}
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		submit();
	}
});
input.addEventListener('input', () => {
	autoGrow();
	updateSendState();
	updatePicker();
});
input.addEventListener('click', updatePicker);
input.addEventListener('blur', () => setTimeout(() => {
	if (document.activeElement !== input) {
		closePicker();
	}
}, 0));
ui.stopButton.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
branchButton.addEventListener('click', () => vscode.postMessage({ type: 'pickBranch' }));
ui.workspaceButton.addEventListener('click', () => vscode.postMessage({ type: 'workspaceMenu' }));
commitButton.addEventListener('click', () => vscode.postMessage({ type: 'createBranchAndCommit' }));
ui.modeChipLabel.addEventListener('click', () => openPlusMenu());
ui.modeChipReset.addEventListener('click', () => {
	const base = state.settings.mode?.available[0];
	if (base) {
		vscode.postMessage({ type: 'setMode', id: base.id });
	}
	input.focus();
});
modelSelect.addEventListener('change', () => {
	fitSelect(modelSelect);
	vscode.postMessage({ type: 'setModel', id: modelSelect.value });
});
