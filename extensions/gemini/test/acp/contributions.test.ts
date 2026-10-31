/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');

interface Keybinding {
	readonly command: string;
	readonly key: string;
	readonly mac?: string;
	readonly win?: string;
	readonly when?: string;
}

interface MenuEntry {
	readonly command?: string;
	readonly submenu?: string;
	readonly when?: string;
	readonly group?: string;
}

interface Contributions {
	readonly commands: readonly { readonly command: string; readonly title: string }[];
	readonly keybindings: readonly Keybinding[];
	readonly submenus: readonly { readonly id: string; readonly label: string }[];
	readonly menus: { readonly commandPalette: readonly { readonly command: string; readonly when?: string }[] } & Record<string, readonly MenuEntry[]>;
	readonly configuration: readonly { readonly title: string; readonly properties: Record<string, unknown> }[];
}

const contributes = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { contributes: Contributions }).contributes;
const strings = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
const keysOf = (binding: Keybinding) => [binding.key, binding.mac, binding.win].filter(Boolean);

describe('package.json', () => {
	it('keeps the review\'s keys off keys that edit text', () => {
		// ⌘↩ inserts a line, ⌘⌫ deletes to the line start, and ⌥[ ⌥] type characters on many layouts.
		const editing = new Set(['cmd+enter', 'ctrl+enter', 'cmd+backspace', 'ctrl+backspace', 'alt+[', 'alt+]', 'cmd+alt+[', 'cmd+alt+]', 'ctrl+alt+[', 'ctrl+alt+]', 'cmd+alt+backspace', 'ctrl+alt+backspace']);
		const review = contributes.keybindings.filter(binding => binding.command.startsWith('gemini.review.'));
		expect(review.map(binding => binding.command).sort()).toEqual(['gemini.review.keepFile', 'gemini.review.nextChange', 'gemini.review.previousChange', 'gemini.review.undoFile']);
		expect(review.flatMap(keysOf).filter(key => editing.has(key!))).toEqual([]);
	});

	it('binds the chat\'s commands to the agent\'s tab only, and shows them in the palette', () => {
		const chat = ['gemini.agents.stop', 'gemini.agents.cycleMode', 'gemini.agents.switchModel'];
		expect(chat.map(command => contributes.keybindings.find(binding => binding.command === command)?.when)).toEqual(chat.map(() => 'activeWebviewPanelId == \'gemini.agent\''));
		expect(chat.map(command => contributes.menus.commandPalette.find(entry => entry.command === command)?.when)).toEqual(chat.map(() => 'activeWebviewPanelId == \'gemini.agent\''));
		expect(contributes.keybindings.find(binding => binding.command === 'gemini.agents.focusChat')).toBeDefined();
	});

	it('gives each key one command in the same place', () => {
		const seen = new Map<string, string>();
		const clashes: string[] = [];
		for (const binding of contributes.keybindings) {
			for (const key of keysOf(binding)) {
				const id = `${key} when ${binding.when ?? ''}`;
				if (seen.has(id) && seen.get(id) !== binding.command) {
					clashes.push(`${id}: ${seen.get(id)} and ${binding.command}`);
				}
				seen.set(id, binding.command);
			}
		}
		expect(clashes).toEqual([]);
	});

	it('keeps developer tools out of the palette unless gemini.developer.showTools is on', () => {
		const tools = ['gemini.runBenchmark', 'gemini.recordTrace', 'gemini.showStatusMenu', 'gemini.newSkill', 'gemini.installCli', 'gemini.installCliVersion'];
		expect(tools.filter(command => !contributes.menus.commandPalette.find(entry => entry.command === command)?.when?.includes('config.gemini.developer.showTools'))).toEqual([]);
		expect(contributes.configuration.some(section => Object.hasOwn(section.properties, 'gemini.developer.showTools'))).toBe(true);
	});

	it('orders the settings in eight sections, with the removed ones read for a release under a deprecation message', () => {
		const sections = contributes.configuration.map(section => ({ title: strings[section.title.slice(1, -1)], order: (section as { readonly order?: number }).order, settings: Object.keys(section.properties).length }));
		const deprecated = contributes.configuration.flatMap(section => Object.entries(section.properties).filter(([, p]) => Object.hasOwn(p as object, 'deprecationMessage')).map(([key]) => key));
		const enums = contributes.configuration.flatMap(section => Object.entries(section.properties).filter(([, p]) => Array.isArray((p as { enum?: unknown }).enum) && !Array.isArray((p as { enumItemLabels?: unknown }).enumItemLabels)).map(([key]) => key));
		expect({ sections, deprecated, enums }).toEqual({
			sections: [
				{ title: 'Gemini: Account and CLI', order: 1, settings: 8 },
				{ title: 'Gemini: Agents', order: 2, settings: 14 },
				{ title: 'Gemini: Chat', order: 3, settings: 8 },
				{ title: 'Gemini: Browser', order: 4, settings: 3 },
				{ title: 'Gemini: Workspace Index and Docs', order: 5, settings: 5 },
				{ title: 'Gemini: Team Tools', order: 6, settings: 3 },
				{ title: 'Gemini: Safety and Limits', order: 7, settings: 10 },
				{ title: 'Gemini: Developer', order: 8, settings: 1 },
			],
			deprecated: ['gemini.agent.startEarly', 'gemini.notifications.enabled', 'gemini.agents.mergeBack', 'gemini.storage.keepLogsDays'],
			enums: [],
		});
	});

	it('puts New agent and New project in the Agents pane\'s title bar, the rest under its ...', () => {
		const title = contributes.menus['view/title'].filter(entry => entry.when?.startsWith('view == gemini.agents'));
		expect(title.map(entry => `${entry.command} ${entry.group}`)).toEqual([
			'gemini.agents.newAgent navigation@1',
			'gemini.projects.new navigation@2',
			'gemini.agents.addWorkspace 1_more@1',
			'gemini.home 1_more@2',
			'gemini.reviewChanges 1_more@3',
			'gemini.projectSettings 1_more@4',
			'gemini.connections 1_more@5',
		]);
		expect(title.find(entry => entry.command === 'gemini.projects.new')?.when).toBe('view == gemini.agents && config.gemini.projects.enabled');
	});

	it('gives an agent row Open, Rename, Fork, Stop, More and Remove, and a workspace row its starts, Index and Remove', () => {
		const rows = contributes.menus['view/item/context'].filter(entry => !entry.group?.startsWith('inline'));
		const on = (row: RegExp) => rows.filter(entry => row.test(entry.when ?? '')).map(entry => `${entry.command ?? `submenu ${entry.submenu}`} ${entry.group}`);
		expect({ agent: on(/\^agent|\\\.(forkable|busy)/), workspace: on(/\^workspace/) }).toEqual({
			agent: ['gemini.agents.open 1_agent@1', 'gemini.agents.rename 1_agent@2', 'gemini.agents.fork 1_agent@3', 'gemini.agents.stop 1_agent@4', 'submenu gemini.agents.more 2_more@1', 'gemini.agents.remove 3_remove@1'],
			workspace: ['gemini.agents.newAgent 1_agent@1', 'gemini.agents.newAgentOnBranch 1_agent@2', 'gemini.projects.new 1_agent@3', 'submenu gemini.agents.index 2_more@1', 'gemini.agents.removeWorkspace 3_remove@1'],
		});
		// Nothing is left on a section row: the list has none.
		expect(contributes.menus['view/item/context'].filter(entry => entry.when?.includes('section'))).toEqual([]);
	});

	it('keeps the rest of an agent row\'s menu under More, and a workspace\'s index commands under Index, each with the when clause of its row', () => {
		expect(contributes.submenus.map(submenu => [submenu.id, strings[submenu.label.slice(1, -1)]])).toEqual([['gemini.agents.more', 'More'], ['gemini.agents.index', 'Index']]);
		const more = contributes.menus['gemini.agents.more'].map(entry => [entry.command, entry.when?.replace('view == gemini.agents && ', '')]);
		expect(more).toEqual([
			['gemini.agents.openChanges', 'viewItem =~ /\\.changes$/'],
			['gemini.agents.mergeBack', 'viewItem =~ /\\.worktree/'],
			['gemini.agents.tryInWorkspace', 'viewItem =~ /\\.worktree/'],
			['gemini.agents.takeBack', 'viewItem =~ /\\.trying/'],
			['gemini.agents.moveToBranch', 'viewItem =~ /\\.movable/'],
			['gemini.debug.start', 'viewItem =~ /^agent/ && config.gemini.debugMode.enabled'],
			['gemini.agents.openTerminal', 'viewItem =~ /^agent/'],
			['gemini.agents.openAsMarkdown', 'viewItem =~ /^agent/'],
			['gemini.agents.keepTab', 'viewItem =~ /^agent/'],
			['gemini.projects.newThread', 'viewItem =~ /\\.project$/ && config.gemini.projects.enabled'],
			['gemini.projects.settings', 'viewItem =~ /\\.project$/ && config.gemini.projects.enabled'],
		]);
		const index = contributes.menus['gemini.agents.index'].map(entry => [entry.command, entry.when?.replace('view == gemini.agents && ', '')]);
		expect(index).toEqual([
			['gemini.index.open', 'viewItem =~ /^workspace(\\.git)?$/'],
			['gemini.index.rebuild', 'viewItem =~ /^workspace(\\.git)?$/ && config.gemini.index.enabled'],
			['gemini.index.pause', 'viewItem =~ /^workspace(\\.git)?$/ && config.gemini.index.enabled'],
		]);
		// Every submenu entry's when clause names the view, as its row's does.
		expect([...contributes.menus['gemini.agents.more'], ...contributes.menus['gemini.agents.index']].filter(entry => !entry.when?.startsWith('view == gemini.agents && '))).toEqual([]);
	});

	it('offers Keep in own tab in the shared agent tab\'s title bar, and from nowhere in the palette', () => {
		expect(contributes.menus['editor/title'].find(entry => entry.command === 'gemini.agents.keepTab')?.when).toBe('activeWebviewPanelId == \'gemini.agent\' && gemini.sharedAgentTab');
		expect(contributes.menus.commandPalette.find(entry => entry.command === 'gemini.agents.keepTab')?.when).toBe('false');
		expect(strings['command.agents.keepTab']).toBe('Keep in own tab');
	});

	it('offers Move to its own branch in the title bar of an agent in the user\'s checkout, in its row\'s More menu, and from nowhere in the palette', () => {
		expect(contributes.menus['editor/title'].find(entry => entry.command === 'gemini.agents.moveToBranch')?.when).toBe('activeWebviewPanelId == \'gemini.agent\' && gemini.agentMovable');
		expect(contributes.menus['gemini.agents.more'].find(entry => entry.command === 'gemini.agents.moveToBranch')?.when).toBe('view == gemini.agents && viewItem =~ /\\.movable/');
		expect(contributes.menus.commandPalette.find(entry => entry.command === 'gemini.agents.moveToBranch')?.when).toBe('false');
		expect(strings['command.agents.moveToBranch']).toBe('Move to its own branch');
	});

	it('has a string for every command title and setting description', () => {
		const keys = [
			...contributes.commands.map(command => command.title),
			...contributes.configuration.flatMap(section => [section.title, ...Object.values(section.properties).map(p => (p as { markdownDescription?: string }).markdownDescription ?? '')]),
		].filter(text => /^%.+%$/.test(text)).map(text => text.slice(1, -1));
		expect(keys.filter(key => !Object.hasOwn(strings, key))).toEqual([]);
	});
});
