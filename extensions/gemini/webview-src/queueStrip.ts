/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The messages sent while the agent works, as a strip above the input: each
// queued one waits for the turn to end, and one sent now waits for the
// current step. Each can be sent now, taken back to edit, or removed. A
// thread's coordinator queues its notes here too; in a project's chat every
// message waits for the coordinator's turn, which is never stopped for one.

import type { PendingPromptView } from '../src/acp/promptQueue';
import { format } from './chatLogic';
import { button, el, icon, setLabel, setTip } from './dom';
import { state, strings, ui, vscode } from './view';

const { queueList } = ui;

export function setQueue(items: readonly PendingPromptView[]): void {
	state.queue = [...items];
	renderQueue();
}

/** Draws the strip again, as when the agent stops working. */
export function renderQueue(): void {
	queueList.hidden = !state.queue.length;
	queueList.replaceChildren(...state.queue.map(row));
}

function row(item: PendingPromptView): HTMLElement {
	const node = el('div', `queue-item${item.steer ? ' steer' : ''}${item.from ? ' from-coordinator' : ''}`);
	node.setAttribute('role', 'listitem');
	const status = item.steer ? strings.steering : strings.project?.queued ?? (item.from ? strings.queuedFromCoordinator : strings.queued);
	const reacted = (item.reactions ?? []).map(reaction => strings.reactions ? format(strings.reactions.queued, reaction.emoji) : reaction.emoji).join(' ');
	const line = item.text.split('\n').map(part => part.trim()).find(Boolean) ?? reacted;
	const text = el('span', 'queue-text', line);
	setTip(text, item.text || reacted);
	const parts: HTMLElement[] = [icon(item.steer ? 'loading' : 'clock', item.steer ? 'codicon-modifier-spin' : ''), el('span', 'queue-status', status), text];
	if (item.attachments) {
		parts.push(el('span', 'queue-attached', format(strings.queueAttached, String(item.attachments))));
	}
	const actions = el('span', 'queue-actions');
	if (!item.steer && !(strings.project && state.busy)) {
		actions.append(action(strings.queueSendNow, 'arrow-up', item.id, 'send'));
	}
	if (item.text) {
		// A reaction has no text to take back into the box.
		actions.append(action(strings.queueEdit, 'edit', item.id, 'edit'));
	}
	actions.append(action(strings.queueRemove, 'close', item.id, 'remove'));
	node.append(...parts, actions);
	node.setAttribute('aria-label', `${status}: ${item.text || reacted}`);
	return node;
}

function action(label: string, iconName: string, id: string, kind: 'send' | 'edit' | 'remove'): HTMLButtonElement {
	const node = button('queue-action', '', () => {
		vscode.postMessage({ type: 'queueAction', id, action: kind });
		if (kind !== 'send') {
			ui.input.focus();
		}
	}, iconName);
	setLabel(node, label);
	return node;
}

/** Takes the newest queued message back into the empty box to edit; false when nothing waits. */
export function editLastQueued(): boolean {
	// A reaction has no text to edit, so it is passed over.
	const last = state.queue.findLast(item => item.text);
	if (!last) {
		return false;
	}
	vscode.postMessage({ type: 'queueAction', id: last.id, action: 'edit' });
	return true;
}
