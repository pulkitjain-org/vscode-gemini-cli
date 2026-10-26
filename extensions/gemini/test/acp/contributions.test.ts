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

interface Contributions {
	readonly commands: readonly { readonly command: string; readonly title: string }[];
	readonly keybindings: readonly Keybinding[];
	readonly menus: { readonly commandPalette: readonly { readonly command: string; readonly when?: string }[] };
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
		const tools = ['gemini.runBenchmark', 'gemini.pilot.export', 'gemini.recordTrace', 'gemini.showStatusMenu', 'gemini.newSkill', 'gemini.installCli', 'gemini.installCliVersion'];
		expect(tools.filter(command => !contributes.menus.commandPalette.find(entry => entry.command === command)?.when?.includes('config.gemini.developer.showTools'))).toEqual([]);
		expect(contributes.configuration.some(section => Object.hasOwn(section.properties, 'gemini.developer.showTools'))).toBe(true);
	});

	it('puts the pilot and reaction settings under Advanced', () => {
		const advanced = contributes.configuration.find(section => strings[section.title.slice(1, -1)] === 'Advanced');
		expect(Object.keys(advanced?.properties ?? {}).sort()).toEqual(['gemini.chat.reactions.agentReactions', 'gemini.chat.reactions.enabled', 'gemini.chat.reactions.meanings', 'gemini.developer.showTools', 'gemini.pilot.record']);
	});

	it('has a string for every command title and setting description', () => {
		const keys = [
			...contributes.commands.map(command => command.title),
			...contributes.configuration.flatMap(section => [section.title, ...Object.values(section.properties).map(p => (p as { markdownDescription?: string }).markdownDescription ?? '')]),
		].filter(text => /^%.+%$/.test(text)).map(text => text.slice(1, -1));
		expect(keys.filter(key => !Object.hasOwn(strings, key))).toEqual([]);
	});
});
