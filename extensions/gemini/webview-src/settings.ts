/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Project Helpers page (src/host/settingsPage.ts).

import type { CliReport, ExtensionView, FromSettingsPage, HookView, McpServerView, MemoryFileView, RulesFileView, SettingsPageStrings, SettingsPageView, SkillView, ToSettingsPage } from '../src/host/panelProtocol';
import { button, el, format, icon, pageStrings } from './panelDom';

declare function acquireVsCodeApi(): { postMessage(message: FromSettingsPage): void };

const vscode = acquireVsCodeApi();
const strings = pageStrings<SettingsPageStrings>();
const page = document.getElementById('page')!;

function post(message: FromSettingsPage): void {
	vscode.postMessage(message);
}

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
	main.append(title, el('div', 'row-detail mono', server.target));
	if (server.problem) {
		const problem = el('div', 'row-problem');
		problem.append(icon('error'), el('span', undefined, format(strings.failed, server.problem)));
		main.append(problem);
	}
	row.append(toggle, main, button('icon-button', '', () => post({ type: 'openFile', path: server.file, server: server.name }), 'go-to-file', strings.edit));
	return row;
}

function skillRow(skill: SkillView): HTMLElement {
	const row = el('div', 'row skill');
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	title.append(icon('mortar-board'), el('span', 'name', `/${skill.name}`), el('span', 'tag', skill.scope));
	main.append(title, el('div', 'row-detail', skill.description));
	row.append(main, button('icon-button', '', () => post({ type: 'openFile', path: skill.file }), 'go-to-file', strings.open));
	return row;
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

function render(view: SettingsPageView): void {
	const header = el('header', 'settings-header');
	const text = el('div');
	text.append(el('h1', undefined, strings.title), el('p', 'hint', strings.subtitle));
	header.append(text, button('secondary', strings.restart, () => post({ type: 'restart' }), 'debug-restart'));

	const servers = section(strings.servers, strings.serversHint, button('primary', strings.addServer, () => post({ type: 'addServer' }), 'add'));
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
	page.replaceChildren(header, servers, skills, hooks, extensions, memory, rules);
	if (focused) {
		[...page.querySelectorAll<HTMLElement>('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent) === focused)?.focus();
	}
}

window.addEventListener('message', (event: MessageEvent<ToSettingsPage>) => {
	if (event.data.type === 'view') {
		render(event.data.view);
	}
});

post({ type: 'ready' });
