/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The composer's Write and Preview tabs. Preview shows the draft as it will
// look once sent, in the input's place, so the two never read as one; typing
// goes back to Write. The draft is rendered only when Preview is shown.

import { format } from './chatLogic';
import { renderUserMarkdown } from './items';
import { strings, ui } from './view';

const { input, preview, writeTab, previewTab, form } = ui;
const inputWrap = input.parentElement!;
const mac = /Mac/.test(navigator.platform);

let open = false;

writeTab.textContent = strings.writeLabel;
previewTab.textContent = strings.previewLabel;
previewTab.title = format(strings.previewMarkdown, mac ? '⇧⌘V' : 'Ctrl+Shift+V');
writeTab.addEventListener('click', () => showPreview(false));
previewTab.addEventListener('click', () => showPreview(true));
// Arrow keys move between the tabs, as in any tab list.
for (const tab of [writeTab, previewTab]) {
	tab.addEventListener('keydown', event => {
		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			showPreview(tab === writeTab);
			(tab === writeTab ? previewTab : writeTab).focus();
		}
	});
}
for (const target of [preview, writeTab, previewTab]) {
	target.addEventListener('keydown', event => {
		if (isPreviewShortcut(event)) {
			event.preventDefault();
			togglePreview();
		} else if (target === preview && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
			// Typing in Preview goes back to the draft, keeping the key.
			showPreview(false);
		}
	});
}

export function togglePreview(): void {
	showPreview(!open);
}

/** Back to Write, as after sending. */
export function closePreview(): void {
	if (open) {
		showPreview(false);
	}
}

function showPreview(value: boolean): void {
	if (value) {
		// The preview takes the input's place at the input's height, so nothing below it jumps.
		preview.style.minHeight = `${input.offsetHeight}px`;
	}
	open = value;
	form.classList.toggle('previewing', open);
	writeTab.setAttribute('aria-selected', String(!open));
	previewTab.setAttribute('aria-selected', String(open));
	writeTab.tabIndex = open ? -1 : 0;
	previewTab.tabIndex = open ? 0 : -1;
	inputWrap.hidden = open;
	preview.hidden = !open;
	if (open) {
		updatePreview();
	} else {
		input.focus();
	}
}

/** ⇧⌘V (Ctrl+Shift+V on Windows and Linux) switches between Write and Preview, as for Markdown files in the editor. */
export function isPreviewShortcut(event: KeyboardEvent): boolean {
	return event.code === 'KeyV' && event.shiftKey && !event.altKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

/** Shows the draft as it will look; call after changing the input's text. */
export function updatePreview(): void {
	if (!open) {
		return;
	}
	const text = input.value;
	if (text.trim()) {
		preview.replaceChildren(...renderUserMarkdown(text));
	} else {
		const empty = document.createElement('p');
		empty.className = 'preview-empty';
		empty.textContent = strings.previewEmpty;
		preview.replaceChildren(empty);
	}
}
