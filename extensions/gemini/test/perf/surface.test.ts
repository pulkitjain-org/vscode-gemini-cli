/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Surface budgets: how much of GeminiCode a user can see at once. Each count
// comes from package.json or Home's markup, and a change that adds a command
// to the palette, a setting, a row to a right-click menu or a control to
// Home fails here, as a bundle growing by a library fails the size budgets.
// Raise a budget on purpose, with the reason in its comment; the aim is for
// them to fall (ARCHITECTURE.md, design rules: one place per job).

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');

interface Contributions {
	readonly commands: readonly { readonly command: string }[];
	readonly menus: Record<string, readonly { readonly command: string; readonly when?: string; readonly group?: string }[]>;
	readonly configuration: readonly { readonly properties: Record<string, { readonly deprecationMessage?: string }> }[];
}

const contributes = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { contributes: Contributions }).contributes;

/** The budgets, with the count as of the latest change to each. */
export const surfaceBudgets = {
	// Commands in the palette with developer tools off: 49 as of 1.7.
	paletteCommands: 49,
	// Commands the palette adds with gemini.developer.showTools on: 8.
	developerCommands: 8,
	// Settings that are not deprecated: 47 as of 1.7.
	settings: 47,
	// Right-click entries an agent row can show at most (its own, a project's, a forkable one's, one on a worktree, one being tried): 12 as of 1.7.
	agentRowMenu: 12,
	// Right-click entries on a workspace row: 7 as of 1.7.
	workspaceRowMenu: 7,
	// Buttons in Home's own markup, its cards' and menus' aside: 13 as of 1.7.
	homeControls: 13,
} as const;

function paletteWhen(command: string): string | undefined {
	return contributes.menus.commandPalette.find(entry => entry.command === command)?.when;
}

describe('surface budgets', () => {
	const visible = contributes.commands.filter(({ command }) => paletteWhen(command) !== 'false');
	const developer = visible.filter(({ command }) => paletteWhen(command)?.includes('config.gemini.developer.showTools'));

	it('keeps the command palette within budget', () => {
		expect(visible.length - developer.length).toBeLessThanOrEqual(surfaceBudgets.paletteCommands);
		expect(developer.length).toBeLessThanOrEqual(surfaceBudgets.developerCommands);
	});

	it('keeps the settings within budget', () => {
		const settings = contributes.configuration.flatMap(section => Object.values(section.properties)).filter(setting => !setting.deprecationMessage);
		expect(settings.length).toBeLessThanOrEqual(surfaceBudgets.settings);
	});

	it('keeps the Agents list\'s right-click menus within budget', () => {
		const entries = contributes.menus['view/item/context'].filter(entry => !entry.group?.startsWith('inline'));
		const on = (row: RegExp) => entries.filter(entry => row.test(entry.when ?? '')).length;
		expect(on(/viewItem =~ \/\^agent|viewItem =~ \/\\\.(project|changes|forkable|worktree|trying)/)).toBeLessThanOrEqual(surfaceBudgets.agentRowMenu);
		expect(on(/viewItem =~ \/\^workspace/)).toBeLessThanOrEqual(surfaceBudgets.workspaceRowMenu);
	});

	it('keeps Home\'s own controls within budget', () => {
		const markup = readFileSync(path.join(root, 'src', 'host', 'agentHome.ts'), 'utf8');
		expect((markup.match(/<button\b/g) ?? []).length).toBeLessThanOrEqual(surfaceBudgets.homeControls);
	});
});
