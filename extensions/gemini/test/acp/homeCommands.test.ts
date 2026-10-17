/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');

describe('Home\'s buttons', () => {
	it('run only commands that exist', () => {
		const source = readFileSync(path.join(root, 'src', 'host', 'homeDashboard.ts'), 'utf8');
		const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { contributes: { commands: { command: string }[]; views: Record<string, { id: string }[]> } };
		const known = new Set([
			...pkg.contributes.commands.map(c => c.command),
			// Every view gets a focus command.
			...Object.values(pkg.contributes.views).flat().map(v => `${v.id}.focus`),
			'workbench.action.files.openFolder',
		]);
		const used = [...source.matchAll(/command\('([^']+)'/g)].map(m => m[1]);
		expect(used.length).toBeGreaterThan(0);
		expect(used.filter(id => !known.has(id))).toEqual([]);
	});
});
