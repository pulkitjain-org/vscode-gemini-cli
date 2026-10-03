/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The @-mention picker: typing "@" in the input lists workspace files to attach.

import { basename } from '../src/acp/attachments';
import { addAttachments } from './attachmentChips';
import { folderOf, mentionAt, mentionInsertion, withoutMention, wrapIndex } from './chatLogic';
import { el, icon } from './dom';
import { autoGrow } from './inputBox';
import { strings, ui, vscode } from './view';

const { input, picker } = ui;

interface PickerState {
	/** Where the "@" is in the input. */
	readonly start: number;
	query: string;
	files: readonly { readonly path: string; readonly relative: string }[];
	active: number;
}

let pickerState: PickerState | undefined;
let lastSearchId = 0;

/** Opens, updates or closes the picker for the "@word" at the caret. */
export function updatePicker(): void {
	const mention = mentionAt(input.value, input.selectionStart, input.selectionEnd);
	if (!mention) {
		closePicker();
		return;
	}
	if (pickerState?.start === mention.start && pickerState.query === mention.query) {
		return;
	}
	pickerState = { start: mention.start, query: mention.query, files: pickerState?.start === mention.start ? pickerState.files : [], active: 0 };
	vscode.postMessage({ type: 'searchFiles', requestId: ++lastSearchId, query: mention.query });
	renderPicker();
}

export function closePicker(): void {
	pickerState = undefined;
	picker.hidden = true;
	input.removeAttribute('aria-activedescendant');
}

/** Shows the files the extension found for search `requestId`, if it is still the latest. */
export function showFiles(requestId: number, files: PickerState['files']): void {
	if (pickerState && requestId === lastSearchId) {
		pickerState.files = files;
		pickerState.active = 0;
		renderPicker();
	}
}

function renderPicker(): void {
	const state = pickerState;
	if (!state) {
		return;
	}
	picker.hidden = false;
	if (!state.files.length) {
		picker.replaceChildren(el('div', 'picker-empty', strings.noFiles));
		return;
	}
	picker.replaceChildren(...state.files.map((file, index) => {
		const row = el('div', `picker-row${index === state.active ? ' active' : ''}`);
		row.id = `picker-${index}`;
		row.setAttribute('role', 'option');
		row.setAttribute('aria-selected', String(index === state.active));
		row.append(icon('file'), el('span', 'picker-name', basename(file.relative)), el('span', 'picker-folder', folderOf(file.relative)));
		row.title = file.relative;
		// mousedown, so the input keeps focus.
		row.addEventListener('mousedown', event => {
			event.preventDefault();
			pick(index);
		});
		return row;
	}));
	input.setAttribute('aria-activedescendant', `picker-${state.active}`);
	picker.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function pick(index: number): void {
	const state = pickerState;
	const file = state?.files[index];
	if (!state || !file) {
		return;
	}
	// Replace the typed "@query" with nothing; the chip shows the file.
	input.value = withoutMention(input.value, state.start, state.query);
	input.setSelectionRange(state.start, state.start);
	closePicker();
	addAttachments([{ kind: 'file', path: file.path }]);
	autoGrow();
}

/** Handles a key in the input if the picker is open; true if it did. */
export function onPickerKey(event: KeyboardEvent): boolean {
	const state = pickerState;
	if (!state || picker.hidden) {
		return false;
	}
	switch (event.key) {
		case 'ArrowDown':
		case 'ArrowUp':
			if (state.files.length) {
				state.active = wrapIndex(state.active, event.key === 'ArrowDown' ? 1 : -1, state.files.length);
				renderPicker();
			}
			return true;
		case 'Enter':
		case 'Tab':
			if (state.files.length) {
				pick(state.active);
				return true;
			}
			return false;
		case 'Escape':
			closePicker();
			return true;
	}
	return false;
}

ui.mentionButton.addEventListener('click', () => {
	// Insert "@" at the caret (with a space before it when needed) and open the picker.
	const caret = input.selectionStart;
	input.setRangeText(mentionInsertion(input.value.slice(0, caret)), caret, input.selectionEnd, 'end');
	input.focus();
	autoGrow();
	updatePicker();
});
