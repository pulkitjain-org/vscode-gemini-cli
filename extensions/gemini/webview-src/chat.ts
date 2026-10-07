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
//   composer.ts        sending, the selects, git pills and status line
//   inputBox.ts        the input's height, placeholder and send button
//   attachmentChips.ts attachments, and files pasted or dropped
//   picker.ts          the @-mention file picker and the slash command menu
//   enhance.ts         Enhance prompt: rewriting the draft as a precise prompt

import { chatProtocolVersion, type ToWebview } from '../src/host/chatProtocol';
import { addAttachments } from './attachmentChips';
import { setBusy, setFollow, setGit, setSettings, setStatus } from './composer';
import { applyTokenColors } from './codeHighlight';
import { onEnhanced, onEnhanceFailed, restyleEnhanceButton, toggleEnhance } from './enhance';
import { applyFontSize, setLabel } from './dom';
import { restoreComposerHeight, updatePlaceholder, updateSendState } from './inputBox';
import { showSavedSessions } from './items';
import { showCommands, showFiles } from './picker';
import { appended, applyItem, isNearBottom, reset, settleScroll, updateWorking } from './transcript';
import { state, strings, ui, vscode } from './view';

setLabel(ui.mentionButton, strings.addContext);
setLabel(ui.attachButton, strings.attachFiles);
setLabel(ui.followButton, strings.followAgent);
setLabel(ui.sendButton, strings.send);
setLabel(ui.stopButton, strings.stop);
setLabel(ui.modeSelect, strings.mode);
setLabel(ui.modelSelect, strings.model);
setLabel(ui.scrollButton, strings.scrollToBottom);
ui.dropLabel.textContent = strings.dropFiles;
applyFontSize(Number(document.body.dataset.fontSize));

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
	const message = event.data;
	switch (message.type) {
		case 'reset':
			state.busy = message.busy;
			reset(message.items);
			updatePlaceholder();
			setBusy(message.busy);
			setStatus(message.status);
			setSettings(message.settings);
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
		case 'accent':
			document.body.dataset.accent = message.solid ? 'solid' : 'gradient';
			break;
		case 'tokenColors':
			applyTokenColors(message.colors);
			break;
		case 'fontSize':
			applyFontSize(message.size);
			restyleEnhanceButton();
			break;
		case 'sessions':
			showSavedSessions(message.sessions, message.total);
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
	}
});

vscode.postMessage({ type: 'ready', protocol: chatProtocolVersion });
updateSendState();
ui.input.focus();
