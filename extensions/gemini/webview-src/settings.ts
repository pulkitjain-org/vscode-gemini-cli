/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Settings page (src/host/settingsPage.ts): every gemini.* setting from
// the extension's contribution, in its sections, with a side index and a
// search box; below them, what every agent loads. The frame is built once;
// each view from the host patches the settings rows in place and redraws the
// Loads sections, so a change never loses the search or the focused control.

import type { CliReport, ContextCostView, ExtensionView, FromSettingsPage, HookView, McpServerView, MemoryFileView, PreferencesView, RulesFileView, SettingRowView, SettingSectionView, SettingsPageView, SkillView, ToSettingsPage, TrustRowView, TrustView } from '../src/host/panelProtocol';
import type { SettingsPageStrings } from '../src/host/panelStrings';
import { filterSettings, helpSegments, sameValue } from '../src/acp/settingsModel';
import { button, el, format, icon } from './panelDom';
import { bootPage } from './panelBoot';
import { selectMenu, type SelectMenu } from './selectMenu';

const { strings, post, main: page, start } = bootPage<ToSettingsPage, FromSettingsPage, SettingsPageStrings>();

function section(title: string, hint: string, action?: HTMLElement): HTMLElement {
	const node = el('section', 'settings-section');
	const header = el('div', 'section-header');
	const text = el('div');
	text.append(el('h2', undefined, title), el('p', 'hint', hint));
	header.append(text);
	if (action) {
		header.append(action);
	}
	node.append(header);
	return node;
}

/** Shows `on` on a switch made by `switchButton`. */
function setSwitch(toggle: HTMLButtonElement, on: boolean): void {
	toggle.classList.toggle('on', on);
	toggle.setAttribute('aria-checked', String(on));
}

/** An on/off switch; `onChange` gets the new state. */
function switchButton(on: boolean, label: string, title: string, onChange: (on: boolean) => void): HTMLButtonElement {
	const toggle = el('button', 'switch');
	toggle.type = 'button';
	toggle.setAttribute('role', 'switch');
	toggle.setAttribute('aria-label', label);
	toggle.title = title;
	setSwitch(toggle, on);
	toggle.addEventListener('click', () => {
		const next = !toggle.classList.contains('on');
		setSwitch(toggle, next);
		onChange(next);
	});
	return toggle;
}

function serverRow(server: McpServerView): HTMLElement {
	const row = el('div', `row server${server.enabled ? '' : ' off'}`);
	const toggle = switchButton(server.enabled, `${strings.enable}: ${server.name}`, strings.enable, enabled => post({ type: 'toggle', name: server.name, enabled }));
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	title.append(el('span', 'name', server.name), el('span', 'tag', server.scope), el('span', 'tag subtle', server.transport));
	main.append(title, el('div', 'row-detail mono', server.target));
	if (server.problem) {
		const problem = el('div', 'row-problem');
		problem.append(icon('error'), el('span', undefined, format(strings.failed, server.problem)));
		main.append(problem);
	}
	row.append(toggle, main);
	if (server.transport !== 'stdio') {
		// Remote servers may need an OAuth sign-in, which the CLI runs in a terminal.
		row.append(button('icon-button', '', () => post({ type: 'signIn', name: server.name }), 'sign-in', `${strings.signIn}: ${server.name}`));
	}
	row.append(button('icon-button', '', () => post({ type: 'openFile', path: server.file, server: server.name }), 'go-to-file', strings.edit));
	return row;
}

function skillRow(skill: SkillView): HTMLElement {
	const row = el('div', `row skill${skill.enabled ? '' : ' off'}`);
	const toggle = switchButton(skill.enabled, `${strings.enableSkill}: ${skill.name}`, strings.enableSkill, enabled => post({ type: 'toggleSkill', file: skill.settingsFile, name: skill.name, enabled }));
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	title.append(icon('mortar-board'), el('span', 'name', `/${skill.name}`), el('span', 'tag', skill.scope));
	main.append(title, el('div', 'row-detail', skill.description));
	row.append(toggle, main, button('icon-button', '', () => post({ type: 'openFile', path: skill.file }), 'go-to-file', strings.open));
	return row;
}

/** A setting with a switch, its name and what it does. */
function preferenceRow(label: string, hint: string, on: boolean, onChange: (on: boolean) => void): HTMLElement {
	const row = el('div', `row preference${on ? '' : ' off'}`);
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	title.append(el('span', 'name', label));
	main.append(title, el('div', 'row-detail', hint));
	row.append(switchButton(on, label, label, onChange), main);
	return row;
}

/** The Keep saved chats menu, drawn again with the page. */
/** The preference selects' menus, disposed with the next render. */
const preferenceMenus: SelectMenu[] = [];

/** A preference with a few values, as a themed select; the menus are disposed with the next render. */
function selectRow(id: string, label: string, hint: string, choices: readonly { readonly value: string; readonly label: string }[], current: string, onChange: (value: string) => void): HTMLElement {
	const row = el('div', 'row preference');
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	const name = el('label', 'name', label);
	name.htmlFor = id;
	title.append(name);
	main.append(title, el('div', 'row-detail', hint));
	const select = el('select', 'select');
	select.id = id;
	for (const choice of choices) {
		const option = el('option', undefined, choice.label);
		option.value = choice.value;
		option.selected = choice.value === current;
		select.append(option);
	}
	select.addEventListener('change', () => onChange(select.value));
	const menu = selectMenu(select, label);
	preferenceMenus.push(menu);
	row.append(main, menu.element);
	return row;
}

function preferencesSection(preferences: PreferencesView): HTMLElement {
	for (const menu of preferenceMenus.splice(0)) {
		menu.dispose();
	}
	const node = section(strings.preferences, format(strings.preferencesHint, preferences.display));
	const list = el('div', 'rows');
	list.append(selectRow('default-approval-mode', strings.defaultApprovalMode, preferences.ownDefaultMode ? `${strings.defaultApprovalModeHint} ${format(strings.ownDefaultModeNote, preferences.ownDefaultMode)}` : strings.defaultApprovalModeHint, preferences.defaultApprovalModeChoices, preferences.defaultApprovalMode, value => post({ type: 'setPreference', key: 'defaultApprovalMode', value })));
	list.append(
		preferenceRow(strings.permanentApproval, strings.permanentApprovalHint, preferences.permanentApproval, value => post({ type: 'setPreference', key: 'permanentApproval', value })),
		preferenceRow(strings.planRouting, strings.planRoutingHint, preferences.planRouting, value => post({ type: 'setPreference', key: 'planRouting', value })),
		preferenceRow(strings.usageStatistics, strings.usageStatisticsHint, preferences.usageStatistics, value => post({ type: 'setPreference', key: 'usageStatistics', value })),
	);
	list.append(selectRow('keep-chats', strings.keepChats, strings.keepChatsHint, preferences.keepChatsChoices, preferences.keepChats, value => post({ type: 'setPreference', key: 'keepChats', value })));
	node.append(list);
	return node;
}

function hookRow(hook: HookView): HTMLElement {
	const row = el('div', `row hook${hook.enabled ? '' : ' off'}`);
	const toggle = switchButton(hook.enabled, `${strings.enableHook}: ${hook.name}`, strings.enableHook, enabled => post({ type: 'toggleHook', file: hook.file, name: hook.name, enabled }));
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	title.append(el('span', 'name', hook.event), el('span', 'tag', hook.scope));
	if (hook.matcher) {
		title.append(el('span', 'tag subtle mono', format(strings.hookMatcher, hook.matcher)));
	}
	main.append(title, el('div', 'row-detail mono', hook.command));
	row.append(toggle, main, button('icon-button', '', () => post({ type: 'openFile', path: hook.file, needle: JSON.stringify(hook.command) }), 'go-to-file', strings.edit));
	return row;
}

function extensionRow(extension: ExtensionView): HTMLElement {
	const row = el('div', `row extension${extension.active ? '' : ' off'}`);
	const toggle = switchButton(extension.active, `${strings.enableExtension}: ${extension.name}`, strings.enableExtension, on => post({ type: 'extension', action: on ? 'enable' : 'disable', name: extension.name }));
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	title.append(el('span', 'name', extension.name), el('span', 'tag subtle', extension.version));
	if (extension.detail) {
		title.append(el('span', 'tag', extension.detail));
	}
	main.append(title, el('div', 'row-detail mono', extension.source ?? ''));
	row.append(toggle, main,
		button('icon-button', '', () => post({ type: 'extension', action: 'update', name: extension.name }), 'cloud-download', strings.updateExtension),
		button('icon-button', '', () => post({ type: 'extension', action: 'uninstall', name: extension.name }), 'trash', strings.uninstallExtension));
	return row;
}

/** A context file this large is worth trimming: every model call carries it (contextCost.ts `largeRuleFileBytes`). */
const largeRuleFileCharacters = 20 * 1024;

function memoryRow(file: MemoryFileView): HTMLElement {
	const row = el('div', 'row memory');
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	title.append(icon('book'), el('span', 'name mono', file.display));
	if (file.characters) {
		title.append(el('span', `tag tokens${file.characters > largeRuleFileCharacters ? ' heavy' : ''}`, format(strings.characters, file.characters.toLocaleString())));
	}
	main.append(title, el('div', 'row-detail', file.preview ?? ''));
	row.append(main, button('icon-button', '', () => post({ type: 'openFile', path: file.path }), 'go-to-file', strings.open));
	return row;
}

/** Rows for a list the CLI reports: a spinner while it answers, its message if it cannot. */
function cliRows<T>(report: CliReport<T>, row: (item: T) => HTMLElement, empty: string): HTMLElement {
	const list = el('div', 'rows');
	if (report.state === 'loading') {
		const loading = el('p', 'empty');
		const spinner = icon('loading');
		spinner.classList.add('codicon-modifier-spin');
		loading.append(spinner, el('span', undefined, ` ${strings.loading}`));
		list.append(loading);
	} else if (report.state === 'unavailable') {
		const problem = el('p', 'empty row-problem');
		problem.append(icon('warning'), el('span', undefined, ` ${report.message}`));
		list.append(problem);
	} else {
		list.append(...report.items.map(row));
		if (!report.items.length) {
			list.append(el('p', 'empty', empty));
		}
	}
	return list;
}

function listOf<T>(items: readonly T[], row: (item: T) => HTMLElement, empty: string): HTMLElement {
	const list = el('div', 'rows');
	list.append(...items.map(row));
	if (!items.length) {
		list.append(el('p', 'empty', empty));
	}
	return list;
}

function rulesRow(rules: RulesFileView): HTMLElement {
	const row = el('div', `row rules${rules.exists ? '' : ' off'}`);
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	title.append(icon('book'), el('span', 'name', rules.label), el('span', 'tag subtle mono', rules.display));
	main.append(title, el('div', 'row-detail', rules.exists ? rules.preview ?? '' : strings.missing));
	row.append(main, rules.exists
		? button('secondary', strings.open, () => post({ type: 'openFile', path: rules.path }), 'go-to-file')
		: button('secondary', strings.create, () => post({ type: 'createRules', path: rules.path }), 'add'));
	return row;
}

function trustRow(rule: TrustRowView): HTMLElement {
	const row = el('div', 'row trust');
	const main = el('div', 'row-main');
	main.append(el('div', 'row-title trust-folder', rule.folder));
	if (rule.detail) {
		main.append(el('div', 'row-detail', rule.detail));
	}
	row.append(main, el('span', `trust-status ${rule.tone}`, rule.status));
	const key = rule.rule;
	if (key) {
		const remove = button('secondary', strings.removeTrust, () => post({ type: 'removeTrust', rule: key }));
		remove.setAttribute('aria-label', `${strings.removeTrust}: ${rule.folder}`);
		row.append(remove);
	} else {
		// GeminiCode's own rules have no Remove; the empty cell keeps the columns in line.
		row.append(el('span'));
	}
	return row;
}

/** Trusted Folders: a row per rule of the Gemini CLI's trust file, and the buttons that add one. */
function trustSection(trust: TrustView): HTMLElement {
	const node = section(strings.trust, strings.trustHint);
	if (trust.state !== 'ready') {
		const line = el('p', `hint trust-note${trust.state === 'unreadable' ? ' problem' : ''}`);
		line.append(icon(trust.state === 'off' ? 'info' : 'warning'), el('span', undefined, trust.message));
		node.append(line);
		return node;
	}
	const actions = el('div', 'section-actions trust-actions');
	actions.append(
		button('primary', strings.trustFolder, () => post({ type: 'trustFolder', kind: 'folder' })),
		button('secondary', strings.trustParent, () => post({ type: 'trustFolder', kind: 'parent' })),
		button('secondary', strings.neverTrust, () => post({ type: 'trustFolder', kind: 'never' })));
	node.append(listOf(trust.rows, trustRow, strings.noTrust), actions);
	return node;
}

let contextFolderMenu: SelectMenu | undefined;

/** Context per model call: the total, one row per test prompt as the CLI reported it, and what accounts for much of it; in a multi-root window, for the folder picked. */
function contextSection(cost: ContextCostView, developer: boolean): HTMLElement {
	const measuring = cost.state === 'measuring';
	const measure = button('secondary', measuring ? strings.measuring : cost.total === undefined ? strings.measure : strings.measureAgain, () => post({ type: 'measureContext' }), measuring ? 'loading' : 'pulse');
	measure.disabled = measuring;
	if (measuring) {
		measure.querySelector('.codicon')?.classList.add('codicon-modifier-spin');
	}
	const actions = el('div', 'section-actions');
	contextFolderMenu?.dispose();
	contextFolderMenu = undefined;
	if (cost.folders) {
		const select = el('select', 'select');
		select.setAttribute('aria-label', strings.contextFolder);
		for (const folder of cost.folders) {
			const option = el('option', undefined, folder.name);
			option.value = folder.path;
			option.selected = folder.path === cost.folderPath;
			select.append(option);
		}
		select.addEventListener('change', () => post({ type: 'contextFolder', folder: select.value }));
		contextFolderMenu = selectMenu(select, strings.contextFolder);
		actions.append(contextFolderMenu.element);
	}
	if (developer) {
		actions.append(measure);
	}
	const node = section(strings.contextTitle, format(strings.contextHint, cost.folder), actions);
	// What measuring takes from the quota, before the button is pressed.
	const note = el('p', 'hint context-note');
	note.append(icon('info'), el('span', undefined, cost.note));
	node.append(note);
	const list = el('div', 'rows context-cost');
	if (cost.total !== undefined) {
		const head = el('div', 'row context-total');
		const main = el('div', 'row-main');
		main.append(el('div', 'row-title name', format(strings.contextTotal, cost.total.toLocaleString())), el('div', 'row-detail', cost.measured ?? ''));
		head.append(main);
		list.append(head);
		for (const reading of cost.readings) {
			const row = el('div', 'row context-part');
			const main2 = el('div', 'row-main');
			main2.append(el('div', 'row-title', reading.label));
			row.append(main2, el('span', 'mono', reading.tokens.toLocaleString()));
			list.append(row);
		}
		for (const tip of cost.tips) {
			const row = el('div', 'row context-tip');
			row.append(icon('lightbulb'), el('span', undefined, tip));
			list.append(row);
		}
	} else {
		list.append(el('p', 'empty', strings.contextNone));
	}
	if (cost.error) {
		const problem = el('p', 'empty row-problem');
		problem.append(icon('warning'), el('span', undefined, ` ${cost.error}`));
		list.append(problem);
	}
	node.append(list);
	return node;
}

/** A setting's control: the element to put in the row, and how a new value from the host shows in it. */
interface RowControl {
	readonly element: HTMLElement;
	set(value: unknown): void;
	setDisabled(disabled: boolean): void;
}

/** A text or number field; the value goes to the host when it is committed (change), not on every keystroke. */
function fieldControl(row: SettingRowView): RowControl {
	const input = el('input', 'setting-field');
	input.type = row.control === 'number' ? 'number' : 'text';
	input.setAttribute('aria-label', row.label);
	if (row.control === 'number') {
		if (row.minimum !== undefined) {
			input.min = String(row.minimum);
		}
		if (row.maximum !== undefined) {
			input.max = String(row.maximum);
		}
		input.step = Number.isInteger(row.default) ? '1' : 'any';
	}
	input.addEventListener('change', () => {
		if (row.control === 'number') {
			const number = Number(input.value);
			if (input.value.trim() && Number.isFinite(number)) {
				post({ type: 'setSetting', key: row.key, value: number });
			}
		} else {
			post({ type: 'setSetting', key: row.key, value: input.value });
		}
	});
	return {
		element: input,
		set: value => {
			// Never under the user's typing: the host's value comes back once the change is saved.
			if (document.activeElement !== input) {
				input.value = value === undefined || value === null ? '' : String(value);
			}
		},
		setDisabled: disabled => input.disabled = disabled,
	};
}

/** An enum setting as a themed select; a choice's help is its title. */
function pickerControl(row: SettingRowView): RowControl {
	const select = el('select', 'select');
	select.setAttribute('aria-label', row.label);
	const choices = row.choices ?? [];
	choices.forEach((choice, i) => {
		const option = el('option', undefined, choice.label);
		option.value = String(i);
		if (choice.help) {
			option.title = choice.help;
		}
		select.append(option);
	});
	select.addEventListener('change', () => {
		const choice = choices[Number(select.value)];
		if (choice) {
			post({ type: 'setSetting', key: row.key, value: choice.value });
		}
	});
	const menu = selectMenu(select, row.label);
	return {
		element: menu.element,
		set: value => {
			const index = choices.findIndex(choice => sameValue(choice.value, value));
			select.value = index >= 0 ? String(index) : '';
			menu.element.title = choices[index]?.help ?? '';
			menu.sync();
		},
		setDisabled: disabled => {
			select.disabled = disabled;
			menu.sync();
		},
	};
}

/** An array of strings as one line per entry, each removable, and Add. */
function listControl(row: SettingRowView): RowControl {
	const list = el('div', 'setting-list');
	const entries = el('div', 'setting-entries');
	const add = button('secondary', strings.addEntry, () => {
		entries.append(entry(''));
		entries.querySelector<HTMLInputElement>('.entry:last-child input')?.focus();
	}, 'add');
	list.append(entries, add);
	let shown: string[] = [];
	let disabled = false;
	const values = () => [...entries.querySelectorAll('input')].map(input => input.value.trim()).filter(Boolean);
	const send = () => post({ type: 'setSetting', key: row.key, value: values() });
	function entry(value: string): HTMLElement {
		const line = el('div', 'entry');
		const input = el('input');
		input.type = 'text';
		input.value = value;
		input.placeholder = strings.entryPlaceholder;
		input.setAttribute('aria-label', row.label);
		input.disabled = disabled;
		input.addEventListener('change', send);
		const remove = button('icon-button', '', () => {
			line.remove();
			send();
		}, 'close', strings.removeEntry);
		remove.disabled = disabled;
		line.append(input, remove);
		return line;
	}
	return {
		element: list,
		set: value => {
			const next = Array.isArray(value) ? value.map(String) : [];
			if (list.contains(document.activeElement) || sameValue(next, shown)) {
				return;
			}
			shown = next;
			entries.replaceChildren(...next.map(entry));
		},
		setDisabled: off => {
			disabled = off;
			add.disabled = off;
			for (const control of entries.querySelectorAll('input, button')) {
				(control as HTMLInputElement | HTMLButtonElement).disabled = off;
			}
		},
	};
}

/** An object setting as JSON in a textarea; text that does not parse is marked and not sent. */
function jsonControl(row: SettingRowView, note: (text: string | undefined) => void): RowControl {
	const area = el('textarea', 'setting-json mono');
	area.setAttribute('aria-label', row.label);
	area.rows = 4;
	area.spellcheck = false;
	area.addEventListener('change', () => {
		try {
			const value = JSON.parse(area.value) as unknown;
			area.classList.remove('invalid');
			note(undefined);
			post({ type: 'setSetting', key: row.key, value });
		} catch {
			area.classList.add('invalid');
			note(strings.invalidJson);
		}
	});
	return {
		element: area,
		set: value => {
			if (document.activeElement !== area) {
				area.value = JSON.stringify(value ?? {}, null, 2);
				area.classList.remove('invalid');
			}
		},
		setDisabled: disabled => area.disabled = disabled,
	};
}

interface SettingRowNode {
	readonly node: HTMLElement;
	/** Shows the row as the host last sent it, touching only what changed. */
	apply(row: SettingRowView): void;
}

/** One gemini.* setting: its name and key, its help, a note when it is locked or saved for the workspace, its control and Reset. */
function settingRow(first: SettingRowView): SettingRowNode {
	const node = el('div', `row setting ${first.control}`);
	node.dataset.key = first.key;
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	title.append(el('span', 'name', first.label), el('span', 'tag subtle mono', first.key));
	if (first.advanced) {
		title.append(el('span', 'tag', strings.advanced));
	}
	if (first.deprecated) {
		title.append(el('span', 'tag', strings.deprecated));
	}
	const help = el('div', 'row-detail setting-help');
	for (const segment of helpSegments(first.deprecated ?? first.help)) {
		help.append(el(segment.code ? 'code' : 'span', undefined, segment.text));
	}
	const note = el('div', 'row-note');
	const noteIcon = icon('lock');
	const noteText = el('span');
	note.append(noteIcon, noteText);
	main.append(title, help, note);
	let problem: string | undefined;
	const setNote = (locked: boolean, target: SettingRowView['target']) => {
		const text = problem ?? (locked ? strings.lockedByAdmin : target === 'workspace' ? strings.savedInWorkspace : '');
		noteText.textContent = text;
		noteIcon.className = `codicon codicon-${problem ? 'warning' : locked ? 'lock' : 'root-folder'}`;
		note.hidden = !text;
	};
	let shown = first;
	const control: RowControl = first.control === 'toggle'
		? (() => {
			const toggle = switchButton(false, first.label, first.label, on => post({ type: 'setSetting', key: first.key, value: on }));
			return { element: toggle, set: value => setSwitch(toggle, value === true), setDisabled: disabled => toggle.disabled = disabled };
		})()
		: first.control === 'picker' ? pickerControl(first)
			: first.control === 'list' ? listControl(first)
				: first.control === 'json' ? jsonControl(first, text => {
					problem = text;
					setNote(shown.locked, shown.target);
				})
					: fieldControl(first);
	const reset = button('icon-button reset', '', () => post({ type: 'resetSetting', key: first.key }), 'discard', strings.reset);
	const side = el('div', 'setting-control');
	side.append(control.element);
	if (first.control === 'toggle') {
		node.append(control.element, main, reset);
	} else {
		node.append(main, side, reset);
	}
	return {
		node,
		apply: row => {
			shown = row;
			control.set(row.value);
			control.setDisabled(row.locked);
			node.classList.toggle('locked', row.locked);
			reset.hidden = !row.modified || row.locked;
			setNote(row.locked, row.target);
		},
	};
}

/** The page's frame, built once: the header with the search box, the side index, the settings sections and the Loads sections. */
interface Frame {
	readonly search: HTMLInputElement;
	readonly index: HTMLElement;
	readonly sections: HTMLElement;
	readonly noMatches: HTMLElement;
	readonly loads: HTMLElement;
}

let frame: Frame | undefined;
/** The settings as the host last sent them, which the search filters. */
let lastSettings: readonly SettingSectionView[] = [];
const sectionNodes = new Map<string, HTMLElement>();
const rowNodes = new Map<string, SettingRowNode>();
/** The side index's links to sections on this page, by the section's id (`loads` for the Loads group). */
const indexLinks = new Map<string, HTMLButtonElement>();

function buildFrame(): Frame {
	const header = el('header', 'settings-header');
	const text = el('div');
	text.append(el('h1', undefined, strings.title), el('p', 'hint', strings.subtitle));
	const actions = el('div', 'section-actions');
	const search = el('input', 'settings-search');
	search.type = 'search';
	search.placeholder = strings.search;
	search.setAttribute('aria-label', strings.search);
	search.addEventListener('input', applyFilter);
	search.addEventListener('keydown', event => {
		if (event.key === 'Escape' && search.value) {
			search.value = '';
			applyFilter();
		}
	});
	actions.append(search, button('secondary', strings.restart, () => post({ type: 'restart' }), 'debug-restart'));
	header.append(text, actions);
	const layout = el('div', 'settings-layout');
	const index = el('nav', 'settings-index');
	index.setAttribute('aria-label', strings.sideIndex);
	const content = el('div', 'settings-content');
	const sections = el('div', 'settings-sections');
	const noMatches = el('p', 'empty settings-no-matches');
	noMatches.hidden = true;
	const loads = el('div', 'settings-loads');
	loads.id = 'section-loads';
	content.append(sections, noMatches, loads);
	layout.append(index, content);
	page.replaceChildren(header, layout);
	return { search, index, sections, noMatches, loads };
}

/** Scrolls to a section of this page and marks its link. */
function goTo(id: string): void {
	const target = id === 'loads' ? frame?.loads : sectionNodes.get(id);
	target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
	markIndex(id);
}

function markIndex(id: string): void {
	for (const [each, link] of indexLinks) {
		link.classList.toggle('active', each === id);
		link.setAttribute('aria-current', each === id ? 'true' : 'false');
	}
}

/** The side index: the contributed sections, Loads, then the other Agent Setup pages. */
function buildIndex(index: HTMLElement, sections: readonly SettingSectionView[]): void {
	indexLinks.clear();
	const link = (id: string, label: string) => {
		const node = button('index-link', label, () => goTo(id));
		node.dataset.section = id;
		indexLinks.set(id, node);
		return node;
	};
	index.replaceChildren(
		...sections.map(section => link(section.id, section.title)),
		link('loads', strings.loads),
		...strings.otherPages.map(tab => {
			const node = button('index-link other', tab.label, () => post({ type: 'openTab', tab: tab.id }), 'link-external');
			node.dataset.tab = tab.id;
			return node;
		}),
	);
	markIndex(sections[0]?.id ?? 'loads');
}

/** The settings sections as the host sent them: rows patched in place, new ones made, gone ones removed. */
function patchSettings(sections: readonly SettingSectionView[]): void {
	const f = frame!;
	if (sections.map(section => section.id).join() !== lastSettings.map(section => section.id).join()) {
		buildIndex(f.index, sections);
	}
	lastSettings = sections;
	const keep = new Set<string>();
	sections.forEach((section, i) => {
		let node = sectionNodes.get(section.id);
		if (!node) {
			node = el('section', 'settings-section');
			node.id = `section-${section.id}`;
			const header = el('div', 'section-header');
			header.append(el('h2', undefined, section.title));
			node.append(header, el('div', 'rows'));
			sectionNodes.set(section.id, node);
		}
		if (f.sections.children[i] !== node) {
			f.sections.insertBefore(node, f.sections.children[i] ?? null);
		}
		const rows = node.querySelector('.rows')!;
		section.settings.forEach((row, j) => {
			keep.add(row.key);
			let entry = rowNodes.get(row.key);
			if (!entry) {
				entry = settingRow(row);
				rowNodes.set(row.key, entry);
			}
			if (rows.children[j] !== entry.node) {
				rows.insertBefore(entry.node, rows.children[j] ?? null);
			}
			entry.apply(row);
		});
	});
	for (const [key, entry] of rowNodes) {
		if (!keep.has(key)) {
			entry.node.remove();
			rowNodes.delete(key);
		}
	}
	const ids = new Set(sections.map(section => section.id));
	for (const [id, node] of sectionNodes) {
		if (!ids.has(id)) {
			node.remove();
			sectionNodes.delete(id);
		}
	}
	applyFilter();
}

/** Shows only what the search box matches: every section without its advanced and deprecated settings when it is empty. */
function applyFilter(): void {
	const f = frame;
	if (!f) {
		return;
	}
	const query = f.search.value.trim();
	const shown = filterSettings(lastSettings, query);
	const rows = new Set(shown.flatMap(section => section.settings.map(setting => setting.key)));
	const sections = new Set(shown.map(section => section.id));
	for (const [key, entry] of rowNodes) {
		entry.node.hidden = !rows.has(key);
	}
	for (const [id, node] of sectionNodes) {
		node.hidden = !sections.has(id);
	}
	for (const [id, link] of indexLinks) {
		link.hidden = id === 'loads' ? !!query : !sections.has(id);
	}
	for (const link of f.index.querySelectorAll<HTMLElement>('.index-link.other')) {
		link.hidden = !!query;
	}
	f.loads.hidden = !!query;
	f.noMatches.hidden = !query || shown.length > 0;
	f.noMatches.textContent = format(strings.noMatches, query);
}

/** Marks the section at the top of the view as the page scrolls. */
function followScroll(): void {
	const top = window.scrollY + 80;
	let current: string | undefined;
	for (const [id, node] of sectionNodes) {
		if (!node.hidden && node.offsetTop <= top) {
			current = id;
		}
	}
	if (frame && !frame.loads.hidden && frame.loads.offsetTop <= top) {
		current = 'loads';
	}
	if (current) {
		markIndex(current);
	}
}

window.addEventListener('scroll', followScroll, { passive: true });

/** The Loads sections, drawn again with each view: rules, skills, MCP servers, Measure and the rest, as before the settings joined the page. */
function drawLoads(view: SettingsPageView): void {
	const loads = frame!.loads;
	// Jira, GitLab, SonarQube, Snyk and Figma are connected on their own page, not added as servers.
	const serverActions = el('div', 'section-actions');
	serverActions.append(button('secondary', strings.connections, () => post({ type: 'connections' }), 'plug'), button('primary', strings.addServer, () => post({ type: 'addServer' }), 'add'));
	const servers = section(strings.servers, strings.serversHint, serverActions);
	servers.append(listOf(view.servers, serverRow, strings.noServers));

	const skills = section(strings.skills, strings.skillsHint, button('secondary', strings.newSkill, () => post({ type: 'newSkill' }), 'add'));
	skills.append(listOf(view.skills, skillRow, strings.noSkills));

	const hooks = section(strings.hooks, strings.hooksHint, button('secondary', strings.addHook, () => post({ type: 'addHook' }), 'add'));
	hooks.append(listOf(view.hooks, hookRow, strings.noHooks));

	const extensions = section(strings.extensions, strings.extensionsHint, button('secondary', strings.installExtension, () => post({ type: 'installExtension' }), 'cloud-download'));
	extensions.append(cliRows(view.extensions, extensionRow, strings.noExtensions));

	const memoryActions = el('div', 'section-actions');
	memoryActions.append(
		button('icon-button', '', () => post({ type: 'refreshMemory' }), 'refresh', strings.refresh),
		button('secondary', strings.addMemory, () => post({ type: 'addMemory' }), 'add'));
	const memory = section(strings.memory, strings.memoryHint, memoryActions);
	memory.append(cliRows(view.memory, memoryRow, strings.noMemory));

	const rules = section(strings.rules, strings.rulesHint);
	const rulesList = el('div', 'rows');
	rulesList.append(...view.rules.map(rulesRow));
	rules.append(rulesList);

	const heading = el('div', 'section-header settings-loads-header');
	heading.append(el('h2', undefined, strings.loads));

	// Re-drawing replaces every element of the group; keep keyboard focus on the same control.
	const focused = document.activeElement instanceof HTMLElement && loads.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent : undefined;
	loads.replaceChildren(heading, contextSection(view.contextCost, view.developer), servers, skills, hooks, extensions, memory, rules, trustSection(view.trust), preferencesSection(view.preferences));
	if (focused) {
		[...loads.querySelectorAll<HTMLElement>('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent) === focused)?.focus();
	}
}

function render(view: SettingsPageView): void {
	frame ??= buildFrame();
	patchSettings(view.settings);
	drawLoads(view);
}

start(message => {
	if (message.type === 'view') {
		render(message.view);
	}
});
