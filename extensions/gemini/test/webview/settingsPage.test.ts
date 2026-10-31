/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// The Settings page (webview-src/settings.ts): every contributed section in
// the side index and on the page, the search, a row an administrator's policy
// locks, the messages a control sends, and rows patched in place.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLButtonElement, HTMLElement, HTMLInputElement } from 'happy-dom';
import type { SettingRowView, SettingSectionView, SettingsPageView } from '../../src/host/panelProtocol';
import type { SettingsPageStrings } from '../../src/host/panelStrings';
import { hostExport, page, posted, sendToPage, startScript } from './pages';

function row(key: string, more: Partial<SettingRowView> = {}): SettingRowView {
	return { key, label: key.split('.').pop()!, help: `About ${key}.`, control: 'toggle', value: false, default: false, target: 'global', locked: false, modified: false, advanced: false, ...more };
}

const sections: SettingSectionView[] = [
	{ id: 'account', title: 'Account and CLI', settings: [row('gemini.cliPath', { control: 'text', value: '', default: '', help: 'Where the `gemini` command is.' })] },
	{ id: 'agents', title: 'Agents', settings: [row('gemini.agents.ownBranch'), row('gemini.projects.maxRunningThreads', { control: 'number', value: 3, default: 3, minimum: 1, maximum: 8, advanced: true })] },
	{ id: 'chat', title: 'Chat', settings: [row('gemini.chat.sendWith', { control: 'picker', value: 'enter', default: 'enter', choices: [{ value: 'enter', label: 'Enter', help: 'Enter sends.' }, { value: 'ctrlEnter', label: 'Ctrl+Enter' }] })] },
	{ id: 'browser', title: 'Browser', settings: [row('gemini.browser.enabled', { value: true, default: true })] },
	{ id: 'index', title: 'Workspace Index and Docs', settings: [row('gemini.index.include', { control: 'list', value: ['src/**'], default: [], target: 'workspace', modified: true })] },
	{ id: 'team', title: 'Team Tools', settings: [row('gemini.team.runTeamServers', { value: true, default: true })] },
	{ id: 'admin', title: 'Administration', settings: [row('gemini.approval.allowYolo', { value: false, default: false, locked: true }), row('gemini.mcp.allowedServers', { control: 'list', value: ['github'], default: [], locked: true, modified: true })] },
	{ id: 'developer', title: 'Developer', settings: [row('gemini.developer.showTools', { value: true, default: false, modified: true }), row('gemini.old', { deprecated: 'Use gemini.developer.showTools.' })] },
];

function view(settings: readonly SettingSectionView[] = sections): SettingsPageView {
	return {
		settings,
		servers: [], skills: [], hooks: [], rules: [],
		extensions: { state: 'unavailable', message: 'Not running.' },
		memory: { state: 'unavailable', message: 'Not running.' },
		preferences: { defaultApprovalMode: 'default', defaultApprovalModeChoices: [{ value: 'default', label: 'Default' }], permanentApproval: true, planRouting: true, usageStatistics: false, keepChats: '30d', keepChatsChoices: [{ value: '30d', label: '30 days' }], display: '~/.gemini/settings.json' },
		contextCost: { state: 'none', folder: 'shop', folderPath: '/code/shop', readings: [], tips: [], note: 'Measuring costs model calls.' },
		developer: false,
		trust: { state: 'off', message: 'Folder trust is off.' },
	};
}

let strings: SettingsPageStrings;

beforeAll(async () => {
	strings = (await hostExport<() => SettingsPageStrings>('src/host/settingsPage.ts', 'settingsPageStrings'))();
	page.document.body.className = 'settings-page setup-page';
	page.document.body.innerHTML = `<main id="page" class="settings"></main><script type="module" data-strings='${JSON.stringify(strings).replace(/'/g, '&#39;')}'></script>`;
	let saved: unknown;
	Object.assign(globalThis, {
		acquireVsCodeApi: () => ({ postMessage: (message: { type: string }) => posted.push(message), getState: () => saved, setState: (state: unknown) => saved = state }),
	});
	await startScript('settings');
	posted.length = 0;
	sendToPage({ type: 'view', view: view() });
});

const main = () => page.document.getElementById('page') as HTMLElement;
const visibleRows = () => [...main().querySelectorAll('.row.setting')].filter(node => !(node as HTMLElement).hidden && !(node.closest('section') as HTMLElement).hidden).map(node => (node as HTMLElement).dataset.key);
const search = () => main().querySelector('.settings-search') as HTMLInputElement;

describe('the Settings page', () => {
	it('lists every section in the side index and on the page, then Loads and the other Agent Setup pages', () => {
		const links = [...main().querySelectorAll('.settings-index .index-link')].map(link => ({ text: link.textContent, section: (link as HTMLElement).dataset.section, tab: (link as HTMLElement).dataset.tab }));
		expect({
			links,
			headings: [...main().querySelectorAll('.settings-sections h2')].map(h => h.textContent),
			loads: [...main().querySelectorAll('.settings-loads h2')].map(h => h.textContent).slice(0, 3),
			title: main().querySelector('h1')?.textContent,
		}).toEqual({
			links: [
				...sections.map(section => ({ text: section.title, section: section.id, tab: undefined })),
				{ text: 'Loads', section: 'loads', tab: undefined },
				{ text: 'Index & Docs', section: undefined, tab: 'index' },
				{ text: 'Connections', section: undefined, tab: 'connections' },
				{ text: 'Storage & Audit', section: undefined, tab: 'audit' },
			],
			headings: sections.map(section => section.title),
			loads: ['Loads', 'Context per model call', 'MCP servers'],
			title: strings.title,
		});
	});

	it('shows each setting with its key, help with code, and the control its kind calls for; advanced and deprecated ones wait for a search', () => {
		const cliPath = main().querySelector('.row.setting[data-key="gemini.cliPath"]')!;
		expect({
			visible: visibleRows(),
			name: cliPath.querySelector('.name')?.textContent,
			key: cliPath.querySelector('.tag.mono')?.textContent,
			help: [...cliPath.querySelectorAll('.setting-help > *')].map(node => `${node.tagName.toLowerCase()}:${node.textContent}`),
			controls: ['gemini.cliPath', 'gemini.agents.ownBranch', 'gemini.projects.maxRunningThreads', 'gemini.chat.sendWith', 'gemini.index.include'].map(key => {
				const node = main().querySelector(`.row.setting[data-key="${key}"]`)!;
				return node.querySelector('.switch') ? 'switch' : node.querySelector('select') ? 'select' : node.querySelector('.setting-list') ? 'list' : (node.querySelector('input') as HTMLInputElement).type;
			}),
			entries: [...main().querySelectorAll('.row.setting[data-key="gemini.index.include"] .entry input')].map(input => (input as HTMLInputElement).value),
			workspaceNote: main().querySelector('.row.setting[data-key="gemini.index.include"] .row-note')?.textContent,
		}).toEqual({
			visible: ['gemini.cliPath', 'gemini.agents.ownBranch', 'gemini.chat.sendWith', 'gemini.browser.enabled', 'gemini.index.include', 'gemini.team.runTeamServers', 'gemini.approval.allowYolo', 'gemini.mcp.allowedServers', 'gemini.developer.showTools'],
			name: 'cliPath',
			key: 'gemini.cliPath',
			help: ['span:Where the ', 'code:gemini', 'span: command is.'],
			controls: ['text', 'switch', 'number', 'select', 'list'],
			entries: ['src/**'],
			workspaceNote: 'Saved for this workspace',
		});
	});

	it('filters by search, hiding Loads and showing advanced and deprecated settings that match', () => {
		search().value = 'threads';
		search().dispatchEvent(new page.Event('input'));
		const matched = { rows: visibleRows(), loadsHidden: (main().querySelector('.settings-loads') as HTMLElement).hidden, links: [...main().querySelectorAll('.settings-index .index-link')].filter(link => !(link as HTMLElement).hidden).map(link => link.textContent) };
		search().value = 'old';
		search().dispatchEvent(new page.Event('input'));
		const deprecated = visibleRows();
		search().value = 'nothing like this';
		search().dispatchEvent(new page.Event('input'));
		const none = { rows: visibleRows(), message: (main().querySelector('.settings-no-matches') as HTMLElement).hidden ? undefined : main().querySelector('.settings-no-matches')?.textContent };
		search().value = '';
		search().dispatchEvent(new page.Event('input'));
		expect({ matched, deprecated, none, back: visibleRows().length, loadsBack: (main().querySelector('.settings-loads') as HTMLElement).hidden }).toEqual({
			matched: { rows: ['gemini.projects.maxRunningThreads'], loadsHidden: true, links: ['Agents'] },
			deprecated: ['gemini.old'],
			none: { rows: [], message: 'No settings match "nothing like this".' },
			back: 9,
			loadsBack: false,
		});
	});

	it('shows a setting an administrator locks with a lock, its control disabled and no Reset', () => {
		const yolo = main().querySelector('.row.setting[data-key="gemini.approval.allowYolo"]')!;
		const servers = main().querySelector('.row.setting[data-key="gemini.mcp.allowedServers"]')!;
		const tools = main().querySelector('.row.setting[data-key="gemini.developer.showTools"]')!;
		expect({
			locked: yolo.classList.contains('locked'),
			note: yolo.querySelector('.row-note')?.textContent,
			lockIcon: yolo.querySelector('.row-note .codicon')?.className,
			switchDisabled: (yolo.querySelector('.switch') as HTMLButtonElement).disabled,
			resetHidden: (yolo.querySelector('.reset') as HTMLElement).hidden,
			listDisabled: [...servers.querySelectorAll('.setting-list input, .setting-list button')].map(node => (node as HTMLButtonElement).disabled),
			modifiedReset: (tools.querySelector('.reset') as HTMLElement).hidden,
			plainReset: (main().querySelector('.row.setting[data-key="gemini.agents.ownBranch"] .reset') as HTMLElement).hidden,
		}).toEqual({
			locked: true,
			note: 'Set by your administrator',
			lockIcon: 'codicon codicon-lock',
			switchDisabled: true,
			resetHidden: true,
			listDisabled: [true, true, true],
			modifiedReset: false,
			plainReset: true,
		});
	});

	it('posts a setting\'s new value when a control changes, and Reset', () => {
		posted.length = 0;
		(main().querySelector('.row.setting[data-key="gemini.agents.ownBranch"] .switch') as HTMLButtonElement).click();
		const sendWith = main().querySelector('.row.setting[data-key="gemini.chat.sendWith"] select') as unknown as { value: string; dispatchEvent(event: unknown): void };
		sendWith.value = '1';
		sendWith.dispatchEvent(new page.Event('change'));
		const threads = main().querySelector('.row.setting[data-key="gemini.projects.maxRunningThreads"] input') as HTMLInputElement;
		threads.value = '5';
		threads.dispatchEvent(new page.Event('change'));
		const entry = main().querySelector('.row.setting[data-key="gemini.index.include"] .entry input') as HTMLInputElement;
		entry.value = 'lib/**';
		entry.dispatchEvent(new page.Event('change'));
		(main().querySelector('.row.setting[data-key="gemini.developer.showTools"] .reset') as HTMLButtonElement).click();
		(main().querySelector('.settings-index .index-link[data-tab="connections"]') as HTMLButtonElement).click();
		expect(posted).toEqual([
			{ type: 'setSetting', key: 'gemini.agents.ownBranch', value: true },
			{ type: 'setSetting', key: 'gemini.chat.sendWith', value: 'ctrlEnter' },
			{ type: 'setSetting', key: 'gemini.projects.maxRunningThreads', value: 5 },
			{ type: 'setSetting', key: 'gemini.index.include', value: ['lib/**'] },
			{ type: 'resetSetting', key: 'gemini.developer.showTools' },
			{ type: 'openTab', tab: 'connections' },
		]);
	});

	it('patches rows in place when the host sends the view again, keeping the search', () => {
		const before = main().querySelector('.row.setting[data-key="gemini.agents.ownBranch"]')!;
		search().value = 'branch';
		search().dispatchEvent(new page.Event('input'));
		const changed = sections.map(section => ({ ...section, settings: section.settings.map(setting => setting.key === 'gemini.agents.ownBranch' ? { ...setting, value: true, modified: true } : setting) }));
		sendToPage({ type: 'view', view: view(changed) });
		const after = main().querySelector('.row.setting[data-key="gemini.agents.ownBranch"]')!;
		expect({
			same: before === after,
			on: after.querySelector('.switch')?.getAttribute('aria-checked'),
			reset: (after.querySelector('.reset') as HTMLElement).hidden,
			search: search().value,
			visible: visibleRows(),
		}).toEqual({ same: true, on: 'true', reset: false, search: 'branch', visible: ['gemini.agents.ownBranch'] });
	});

	it('lists Context per model call\'s readings as the CLI reported them, one row per test prompt, with the tips in words', () => {
		search().value = '';
		search().dispatchEvent(new page.Event('input'));
		sendToPage({
			type: 'view', view: {
				...view(), developer: true, contextCost: {
					state: 'ready', folder: 'shop', folderPath: '/code/shop', total: 64_740, measured: '2 hours ago, counted with gemini-3.1-flash-lite',
					readings: [{ label: 'Empty folder', tokens: 9_620 }, { label: 'This folder', tokens: 32_209 }, { label: 'This folder with gitlab', tokens: 52_743 }, { label: 'Everything agents get', tokens: 64_740 }],
					tips: ['gitlab accounts for much of it.'],
					note: 'Runs 5 test prompts.',
				},
			},
		});
		const section = main().querySelector('.context-cost')!.closest('section')!;
		expect({
			total: section.querySelector('.context-total .row-title')?.textContent,
			rows: [...section.querySelectorAll('.context-part')].map(row => [row.querySelector('.row-title')?.textContent, row.querySelector('.mono')?.textContent]),
			tips: [...section.querySelectorAll('.context-tip')].map(row => row.textContent),
			note: section.querySelector('.context-note span')?.textContent,
			bar: section.querySelector('.context-bar'),
		}).toEqual({
			total: '64,740 tokens in every model call',
			rows: [['Empty folder', '9,620'], ['This folder', '32,209'], ['This folder with gitlab', '52,743'], ['Everything agents get', '64,740']],
			tips: ['gitlab accounts for much of it.'],
			note: 'Runs 5 test prompts.',
			bar: null,
		});
	});
});
