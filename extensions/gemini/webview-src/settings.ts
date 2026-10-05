/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The MCP Servers and Rules page (src/host/settingsPage.ts).

import type { FromSettingsPage, McpServerView, RulesFileView, SettingsPageStrings, SettingsPageView, ToSettingsPage } from '../src/host/panelProtocol';
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

function serverRow(server: McpServerView): HTMLElement {
	const row = el('div', `row server${server.enabled ? '' : ' off'}`);
	const toggle = el('button', `switch${server.enabled ? ' on' : ''}`);
	toggle.type = 'button';
	toggle.setAttribute('role', 'switch');
	toggle.setAttribute('aria-checked', String(server.enabled));
	toggle.setAttribute('aria-label', `${strings.enable}: ${server.name}`);
	toggle.title = strings.enable;
	toggle.addEventListener('click', () => {
		toggle.classList.toggle('on');
		toggle.setAttribute('aria-checked', String(!server.enabled));
		post({ type: 'toggle', name: server.name, enabled: !server.enabled });
	});
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
	const list = el('div', 'rows');
	list.append(...view.servers.map(serverRow));
	if (!view.servers.length) {
		list.append(el('p', 'empty', strings.noServers));
	}
	servers.append(list);

	const rules = section(strings.rules, strings.rulesHint);
	const rulesList = el('div', 'rows');
	rulesList.append(...view.rules.map(rulesRow));
	rules.append(rulesList);

	// Re-rendering replaces every element; keep keyboard focus on the same control.
	const focused = document.activeElement instanceof HTMLElement && page.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent : undefined;
	page.replaceChildren(header, servers, rules);
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
