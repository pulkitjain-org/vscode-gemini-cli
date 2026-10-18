/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Connections page (src/host/connectionsPage.ts): the team's tools, each
// with its logo and state, and an in-page dialog to connect one.

import type { TeamToolId } from '../src/acp/teamHttp';
import type { ConnectionRowView, ConnectionsStrings, ConnectionsView, FromConnections, ToConnections } from '../src/host/connectionsProtocol';
import { button, el, format, icon, pageStrings } from './panelDom';
import { toolLogo } from './toolLogos';

declare function acquireVsCodeApi(): { postMessage(message: FromConnections): void };

const vscode = acquireVsCodeApi();
const strings = pageStrings<ConnectionsStrings>();
const page = document.getElementById('page')!;

let view: ConnectionsView | undefined;
/** The open Connect dialog, if any. */
let dialog: { readonly tool: TeamToolId; readonly node: HTMLElement; readonly result: HTMLElement; readonly submit: HTMLButtonElement; readonly returnFocus: HTMLElement | null } | undefined;

function post(message: FromConnections): void {
	vscode.postMessage(message);
}

function stateClass(row: ConnectionRowView): string {
	switch (row.kind) {
		case 'connected':
			return 'ok';
		case 'checking':
		case 'off':
			return 'idle';
		case 'unreachable':
			return row.tool === 'figma' ? 'idle' : 'warn';
		default:
			return 'error';
	}
}

function logoTile(tool: TeamToolId, size = 20): HTMLElement {
	const tile = el('div', 'tool-tile');
	tile.append(toolLogo(tool, size));
	return tile;
}

function toolRow(row: ConnectionRowView): HTMLElement {
	const node = el('div', `row tool-row${row.saved ? '' : ' not-connected'}`);
	node.dataset.tool = row.tool;
	const main = el('div', 'row-main');
	const title = el('div', 'row-title');
	const state = el('span', `state-pill ${stateClass(row)}`);
	state.append(el('span', 'state-dot'), el('span', undefined, row.label));
	title.append(el('span', 'name', row.name), state, ...row.pills.map(pill => el('span', 'tag', pill)));
	main.append(title);
	if (row.detail) {
		main.append(el('div', 'row-detail', row.detail));
	}
	if (row.token) {
		main.append(el('div', 'row-detail', row.token));
	}
	const actions = el('div', 'row-actions');
	if (!row.saved && row.kind === 'checking') {
		// Connecting Snyk or Figma: the check runs; the row shows its answer.
		const busy = button('', strings.checking, () => undefined);
		busy.prepend(spinner());
		busy.disabled = true;
		actions.append(busy);
	} else if (!row.saved) {
		const connectButton = button('', strings.connect, () => {
			if (!row.needsToken) {
				connectButton.disabled = true;
				connectButton.replaceChildren(spinner(), el('span', undefined, strings.checking));
			}
			connect(row);
		});
		actions.append(connectButton);
	} else {
		if (row.kind === 'unreachable' && row.tool === 'figma') {
			actions.append(button('', strings.openFigma, () => post({ type: 'openFigma' })));
		} else if (row.kind !== 'connected' && row.kind !== 'checking') {
			actions.append(button('', strings.tryAgain, () => post({ type: 'refresh', tool: row.tool })));
		}
		if (row.needsToken) {
			actions.append(button('quiet', strings.replaceToken, () => openDialog(row)));
		}
		actions.append(button('quiet', strings.disconnect, () => post({ type: 'disconnect', tool: row.tool })));
	}
	const logo = el('span', 'tool-mark');
	logo.append(toolLogo(row.tool, 22));
	node.append(logo, main, actions);
	return node;
}

function connect(row: ConnectionRowView): void {
	if (row.needsToken) {
		openDialog(row);
	} else {
		// Snyk and Figma need no token: turn on and check.
		post({ type: 'connect', tool: row.tool });
	}
}

function permissionRow(title: string, detail: string, answer: string, tools: readonly TeamToolId[]): HTMLElement {
	const node = el('div', 'row permission-row');
	const main = el('div', 'row-main');
	const heading = el('div', 'row-title');
	heading.append(el('span', 'name', title));
	const logos = el('span', 'permission-logos');
	tools.forEach(tool => logos.append(toolLogo(tool, 13)));
	heading.append(logos);
	main.append(heading, el('div', 'row-detail', detail));
	node.append(main, el('span', 'tag', answer));
	return node;
}

function render(): void {
	if (!view) {
		return;
	}
	const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.tool-row')?.dataset.tool;
	page.replaceChildren();
	const header = el('header', 'settings-header');
	const intro = el('div');
	intro.append(el('h1', undefined, strings.title), el('p', 'hint', strings.subtitle));
	const headerActions = el('div', 'section-actions');
	headerActions.append(button('', strings.checkAll, () => post({ type: 'checkAll' }), 'refresh'));
	header.append(intro, headerActions);
	page.append(header);

	if (view.teamServers) {
		// The repository runs its own Jira and GitLab servers in the CLI: say what that means, and open the file.
		const card = el('section', 'team-servers');
		card.append(el('h2', undefined, format(strings.teamServersTitle, view.teamServers.file, view.teamServers.servers.map(s => s.name).join(', '))), el('p', 'hint', strings.teamServersText));
		const list = el('ul', 'team-server-list');
		for (const server of view.teamServers.servers) {
			const item = el('li');
			const tools = server.included || server.excluded ? format(strings.teamServerTools, String(server.included ?? ''), String(server.excluded ?? 0)) : '';
			item.append(el('strong', undefined, server.name), el('span', 'mono', ` · ${[format(strings.teamServerLine, server.image ?? '', server.tokenEnv.map(v => `$${v}`).join(', ')), tools].filter(Boolean).join(' · ')}`));
			list.append(item);
		}
		const actions = el('div', 'row-actions');
		actions.append(button('', strings.openSettings, () => post({ type: 'openTeamServers' })));
		card.append(list, actions);
		page.append(card);
	}

	if (view.allowlist) {
		const note = el('div', 'allowlist-note');
		const text = view.allowlist.kind === 'notAllowed' ? format(strings.allowlistNotAllowed, view.allowlist.file, 'geminicode-tools')
			: view.allowlist.kind === 'excluded' ? format(strings.allowlistExcluded, view.allowlist.file, 'geminicode-tools')
				: format(strings.allowlistAdminOff, view.allowlist.file);
		const body = el('div', 'allowlist-text');
		body.append(icon('warning'), el('span', undefined, text));
		const actions = el('div', 'row-actions');
		if (view.allowlist.kind !== 'adminOff') {
			actions.append(button('primary', strings.addToAllowlist, () => post({ type: 'allowlist' })));
		}
		actions.append(button('quiet', strings.openFile, () => post({ type: 'openAllowlistFile' })));
		note.append(body, actions);
		page.append(note);
	}

	const tools = el('section', 'settings-section');
	const toolsHeader = el('div', 'section-header');
	const toolsText = el('div');
	const hint = el('p', 'hint');
	if (view.defaultsFile) {
		const link = el('a', 'mono', view.defaultsFile);
		link.href = '#';
		link.addEventListener('click', event => {
			event.preventDefault();
			post({ type: 'openDefaults' });
		});
		const [before, after] = strings.defaultsHint.split('{0}');
		hint.append(before ?? '', link, after ?? '');
	} else {
		hint.textContent = strings.toolsHint;
	}
	toolsText.append(el('h2', undefined, strings.tools), hint);
	toolsHeader.append(toolsText);
	const rows = el('div', 'rows');
	view.rows.forEach(row => rows.append(toolRow(row)));
	tools.append(toolsHeader, rows);
	page.append(tools);

	const permissions = el('section', 'settings-section');
	const permissionsHeader = el('div', 'section-header');
	const permissionsText = el('div');
	permissionsText.append(el('h2', undefined, strings.permissions), el('p', 'hint', strings.permissionsHint));
	permissionsHeader.append(permissionsText);
	const permissionRows = el('div', 'rows');
	permissionRows.append(
		permissionRow(strings.reads, strings.readsDetail, strings.alwaysAllowed, ['jira', 'gitlab', 'sonar', 'snyk', 'figma']),
		permissionRow(strings.writes, strings.writesDetail, strings.askEachTime, ['jira', 'gitlab']),
		permissionRow(strings.confirmWrites, strings.confirmWritesDetail, strings.askOnceOnly, ['jira', 'gitlab']),
	);
	permissions.append(permissionsHeader, permissionRows);
	page.append(permissions);

	if (focused) {
		page.querySelector<HTMLElement>(`.tool-row[data-tool="${focused}"] button`)?.focus();
	}
}

function field(label: string, hint: string, input: HTMLInputElement, trailing?: HTMLElement): HTMLElement {
	const node = el('label', 'dialog-field');
	node.append(el('span', 'field-label', label), el('span', 'hint', hint));
	const box = el('div', 'field-box');
	box.append(input);
	if (trailing) {
		box.append(trailing);
	}
	node.append(box);
	return node;
}

function input(type: string, value: string, placeholder: string, autocomplete: AutoFill): HTMLInputElement {
	const node = el('input');
	node.type = type;
	node.value = value;
	node.placeholder = placeholder;
	node.autocomplete = autocomplete;
	node.spellcheck = false;
	return node;
}

function openDialog(row: ConnectionRowView): void {
	closeDialog();
	const returnFocus = document.activeElement as HTMLElement | null;
	const backdrop = el('div', 'dialog-backdrop');
	const box = el('div', 'dialog');
	box.setAttribute('role', 'dialog');
	box.setAttribute('aria-modal', 'true');
	const titleId = `connect-${row.tool}`;
	box.setAttribute('aria-labelledby', titleId);

	const head = el('div', 'dialog-head');
	const title = el('h2', undefined, format(strings.connectTitle, row.name));
	title.id = titleId;
	head.append(logoTile(row.tool, 18), title, button('icon-button', '', closeDialog, 'close', strings.close));

	const server = input('url', row.url ?? '', row.tool === 'jira' ? 'https://your-site.atlassian.net' : `https://${row.tool === 'sonar' ? 'sonar' : 'gitlab'}.example.internal`, 'off');
	const serverHint = [row.urlFromDefaults ? strings.serverHintDefaults : format(strings.serverHint, row.name), row.tool === 'jira' ? '' : format(strings.serverHintVpn, row.name)].filter(Boolean).join(' ');
	const email = input('email', row.email ?? '', 'you@company.com', 'email');
	const token = input('password', '', '', 'off');
	const create = button('link-button', strings.createToken, () => post({ type: 'createToken', tool: row.tool, url: server.value.trim() || undefined }), 'link-external');
	create.disabled = row.tool !== 'jira' && !server.value.trim();
	server.addEventListener('input', () => create.disabled = row.tool !== 'jira' && !server.value.trim());
	const tokenHint = row.tool === 'jira' ? strings.tokenHintJira : row.tool === 'gitlab' ? strings.tokenHintGitlab : strings.tokenHintSonar;

	const body = el('div', 'dialog-body');
	body.append(field(strings.server, serverHint, server));
	if (row.tool === 'jira') {
		body.append(field(strings.email, strings.emailHint, email));
	}
	body.append(field(strings.token, tokenHint, token, create));
	const result = el('div', 'dialog-result');
	result.setAttribute('role', 'status');
	const note = el('div', 'keychain-note');
	note.append(icon('lock'), el('span', undefined, format(strings.keychainNote, row.name)));
	body.append(result, note);

	const foot = el('div', 'dialog-foot');
	const submit = button('primary', strings.connect, () => submitDialog(row, server, email, token));
	foot.append(el('span', 'spacer'), button('', strings.cancel, closeDialog), submit);

	box.append(head, body, foot);
	box.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeDialog();
		} else if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
			event.preventDefault();
			submit.click();
		} else if (event.key === 'Tab') {
			// Keep focus inside the dialog.
			const focusable = [...box.querySelectorAll<HTMLElement>('input, button:not(:disabled)')];
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		}
	});
	backdrop.addEventListener('mousedown', event => event.target === backdrop && closeDialog());
	backdrop.append(box);
	document.body.append(backdrop);
	dialog = { tool: row.tool, node: backdrop, result, submit, returnFocus };
	(server.value ? row.tool === 'jira' && !email.value ? email : token : server).focus();
}

function submitDialog(row: ConnectionRowView, server: HTMLInputElement, email: HTMLInputElement, token: HTMLInputElement): void {
	if (!dialog) {
		return;
	}
	dialog.result.className = 'dialog-result checking';
	dialog.result.replaceChildren(icon('loading'), el('span', undefined, strings.checking));
	dialog.result.querySelector('.codicon')?.classList.add('codicon-modifier-spin');
	dialog.submit.disabled = true;
	post({ type: 'connect', tool: row.tool, url: server.value.trim(), email: row.tool === 'jira' ? email.value.trim() : undefined, token: token.value.trim() });
}

function closeDialog(): void {
	if (!dialog) {
		return;
	}
	const { node, returnFocus } = dialog;
	dialog = undefined;
	node.remove();
	returnFocus?.focus();
}

function spinner(): HTMLElement {
	const node = icon('loading');
	node.classList.add('codicon-modifier-spin');
	return node;
}

function showRowError(tool: TeamToolId, text: string): void {
	const row = page.querySelector<HTMLElement>(`.tool-row[data-tool="${tool}"]`);
	if (!row) {
		return;
	}
	row.querySelector('.row-error')?.remove();
	const error = el('div', 'row-detail row-error');
	error.append(icon('error'), el('span', undefined, text));
	row.querySelector('.row-main')?.append(error);
	row.querySelectorAll<HTMLButtonElement>('.row-actions button').forEach(b => b.disabled = false);
}

window.addEventListener('message', (event: MessageEvent<ToConnections>) => {
	const message = event.data;
	switch (message.type) {
		case 'view':
			view = message.view;
			render();
			return;
		case 'connectResult':
			if (dialog?.tool !== message.tool) {
				if (!message.ok) {
					// Snyk and Figma have no dialog: the row says what went wrong.
					showRowError(message.tool, message.message ?? '');
				}
				return;
			}
			if (message.ok) {
				closeDialog();
				return;
			}
			dialog.submit.disabled = false;
			dialog.result.className = 'dialog-result error';
			dialog.result.replaceChildren(icon('error'), el('span', undefined, message.message ?? ''));
			return;
	}
});

post({ type: 'ready' });
