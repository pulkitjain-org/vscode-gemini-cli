/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The composer's menu: typing "@" lists workspace files to attach, and "/"
// at the start lists slash commands.

import { basename } from '../src/acp/attachments';
import { addAttachments } from './attachmentChips';
import type { SlashCommand } from '../src/acp/slashCommands';
import { folderOf, matchCommands, mentionAt, mentionInsertion, slashQuery, withoutMention, wrapIndex } from './chatLogic';
import { el, icon } from './dom';
import { autoGrow, updateSendState } from './inputBox';
import { strings, ui, vscode } from './view';

const { input, picker } = ui;

type FileMatch = { readonly path: string; readonly relative: string };

type PickerState =
	| {
		readonly kind: 'files';
		/** Where the "@" is in the input. */
		readonly start: number;
		query: string;
		files: readonly FileMatch[];
		active: number;
	}
	| {
		readonly kind: 'commands';
		query: string;
		commands: readonly SlashCommand[];
		active: number;
	};

let pickerState: PickerState | undefined;
let lastSearchId = 0;
/** The chat's slash commands as last sent by the extension; asked for again each time the menu opens. */
let knownCommands: readonly SlashCommand[] = [];

/** Opens, updates or closes the menu for the "@word" or "/command" at the caret. */
export function updatePicker(): void {
	const slash = slashQuery(input.value, input.selectionStart, input.selectionEnd);
	if (slash !== undefined) {
		if (pickerState?.kind !== 'commands') {
			vscode.postMessage({ type: 'listCommands' });
		} else if (pickerState.query === slash) {
			return;
		}
		pickerState = { kind: 'commands', query: slash, commands: matchCommands(knownCommands, slash), active: 0 };
		renderPicker();
		return;
	}
	const mention = mentionAt(input.value, input.selectionStart, input.selectionEnd);
	if (!mention) {
		closePicker();
		return;
	}
	const current = pickerState?.kind === 'files' && pickerState.start === mention.start ? pickerState : undefined;
	if (current?.query === mention.query) {
		return;
	}
	pickerState = { kind: 'files', start: mention.start, query: mention.query, files: current?.files ?? [], active: 0 };
	vscode.postMessage({ type: 'searchFiles', requestId: ++lastSearchId, query: mention.query });
	renderPicker();
}

/** Takes the chat's slash commands, and updates the menu if it lists them. */
export function showCommands(commands: readonly SlashCommand[]): void {
	knownCommands = commands;
	if (pickerState?.kind === 'commands') {
		const active = pickerState.commands[pickerState.active]?.name;
		pickerState.commands = matchCommands(commands, pickerState.query);
		pickerState.active = Math.max(0, pickerState.commands.findIndex(c => c.name === active));
		renderPicker();
	}
}

export function closePicker(): void {
	pickerState = undefined;
	picker.hidden = true;
	input.removeAttribute('aria-activedescendant');
}

/** Shows the files the extension found for search `requestId`, if it is still the latest. */
export function showFiles(requestId: number, files: readonly FileMatch[]): void {
	if (pickerState?.kind === 'files' && requestId === lastSearchId) {
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
	const count = pickerCount(state);
	if (!count) {
		picker.replaceChildren(el('div', 'picker-empty', state.kind === 'files' ? strings.noFiles : strings.noCommands));
		input.removeAttribute('aria-activedescendant');
		return;
	}
	const row = (index: number) => {
		const row = el('div', `picker-row${index === state.active ? ' active' : ''}`);
		row.id = `picker-${index}`;
		row.setAttribute('role', 'option');
		row.setAttribute('aria-selected', String(index === state.active));
		// mousedown, so the input keeps focus.
		row.addEventListener('mousedown', event => {
			event.preventDefault();
			pick(index);
		});
		return row;
	};
	picker.replaceChildren(...(state.kind === 'files'
		? state.files.map((file, index) => {
			const r = row(index);
			r.append(icon('file'), el('span', 'picker-name', basename(file.relative)), el('span', 'picker-folder', folderOf(file.relative)));
			r.title = file.relative;
			return r;
		})
		: state.commands.map((command, index) => {
			const r = row(index);
			r.classList.add('picker-command');
			r.append(
				icon(command.source === 'team' ? 'organization' : command.source === 'app' ? 'history' : 'terminal'),
				el('span', 'picker-name', `/${command.name}`),
				el('span', 'picker-folder', command.description),
			);
			r.title = `${command.source === 'team' ? strings.commandFromTeam : command.source === 'app' ? strings.commandFromApp : strings.commandFromCli}: /${command.name}`;
			return r;
		})));
	input.setAttribute('aria-activedescendant', `picker-${state.active}`);
	picker.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function pickerCount(state: PickerState): number {
	return state.kind === 'files' ? state.files.length : state.commands.length;
}

function pick(index: number): void {
	const state = pickerState;
	if (state?.kind === 'commands') {
		const command = state.commands[index];
		if (command) {
			// Complete the name and leave the caret after it, ready for arguments.
			const rest = input.value.slice(input.selectionStart).replace(/^\S*\s?/, '');
			const head = `/${command.name} `;
			input.value = head + rest;
			input.setSelectionRange(head.length, head.length);
			closePicker();
			autoGrow();
			updateSendState();
		}
		return;
	}
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
			if (pickerCount(state)) {
				state.active = wrapIndex(state.active, event.key === 'ArrowDown' ? 1 : -1, pickerCount(state));
				renderPicker();
			}
			return true;
		case 'Enter':
		case 'Tab':
			if (event.key === 'Enter' && state.kind === 'commands' && state.commands[state.active]?.name === state.query) {
				// "/init" typed in full: Enter sends it.
				closePicker();
				return false;
			}
			if (pickerCount(state)) {
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
