/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat view's webview. It renders the transcript items the extension
// sends (src/acp/chatTranscript.ts) and posts prompts back. This module starts
// the view and handles the extension's messages; the others do the work:
//   transcript.ts      the items shown and the scroll position
//   items.ts           rendering each kind of item
//   streamingReply.ts  updating a reply while it streams
//   composer.ts        sending, the mode chip, the foot buttons and status line
//   inputBox.ts        the input's height, placeholder and send button
//   attachmentChips.ts attachments, and files pasted or dropped
//   picker.ts          the @-mention file picker and the slash command menu
//   enhance.ts         Enhance prompt: rewriting the draft as a precise prompt
//   menu.ts            the pop-up list the menus share
//   plusMenu.ts        the "+" menu: mode, files, context, follow, model, usage
//   pickers.ts         the model, branch and folder menus
//   usage.ts           the context ring and usage popover: context, quota and tokens
//   project.ts         a project chat's New thread dialog and side panel
//   projectSettings.ts a project chat's settings popup (settingsLogic.ts holds its state)

import type { ItemUpdate } from '../src/acp/textDeltas';
import { chatProtocolVersion, type ToWebview } from '../src/host/chatProtocol';
import { coalesceUpdates } from './chatLogic';
import { addAttachments } from './attachmentChips';
import { setBusy, setFollow, setFollowed, setGit, setSettings, setStatus } from './composer';
import { applyTokenColors } from './codeHighlight';
import { onEnhanced, onEnhanceFailed, onEnhanceProgress, toggleEnhance } from './enhance';
import { setLabel } from './dom';
import { restoreComposerHeight, updatePlaceholder, updateSendState } from './inputBox';
import { showSavedSessions } from './items';
import { setBranches } from './pickers';
import { showCommands, showFiles } from './picker';
import { openNewThread, showParentProject, showProjectPanel } from './project';
import { pickedRepository, showProjectSettings } from './projectSettings';
import { updateOutline } from './promptNav';
import { appended, applyItem, isNearBottom, reset, settleScroll, updateWorking } from './transcript';
import { showContext, showQuota, toggleUsage, updateUsage } from './usage';
import { state, strings, ui, vscode } from './view';

setLabel(ui.sendButton, strings.send);
setLabel(ui.stopButton, strings.stop);
setLabel(ui.scrollButton, strings.scrollToBottom);
ui.scrollLabel.textContent = strings.latest;
ui.dropLabel.textContent = strings.dropFiles;

/**
 * Updates that came while the view was hidden. An agent's tab keeps its view
 * when hidden, and rendering every streamed chunk there would cost as much as
 * in the tab in front; they are rendered together when it shows.
 */
let hiddenUpdates: ItemUpdate[] = [];
/** The host says the view's tab or pane is out of sight; `document.hidden` covers a hidden window. */
let tabHidden = false;

function isHidden(): boolean {
	return tabHidden || document.hidden;
}

/** Nothing animates while the view is hidden, and updates kept meanwhile render once it shows. */
function onVisibility(): void {
	document.body.classList.toggle('paused', isHidden());
	if (!isHidden() && hiddenUpdates.length) {
		const updates = coalesceUpdates(hiddenUpdates);
		hiddenUpdates = [];
		applyUpdates(updates);
	}
}

document.addEventListener('visibilitychange', onVisibility);

function applyUpdates(updates: readonly ItemUpdate[]): void {
	const stick = isNearBottom();
	let scroll = stick;
	for (const update of updates) {
		const item = update.kind === 'append' ? appended(update) : update;
		if (item) {
			scroll = applyItem(item, true) || scroll;
		}
	}
	updateWorking();
	settleScroll(scroll);
	// Only a prompt changes the outline; streamed replies, thoughts and tool calls do not.
	if (updates.some(update => update.kind === 'user')) {
		updateOutline();
	}
	if (updates.some(update => update.kind === 'turnEnd')) {
		updateUsage();
	}
	updatePlaceholder();
}

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
	const message = event.data;
	switch (message.type) {
		case 'spellCheck':
			ui.input.spellcheck = message.on;
			break;
		case 'reset':
			// The reset carries every item as it is now.
			hiddenUpdates = [];
			state.busy = message.busy;
			reset(message.items);
			updateOutline();
			updatePlaceholder();
			setBusy(message.busy);
			setStatus(message.status);
			setSettings(message.settings);
			updateUsage();
			// After the next frame is drawn: an agent reopened from its saved chat reopens its session then.
			requestAnimationFrame(() => setTimeout(() => vscode.postMessage({ type: 'shown' })));
			break;
		case 'visibility':
			tabHidden = message.hidden;
			onVisibility();
			break;
		case 'items':
			if (isHidden()) {
				hiddenUpdates.push(...message.items);
			} else {
				applyUpdates(message.items);
			}
			break;
		case 'busy':
			setBusy(message.busy);
			break;
		case 'status':
			setStatus(message.status);
			break;
		case 'settings':
			setSettings(message.settings);
			break;
		case 'capabilities':
			state.imageInput = message.image;
			break;
		case 'composerHeight':
			restoreComposerHeight(message.height);
			break;
		case 'follow':
			setFollow(message.on);
			break;
		case 'followed':
			setFollowed(message.file);
			break;
		case 'tokenColors':
			applyTokenColors(message.colors);
			break;
		case 'sessions':
			showSavedSessions(message.sessions, message.total, message.retention);
			break;
		case 'commands':
			showCommands(message.commands);
			break;
		case 'files':
			showFiles(message.requestId, message.files);
			break;
		case 'attach':
			addAttachments(message.attachments);
			break;
		case 'git':
			setGit(message.git);
			break;
		case 'branches':
			setBranches(message.branches, message.notice);
			break;
		case 'enhanceRequested':
			if (!state.enhancing) {
				toggleEnhance();
			}
			break;
		case 'enhanceProgress':
			onEnhanceProgress(message.requestId, message.text);
			break;
		case 'enhanced':
			onEnhanced(message.requestId, message.text);
			break;
		case 'enhanceFailed':
			onEnhanceFailed(message.requestId, message.message);
			break;
		case 'quota':
			showQuota(message.quota);
			break;
		case 'context':
			showContext(message.context);
			break;
		case 'toggleUsage':
			toggleUsage();
			break;
		case 'projectPanel':
			showProjectPanel(message.panel);
			break;
		case 'openNewThread':
			openNewThread();
			break;
		case 'projectSettings':
			showProjectSettings(message.settings, message.open);
			break;
		case 'pickedRepository':
			pickedRepository(message.repo);
			break;
		case 'parentProject':
			showParentProject(message.parent);
			break;
		case 'focus':
			// Not from under an open popup, such as Project settings or New thread.
			if (!document.querySelector('dialog[open]')) {
				ui.input.focus();
			}
			break;
	}
});

vscode.postMessage({ type: 'ready', protocol: chatProtocolVersion });
updateSendState();
ui.input.focus();
