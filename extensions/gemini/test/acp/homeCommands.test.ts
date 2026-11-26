/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');

describe('Home\'s buttons', () => {
	it('run only commands that exist', () => {
		// The cards' buttons, and the commands the page's own controls run (Connect, the gear menu's Settings).
		const source = ['src/host/homeDashboard.ts', 'src/host/agentHome.ts', 'webview-src/homePopups.ts'].map(file => readFileSync(path.join(root, file), 'utf8')).join('\n');
		const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { contributes: { commands: { command: string }[]; views: Record<string, { id: string }[]> } };
		const known = new Set([
			...pkg.contributes.commands.map(c => c.command),
			// Every view gets a focus command.
			...Object.values(pkg.contributes.views).flat().map(v => `${v.id}.focus`),
			'workbench.action.files.openFolder',
		]);
		const used = [...source.matchAll(/command\('([^']+)'|command: '([^']+)'/g)].map(m => m[1] ?? m[2]);
		expect(used.length).toBeGreaterThan(0);
		expect(used.filter(id => !known.has(id))).toEqual([]);
	});
});
