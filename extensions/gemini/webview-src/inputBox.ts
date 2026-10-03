/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The composer's input: its height, which the user can drag, its placeholder
// and whether it can be sent. The attachments and the picker use these too.

import { draggedHeight, restoredHeight } from './chatLogic';
import { state, strings, ui, vscode } from './view';

const { input, resizeHandle, sendButton } = ui;

/** Height the user dragged the composer to; the input never gets shorter than this. */
let userHeight = 0;

/**
 * Applies the dragged height. The input grows with its text by itself (CSS
 * field-sizing), so typing never measures it, which would lay out the whole
 * transcript on every keystroke.
 */
export function autoGrow(): void {
	input.style.minHeight = userHeight ? `${userHeight}px` : '';
	// It grows with its text to 40% of the view, or further if dragged taller.
	input.style.maxHeight = userHeight ? `max(40vh, ${userHeight}px)` : '';
}

/** Applies the height remembered from an earlier drag. */
export function restoreComposerHeight(height: number): void {
	userHeight = restoredHeight(height, window.innerHeight);
	autoGrow();
}

export function updateSendState(): void {
	sendButton.disabled = state.busy || (!input.value.trim() && !state.attachments.length);
}

export function updatePlaceholder(): void {
	input.placeholder = state.items.some(item => item.kind === 'user') ? strings.placeholderFollowUp : strings.placeholder;
}

// Dragging the composer's top edge resizes the input; a double-click resets it.
resizeHandle.addEventListener('pointerdown', event => {
	event.preventDefault();
	resizeHandle.setPointerCapture(event.pointerId);
	const startY = event.clientY;
	const startHeight = input.getBoundingClientRect().height;
	let moved = false;
	const onMove = (move: PointerEvent) => {
		moved = true;
		userHeight = draggedHeight(startHeight, startY, move.clientY, window.innerHeight);
		autoGrow();
	};
	const onUp = () => {
		resizeHandle.removeEventListener('pointermove', onMove);
		resizeHandle.removeEventListener('pointerup', onUp);
		resizeHandle.removeEventListener('pointercancel', onUp);
		input.focus();
		if (moved) {
			// Remembered for every chat, also after a restart.
			vscode.postMessage({ type: 'composerHeight', height: userHeight });
		}
	};
	resizeHandle.addEventListener('pointermove', onMove);
	resizeHandle.addEventListener('pointerup', onUp);
	resizeHandle.addEventListener('pointercancel', onUp);
});
resizeHandle.addEventListener('dblclick', () => {
	userHeight = 0;
	autoGrow();
	vscode.postMessage({ type: 'composerHeight', height: 0 });
});
