/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Preview Markdown: a panel above the composer's input that shows the draft
// as it will look once sent. The input stays as it is, so @-mentions, the /
// menu, paste and IME typing work the same with the preview open. It renders
// only while open, at most once a frame.

import { format } from './chatLogic';
import { setLabel } from './dom';
import { renderUserMarkdown } from './items';
import { strings, ui } from './view';

const { input, preview, previewBody, previewButton } = ui;
const mac = /Mac/.test(navigator.platform);

let open = false;
let frame = 0;

ui.previewLabel.textContent = strings.previewLabel;
setLabel(previewButton, format(strings.previewMarkdown, mac ? '⇧⌘V' : 'Ctrl+Shift+V'));
previewButton.setAttribute('aria-pressed', 'false');
previewButton.addEventListener('click', () => {
	togglePreview();
	input.focus();
});
input.addEventListener('input', updatePreview);

export function togglePreview(): void {
	open = !open;
	previewButton.classList.toggle('active', open);
	previewButton.setAttribute('aria-pressed', String(open));
	updatePreview();
}

/** ⇧⌘V (Ctrl+Shift+V on Windows and Linux) toggles the preview, as for Markdown files in the editor. */
export function isPreviewShortcut(event: KeyboardEvent): boolean {
	return event.code === 'KeyV' && event.shiftKey && !event.altKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

/** Shows the draft as it will look; call after changing the input's text without an input event. */
export function updatePreview(): void {
	if (!open) {
		preview.hidden = true;
		return;
	}
	if (!frame) {
		frame = requestAnimationFrame(() => {
			frame = 0;
			const text = input.value;
			preview.hidden = !open || !text.trim();
			if (!preview.hidden) {
				previewBody.replaceChildren(...renderUserMarkdown(text));
			}
		});
	}
}
