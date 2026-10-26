/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The webviews' chunks loaded on first use (the comment box, the emoji
// picker, Add Figma Design...) run in a page whose script already acquired the
// VS Code API, which a webview can do once: a chunk that imports a module
// acquiring it (view.ts, through dom.ts) fails to load. What a chunk needs of
// the page comes in its options instead.

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const media = path.join(__dirname, '..', '..', 'media');
const chunks = ['commentBox', 'emojiPicker', 'figmaDesign', 'homePopups', 'homeMenus', 'draftMarkdown'];

describe('webview chunks loaded on first use', () => {
	it.skipIf(!process.env.CI && !existsSync(path.join(media, 'figmaDesign.js')))('never acquire the VS Code API: their page already has', () => {
		expect(chunks.filter(chunk => readFileSync(path.join(media, `${chunk}.js`), 'utf8').includes('acquireVsCodeApi'))).toEqual([]);
	});
});
