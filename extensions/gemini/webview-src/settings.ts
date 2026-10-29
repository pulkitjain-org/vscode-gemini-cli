/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Project Helpers page (src/host/settingsPage.ts).

import type { CliReport, ContextCostView, ExtensionView, FromSettingsPage, HookView, McpServerView, MemoryFileView, PreferencesView, RulesFileView, SettingsPageView, SkillView, ToSettingsPage, TrustRowView, TrustView } from '../src/host/panelProtocol';
import type { SettingsPageStrings } from '../src/host/panelStrings';
import { button, el, format, icon } from './panelDom';
import { bootPage } from './panelBoot';
import { selectMenu, type SelectMenu } from './selectMenu';
import { storageSection } from './settingsStorage';

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

/** An on/off switch; `onChange` gets the new state. */
function switchButton(on: boolean, label: string, title: string, onChange: (on: boolean) => void): HTMLButtonElement {
	const toggle = el('button', `switch${on ? ' on' : ''}`);
	toggle.type = 'button';
	toggle.setAttribute('role', 'switch');
	toggle.setAttribute('aria-checked', String(on));
	toggle.setAttribute('aria-label', label);
	toggle.title = title;
	toggle.addEventListener('click', () => {
		toggle.classList.toggle('on');
		toggle.setAttribute('aria-checked', String(!on));
		onChange(!on);
	});
	return toggle;
}

function serverRow(server: McpServerView): HTMLElement {
	const row = el('div', `row server${server.enabled ? '' : ' off'}`);
	const toggle = switchButton(server.enabled, `${strings.enable}: ${server.name}`, strings.enable, enabled => post({ type: 'toggle', name: server.name, enabled }));
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	title.append(el('span', 'name', server.name), el('span', 'tag', server.scope), el('span', 'tag subtle', server.transport));
	if (server.tokens !== undefined) {
		title.append(el('span', `tag tokens${server.tokens >= 5000 ? ' heavy' : ''}`, format(strings.tokensPerCall, server.tokens.toLocaleString())));
	}
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
let keepChatsMenu: SelectMenu | undefined;

function preferencesSection(preferences: PreferencesView): HTMLElement {
	const node = section(strings.preferences, format(strings.preferencesHint, preferences.display));
	const list = el('div', 'rows');
	list.append(
		preferenceRow(strings.permanentApproval, strings.permanentApprovalHint, preferences.permanentApproval, value => post({ type: 'setPreference', key: 'permanentApproval', value })),
		preferenceRow(strings.planRouting, strings.planRoutingHint, preferences.planRouting, value => post({ type: 'setPreference', key: 'planRouting', value })),
		preferenceRow(strings.usageStatistics, strings.usageStatisticsHint, preferences.usageStatistics, value => post({ type: 'setPreference', key: 'usageStatistics', value })),
	);
	const row = el('div', 'row preference');
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	const id = 'keep-chats';
	const label = el('label', 'name', strings.keepChats);
	label.htmlFor = id;
	title.append(label);
	main.append(title, el('div', 'row-detail', strings.keepChatsHint));
	const select = el('select', 'select');
	select.id = id;
	for (const choice of preferences.keepChatsChoices) {
		const option = el('option', undefined, choice.label);
		option.value = choice.value;
		option.selected = choice.value === preferences.keepChats;
		select.append(option);
	}
	select.addEventListener('change', () => post({ type: 'setPreference', key: 'keepChats', value: select.value }));
	keepChatsMenu?.dispose();
	keepChatsMenu = selectMenu(select, strings.keepChats);
	row.append(main, keepChatsMenu.element);
	list.append(row);
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

function memoryRow(file: MemoryFileView): HTMLElement {
	const row = el('div', 'row memory');
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	title.append(icon('book'), el('span', 'name mono', file.display));
	if (file.tokens) {
		title.append(el('span', `tag tokens${file.tokens >= 15000 ? ' heavy' : ''}`, format(strings.tokensPerCall, file.tokens.toLocaleString())));
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

/** Context per model call: the total, a bar of its parts, each part, and advice for the heavy ones; in a multi-root window, for the folder picked. */
function contextSection(cost: ContextCostView): HTMLElement {
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
	actions.append(measure);
	const node = section(strings.contextTitle, format(strings.contextHint, cost.folder), actions);
	// What measuring takes from the quota, before the button is pressed.
	const note = el('p', 'hint context-note');
	note.append(icon('info'), el('span', undefined, cost.note));
	node.append(note);
	const list = el('div', 'rows context-cost');
	if (cost.total !== undefined) {
		const head = el('div', 'row context-total');
		const main = el('div', 'row-main');
		main.append(el('div', 'row-title name', format(strings.contextTotal, cost.total.toLocaleString())));
		const bar = el('div', 'context-bar');
		for (const part of cost.parts) {
			if (part.tokens > 0) {
				const segment = el('i', `context-${part.kind}`);
				segment.style.flexGrow = String(part.tokens);
				bar.append(segment);
			}
		}
		main.append(bar, el('div', 'row-detail', cost.measured ?? ''));
		head.append(main);
		list.append(head);
		for (const part of cost.parts) {
			const row = el('div', 'row context-part');
			const swatch = el('i', `context-swatch context-${part.kind}`);
			const main2 = el('div', 'row-main');
			main2.append(el('div', 'row-title', part.label));
			row.append(swatch, main2, el('span', 'mono', part.tokens.toLocaleString()));
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

function render(view: SettingsPageView): void {
	const header = el('header', 'settings-header');
	const text = el('div');
	text.append(el('h1', undefined, strings.title), el('p', 'hint', strings.subtitle));
	header.append(text, button('secondary', strings.restart, () => post({ type: 'restart' }), 'debug-restart'));

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

	// Re-rendering replaces every element; keep keyboard focus on the same control.
	const focused = document.activeElement instanceof HTMLElement && page.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent : undefined;
	page.replaceChildren(header, contextSection(view.contextCost), servers, skills, hooks, extensions, memory, rules, trustSection(view.trust), preferencesSection(view.preferences), ...view.storage ? [storageSection(view.storage, strings, post)] : []);
	if (focused) {
		[...page.querySelectorAll<HTMLElement>('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent) === focused)?.focus();
	}
}

start(message => {
	if (message.type === 'view') {
		render(message.view);
	}
});
