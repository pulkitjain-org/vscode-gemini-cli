/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat view's webview. It renders the transcript items the extension
// sends (src/acp/chatTranscript.ts) and posts prompts back. This module starts
// the view and handles the extension's messages; the others do the work:
//   transcript.ts      the items shown and the scroll position
//   items.ts           rendering each kind of item
//   work.ts            a turn's fold: its steps under one line (workFold.ts decides what folds)
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
//   runButtons.ts      Run on a reply's shell blocks, and how the command ended

import type { ItemUpdate } from '../src/acp/textDeltas';
import { chatProtocolVersion, type ToWebview } from '../src/host/chatProtocol';
import { format, HeldUpdates } from './chatLogic';
import { addAttachments, setSharedPage } from './attachmentChips';
import { attachToolRef, setToolRefContext, toolRefResolved, watchToolRefs } from './toolChips';
import { setBusy, setFollow, setFollowed, setGit, setSendWith, setSettings, setStatus, setTriedEdits } from './composer';
import { setQueue, setSteerWaiting } from './queueStrip';
import { initReactionBar } from './reactionBar';
import { applyTokenColors } from './codeHighlight';
import { onEnhanced, onEnhanceFailed, onEnhanceProgress, replaceInput, toggleEnhance } from './enhance';
import { openForkDialog } from './fork';
import { setLabel } from './dom';
import { restoreComposerHeight, updatePlaceholder, updateSendState } from './inputBox';
import { answerFromComposer, showFullOutput, showSavedSessions } from './items';
import { commitDone, setBranches, setCommitMessage } from './pickers';
import { showCommands, showFiles } from './picker';
import { updatePlusMenu } from './plusMenu';
import { openNewThread, showParentProject, showProjectPanel } from './project';
import { pickedRepository, showProjectSettings } from './projectSettingsLoader';
import { onSide } from './sideChatLoader';
import { setRunState, setRunView } from './runButtons';
import { updateOutline } from './promptNav';
import { setSideLinks } from './sideLinks';
import { appended, applyItem, isNearBottom, reset, setFoldWork, setStall, settleScroll, updateWorking } from './transcript';
import { showBreakdown, showContext, showQuota, toggleUsage, updateUsage } from './usage';
import { state, strings, ui, vscode } from './view';

setLabel(ui.sendButton, strings.send);
setLabel(ui.stopButton, strings.stop);
setLabel(ui.scrollButton, strings.scrollToBottom);
ui.scrollLabel.textContent = strings.latest;
ui.dropLabel.textContent = strings.dropFiles;
initReactionBar();

/**
 * Updates that came while the view was hidden. An agent's tab keeps its view
 * when hidden, and rendering every streamed chunk there would cost as much as
 * in the tab in front; they are merged as they come, and rendered together
 * when it shows.
 */
const hiddenUpdates = new HeldUpdates();
/** The host says the view's tab or pane is out of sight; `document.hidden` covers a hidden window. */
let tabHidden = false;

function isHidden(): boolean {
	return tabHidden || document.hidden;
}

/** Nothing animates while the view is hidden, and updates kept meanwhile render once it shows. */
function onVisibility(): void {
	document.body.classList.toggle('paused', isHidden());
	if (!isHidden() && hiddenUpdates.size) {
		applyUpdates(hiddenUpdates.take());
	}
}

document.addEventListener('visibilitychange', onVisibility);

function applyUpdates(updates: readonly ItemUpdate[]): void {
	const stick = isNearBottom();
	let scroll = stick;
	for (const update of updates) {
		const item = update.kind === 'append' ? appended(update) : update;
		if (item?.kind === 'user' && item.agentReaction && strings.reactions) {
			const before = state.items.find(other => other.id === item.id);
			if (before?.kind === 'user' && !before.agentReaction) {
				ui.announce.textContent = format(strings.reactions.agentReacted, item.agentReaction);
			}
		}
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
		case 'foldWork':
			setFoldWork(message.on);
			updateOutline();
			break;
		case 'reactions':
			state.recents = message.recents;
			state.meanings = message.meanings;
			if (state.reactions !== message.on) {
				state.reactions = message.on;
				reset(state.items.slice());
			}
			break;
		case 'reset':
			// The reset carries every item as it is now.
			hiddenUpdates.clear();
			state.busy = message.busy;
			reset(message.items);
			updateOutline();
			updatePlaceholder();
			setBusy(message.busy);
			setStall(message.stall);
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
				message.items.forEach(update => hiddenUpdates.add(update));
			} else {
				applyUpdates(message.items);
			}
			break;
		case 'busy':
			setBusy(message.busy);
			break;
		case 'queue':
			setQueue(message.items);
			break;
		case 'triedEdits':
			setTriedEdits(message.files);
			break;
		case 'steerWaiting':
			setSteerWaiting(message.waiting);
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
			showFiles(message.requestId, message.files, message.mentions ?? []);
			break;
		case 'attach':
			addAttachments(message.attachments);
			break;
		case 'toolRefs':
			setToolRefContext(message.context);
			break;
		case 'toolRefResolved':
			toolRefResolved(message.attachment);
			break;
		case 'attachToolRef':
			attachToolRef(message.ref);
			break;
		case 'sharedPage':
			setSharedPage(message.page);
			break;
		case 'sideLinks':
			setSideLinks(message.links);
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
		case 'draft':
			replaceInput(message.text);
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
			toggleUsage(message.open);
			break;
		case 'contextBreakdown':
			showBreakdown(message.breakdown);
			break;
		case 'commitMessage':
			setCommitMessage(message.message);
			break;
		case 'commitDone':
			commitDone(message.ok);
			break;
		case 'sendWith':
			setSendWith(message.cmdEnter);
			break;
		case 'projectPanel':
			showProjectPanel(message.panel);
			// An open "+" menu's Plan first switch follows the project's settings.
			updatePlusMenu();
			break;
		case 'openNewThread':
			openNewThread();
			break;
		case 'openFork':
			openForkDialog(message.fork);
			break;
		case 'side':
			onSide(message);
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
		case 'run':
			setRunView(message.run);
			break;
		case 'runState':
			setRunState(message.text, message.state);
			break;
		case 'stall':
			setStall(message.stall);
			break;
		case 'output':
			showFullOutput(message.itemId, message.part, message.text);
			break;
		case 'focus':
			// Not from under an open popup, such as Project settings or New thread.
			if (!document.querySelector('dialog[open]')) {
				ui.input.focus();
			}
			break;
		default:
			// A message this script does not know: the host and the webview bundle are out of step (chatProtocolVersion).
			console.warn(`Chat: unknown message ${String((message as { type?: unknown }).type)}`);
	}
});

// Before the composer's own keys, and so the workbench never sees them (⌥⌘S is its Save All): a waiting card's answers.
window.addEventListener('keydown', event => {
	if (answerFromComposer(event)) {
		event.preventDefault();
		event.stopPropagation();
	}
}, true);

watchToolRefs(ui.input);
vscode.postMessage({ type: 'ready', protocol: chatProtocolVersion });
updateSendState();
ui.input.focus();
