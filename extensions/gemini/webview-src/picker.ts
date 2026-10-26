/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The composer's menu: typing "@" lists workspace files to attach, with the
// folders they are in, symbols from the workspace index and the Workspace
// rows (the Problems list, uncommitted changes, the last terminal command),
// each group under its heading; "/" at the start lists slash commands.

import { basename } from '../src/acp/attachments';
import { addAttachments } from './attachmentChips';
import type { SlashCommand } from '../src/acp/slashCommands';
import type { ViewMention } from '../src/host/chatProtocol';
import { folderOf, format, matchCommands, mentionAt, mentionGroup, mentionInsertion, slashQuery, symbolIcon, withoutMention, wrapIndex } from './chatLogic';
import { el, icon, setTip } from './dom';
import { autoGrow, updateSendState } from './inputBox';
import { strings, ui, vscode } from './view';

const { input, picker } = ui;

type FileMatch = { readonly path: string; readonly relative: string };

/** A row of the @ picker: a file, or a folder, symbol or Workspace row. */
type MentionRow = { readonly kind: 'file'; readonly file: FileMatch } | ViewMention;

type PickerState =
	| {
		readonly kind: 'files';
		/** Where the "@" is in the input. */
		readonly start: number;
		query: string;
		files: readonly MentionRow[];
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
	// A plain text box again once its menu closes.
	for (const name of ['role', 'aria-expanded', 'aria-controls', 'aria-autocomplete', 'aria-activedescendant']) {
		input.removeAttribute(name);
	}
}

/** Shows the files and other rows the extension found for search `requestId`, if it is still the latest. */
export function showFiles(requestId: number, files: readonly FileMatch[], mentions: readonly ViewMention[] = []): void {
	if (pickerState?.kind === 'files' && requestId === lastSearchId) {
		const query = pickerState.query.trim().toLowerCase();
		// The Workspace rows are always offered; typing narrows them by name.
		const shown = mentions.filter(mention => mentionGroup(mention.kind) !== 'workspace' || !query || mentionName(mention).toLowerCase().includes(query));
		pickerState.files = [...files.map(file => ({ kind: 'file' as const, file })), ...shown];
		pickerState.active = 0;
		renderPicker();
	}
}

/** A row's name and the quiet text after it. */
function mentionName(row: MentionRow): string {
	const names = strings.mentions;
	switch (row.kind) {
		case 'file': return basename(row.file.relative);
		case 'folder': return row.relative;
		case 'symbol': return row.name;
		case 'problems': return names.problems;
		case 'changes': return names.changes;
		case 'terminal': return names.terminal;
	}
}

function mentionDetail(row: MentionRow): string {
	const names = strings.mentions;
	switch (row.kind) {
		case 'file': return folderOf(row.file.relative);
		case 'folder': return '';
		case 'symbol': return `${row.relative}:${row.line}`;
		case 'problems': return format(names.problemsDetail, row.errors, row.warnings);
		case 'changes': return format(names.changesDetail, row.files);
		case 'terminal': return row.failed ? format(names.terminalFailed, row.command) : row.command;
	}
}

function mentionIcon(row: MentionRow): string {
	switch (row.kind) {
		case 'file': return 'file';
		case 'folder': return 'folder';
		case 'symbol': return symbolIcon(row.symbolKind);
		case 'problems': return 'warning';
		case 'changes': return 'diff';
		case 'terminal': return 'terminal';
	}
}

function renderPicker(): void {
	const state = pickerState;
	if (!state) {
		return;
	}
	picker.hidden = false;
	// While the menu is open the input is its combobox, so screen readers follow the highlighted row.
	picker.setAttribute('aria-label', state.kind === 'files' ? strings.pickerFiles : strings.pickerCommands);
	input.setAttribute('role', 'combobox');
	input.setAttribute('aria-expanded', 'true');
	input.setAttribute('aria-controls', picker.id);
	input.setAttribute('aria-autocomplete', 'list');
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
		? mentionRows(state.files, row)
		: state.commands.map((command, index) => {
			const r = row(index);
			r.classList.add('picker-command');
			r.append(
				icon(command.source === 'team' ? 'organization' : command.source === 'skill' ? 'mortar-board' : command.source === 'app' ? 'history' : 'terminal'),
				el('span', 'picker-name', `/${command.name}`),
				el('span', 'picker-folder', command.description),
			);
			setTip(r, `${command.source === 'team' ? strings.commandFromTeam : command.source === 'skill' ? strings.commandFromSkill : command.source === 'app' ? strings.commandFromApp : strings.commandFromCli}: /${command.name}`);
			return r;
		})));
	input.setAttribute('aria-activedescendant', `picker-${state.active}`);
	picker.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

/** The @ picker's rows, under a heading for each group once there is more than one. */
function mentionRows(rows: readonly MentionRow[], row: (index: number) => HTMLElement): HTMLElement[] {
	const groups = new Set(rows.map(each => mentionGroup(each.kind)));
	const nodes: HTMLElement[] = [];
	let group: string | undefined;
	rows.forEach((each, index) => {
		const next = mentionGroup(each.kind);
		if (groups.size > 1 && next !== group) {
			const heading = el('div', 'picker-heading', strings.mentions[next]);
			heading.setAttribute('role', 'presentation');
			nodes.push(heading);
		}
		group = next;
		const r = row(index);
		r.append(icon(mentionIcon(each)), el('span', 'picker-name', mentionName(each)), el('span', 'picker-folder', mentionDetail(each)));
		setTip(r, each.kind === 'file' ? each.file.relative : each.kind === 'symbol' ? `${each.name} \u00b7 ${each.relative}:${each.line}` : mentionName(each));
		nodes.push(r);
	});
	return nodes;
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
	const picked = state?.files[index];
	if (!state || !picked) {
		return;
	}
	// Replace the typed "@query" with nothing; the chip shows what was picked.
	input.value = withoutMention(input.value, state.start, state.query);
	input.setSelectionRange(state.start, state.start);
	closePicker();
	if (picked.kind === 'file') {
		addAttachments([{ kind: 'file', path: picked.file.path }]);
	} else {
		// The extension makes the chip: a folder, a symbol's lines, the Problems list, the diff or the command's output.
		vscode.postMessage({ type: 'attachMention', mention: picked });
	}
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

/** Inserts "@" at the caret (with a space before it when needed) and opens the file picker. */
export function startMention(): void {
	const caret = input.selectionStart;
	input.setRangeText(mentionInsertion(input.value.slice(0, caret)), caret, input.selectionEnd, 'end');
	input.focus();
	autoGrow();
	updatePicker();
}

/** Starts a slash command at the start of the input, where commands go, and opens the command menu. */
export function startCommand(): void {
	input.focus();
	if (!input.value.startsWith('/')) {
		input.setRangeText(input.value.trim() ? '/ ' : '/', 0, 0);
	}
	input.setSelectionRange(1, 1);
	autoGrow();
	updatePicker();
}
