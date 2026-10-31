/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The settings guide is written from package.json (scripts/settings-doc.mts):
// this fails when a settings change was not followed by `node scripts/settings-doc.mts`.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSettingsDoc } from '../../src/acp/settingsDoc';

const extension = path.join(__dirname, '..', '..');
const root = path.join(extension, '..', '..');
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

describe('settings guide', () => {
	it('is what package.json renders; run node scripts/settings-doc.mts after a settings change', () => {
		const rendered = renderSettingsDoc({
			configuration: read(path.join(extension, 'package.json')).contributes.configuration,
			strings: read(path.join(extension, 'package.nls.json')),
		});
		expect(readFileSync(path.join(root, 'gemini', 'docs', 'guide', 'settings.md'), 'utf8')).toBe(rendered);
	});

	it('renders a section with its defaults, choices, and the deprecated names apart', () => {
		const doc = renderSettingsDoc({
			configuration: [{ title: '%t%', order: 2, properties: { 'gemini.b': { type: 'string', enum: ['x', 'y'], enumItemLabels: ['Ex', 'Why'], default: 'x', markdownDescription: 'Picks. See #gemini.a#.' }, 'gemini.old': { type: 'boolean', default: true, deprecationMessage: 'Renamed to gemini.a.' } } }, { title: 'First', order: 1, properties: { 'gemini.a': { type: 'boolean', default: true, scope: 'machine', markdownDescription: 'Does a thing.' } as never } }],
			strings: { t: 'Gemini: Second' },
		});
		expect(doc.split('\n').filter(line => line.startsWith('## ') || line.startsWith('| `'))).toEqual([
			'## First',
			'| `gemini.a` *(machine)* | on | Does a thing. |',
			'## Second',
			'| `gemini.b` | Ex (`x`) | Picks. See `gemini.a`. Choices: Ex (`x`), Why (`y`). |',
			'## Renamed and removed',
			'| `gemini.old` | Renamed to gemini.a. |',
			'## When a change applies',
		]);
	});
});
