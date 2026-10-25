/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Writes the emoji picker's data, webview-src/emojiData.json, from emojibase's
// English data. The package (MIT) unpacks to about 52 MB, so it is not a
// dependency: this script fetches the pinned version with `npm pack`, refuses a
// tarball that does not match the pinned checksum, reads en/data.json and
// removes the download. The JSON it writes is checked in, so builds never
// need the network. Run when a new emoji release should reach the picker:
//
//   npm run emoji-data
//
// then raise `version` and `integrity` below, and check the picker.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const version = '18.0.0';
const integrity = 'sha512-TPPRRYv2zPd0jKI+pTpMquwWNZXYAsC3IVsCMeg2X8y8fEzKwOks4/5bz0YavF5r6d71aGPpb6oDnUEwSLLMoA==';

/** Emojibase's groups the picker shows, in order; 2 (skin tones and hair) is left out. */
const groups = [0, 1, 3, 4, 5, 6, 7, 8, 9];
/** Search words kept per emoji, besides its name. */
const maxKeywords = 3;

interface EmojibaseEmoji {
	readonly label: string;
	readonly emoji: string;
	readonly group?: number;
	readonly order?: number;
	readonly version: number;
	readonly tags?: readonly string[];
}

const extensionDir = path.dirname(import.meta.dirname);
const output = path.join(extensionDir, 'webview-src', 'emojiData.json');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-emoji-data-'));
try {
	// npm pack uses the user's registry, proxy and cache settings; the pinned checksum decides whether the download is trusted.
	const packed = execFileSync(npm, ['pack', `emojibase-data@${version}`, '--pack-destination', work, '--json'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
		shell: process.platform === 'win32',
	});
	const tarball = path.join(work, (JSON.parse(packed) as { filename: string }[])[0].filename);
	const actual = `sha512-${createHash('sha512').update(fs.readFileSync(tarball)).digest('base64')}`;
	if (actual !== integrity) {
		throw new Error(`emojibase-data ${version} does not match the pinned checksum.\n  expected ${integrity}\n  got      ${actual}`);
	}
	execFileSync('tar', ['-xzf', tarball, '-C', work, 'package/en/data.json']);
	const data = JSON.parse(fs.readFileSync(path.join(work, 'package', 'en', 'data.json'), 'utf8')) as EmojibaseEmoji[];

	// One list per group: [emoji, name, search words, emoji version], in emojibase's order.
	const lists = groups.map(group => data
		.filter(entry => entry.group === group)
		.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
		.map(entry => {
			const name = entry.label;
			const words = (entry.tags ?? []).filter(tag => !name.includes(tag)).slice(0, maxKeywords).join(' ');
			return [entry.emoji, name, words, entry.version] as const;
		}));
	const count = lists.reduce((sum, list) => sum + list.length, 0);
	fs.writeFileSync(output, `${JSON.stringify({ source: `emojibase-data ${version}`, groups: lists })}\n`);
	console.log(`Wrote ${count} emoji from emojibase-data ${version} to ${path.relative(process.cwd(), output) || output}.`);
} finally {
	fs.rmSync(work, { recursive: true, force: true });
}
