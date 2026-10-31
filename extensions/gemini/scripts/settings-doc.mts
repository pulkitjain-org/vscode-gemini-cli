/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Writes gemini/docs/guide/settings.md from package.json and package.nls.json
// (src/acp/settingsDoc.ts). Run it after a settings change:
// `node scripts/settings-doc.mts` in extensions/gemini. settingsDoc.test.ts
// fails until the file is written again.

import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSettingsDoc } from '../src/acp/settingsDoc.ts';

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(extension, '..', '..');
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const doc = renderSettingsDoc({
	configuration: read(path.join(extension, 'package.json')).contributes.configuration,
	strings: read(path.join(extension, 'package.nls.json')),
});
const target = path.join(root, 'gemini', 'docs', 'guide', 'settings.md');
writeFileSync(target, doc);
console.log(`Wrote ${path.relative(root, target)}`);
