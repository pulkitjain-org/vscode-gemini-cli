/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConductorReader, conductorSummary, parseTracks } from '../../src/acp/conductor';

describe('parseTracks', () => {
	it('reads Conductor\'s checkbox lines and their folders', () => {
		const tracks = parseTracks([
			'# Tracks',
			'',
			'---',
			'- [ ] **Track: Dark mode toggle** ([link](./tracks/dark-mode/))',
			'- [~] **Track: Fix login** ([link](./conductor/tracks/fix-login_20251001/))',
			'## [x] Track: Old work',
			'Some prose with [a link](./tracks/x/).',
		].join('\n'));
		expect(tracks).toEqual([
			{ id: 'dark-mode', title: 'Dark mode toggle', state: 'open' },
			{ id: 'fix-login_20251001', title: 'Fix login', state: 'in-progress' },
			{ id: 'old-work', title: 'Old work', state: 'done' },
		]);
	});
});

describe('ConductorReader', () => {
	it('reads the context and a track\'s brief, and nothing without the folder', async () => {
		const root = mkdtempSync(path.join(tmpdir(), 'conductor-'));
		expect(await new ConductorReader(root).read()).toBeUndefined();
		mkdirSync(path.join(root, 'conductor', 'tracks', 'dark-mode'), { recursive: true });
		writeFileSync(path.join(root, 'conductor', 'product.md'), 'A shop.');
		writeFileSync(path.join(root, 'conductor', 'tracks.md'), '- [ ] **Track: Dark mode** ([link](./tracks/dark-mode/))\n- [x] **Track: Done** ([link](./tracks/done/))');
		writeFileSync(path.join(root, 'conductor', 'tracks', 'dark-mode', 'spec.md'), 'A toggle in settings.');
		writeFileSync(path.join(root, 'conductor', 'tracks', 'dark-mode', 'plan.md'), '- [ ] Add the toggle');
		const reader = new ConductorReader(root);
		const context = await reader.read();
		expect(context).toMatchObject({ product: 'A shop.', tracks: [{ id: 'dark-mode' }, { id: 'done', state: 'done' }] });
		expect(conductorSummary(context!)).toContain('- dark-mode: Dark mode');
		expect(conductorSummary(context!)).not.toContain('done: Done');
		const brief = await reader.trackBrief('dark-mode');
		expect(brief).toContain('A toggle in settings.');
		expect(brief).toContain('- [ ] Add the toggle');
		expect(await reader.trackBrief('../etc')).toBeUndefined();
	});
});
