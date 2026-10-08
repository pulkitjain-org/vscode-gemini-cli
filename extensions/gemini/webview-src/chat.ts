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

import { chatProtocolVersion, type ToWebview } from '../src/host/chatProtocol';
import { addAttachments } from './attachmentChips';
import { setBusy, setFollow, setFollowed, setGit, setSettings, setStatus } from './composer';
import { applyTokenColors } from './codeHighlight';
import { onEnhanced, onEnhanceFailed, toggleEnhance } from './enhance';
import { setLabel } from './dom';
import { restoreComposerHeight, updatePlaceholder, updateSendState } from './inputBox';
import { showSavedSessions } from './items';
import { setBranches } from './pickers';
import { showCommands, showFiles } from './picker';
import { updateOutline } from './promptNav';
import { appended, applyItem, isNearBottom, reset, settleScroll, updateWorking } from './transcript';
import { showContext, showQuota, toggleUsage, updateUsage } from './usage';
import { state, strings, ui, vscode } from './view';

setLabel(ui.sendButton, strings.send);
setLabel(ui.stopButton, strings.stop);
setLabel(ui.scrollButton, strings.scrollToBottom);
ui.scrollLabel.textContent = strings.latest;
ui.dropLabel.textContent = strings.dropFiles;

// Nothing animates while the view is hidden.
document.addEventListener('visibilitychange', () => document.body.classList.toggle('paused', document.hidden));

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
	const message = event.data;
	switch (message.type) {
		case 'reset':
			state.busy = message.busy;
			reset(message.items);
			updateOutline();
			updatePlaceholder();
			setBusy(message.busy);
			setStatus(message.status);
			setSettings(message.settings);
			updateUsage();
			break;
		case 'items': {
			const stick = isNearBottom();
			let scroll = stick;
			for (const update of message.items) {
				const item = update.kind === 'append' ? appended(update) : update;
				if (item) {
					scroll = applyItem(item, true) || scroll;
				}
			}
			updateWorking();
			settleScroll(scroll);
			// Only a prompt changes the outline; streamed replies, thoughts and tool calls do not.
			if (message.items.some(update => update.kind === 'user')) {
				updateOutline();
			}
			if (message.items.some(update => update.kind === 'turnEnd')) {
				updateUsage();
			}
			updatePlaceholder();
			break;
		}
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
	}
});

vscode.postMessage({ type: 'ready', protocol: chatProtocolVersion });
updateSendState();
ui.input.focus();
