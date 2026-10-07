/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Add Memory: what Gemini should remember goes in a GEMINI.md file, which the
// CLI loads into every new session. gemini-cli 0.62 has no memory tool of its
// own any more; this keeps the heading its old save_memory tool wrote under.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** The heading memories go under, as the CLI's memory tool wrote them. */
const memoryHeading = '## Gemini Added Memories';

/** Adds `text` as a bullet under the memories heading, adding the heading (and the file) when missing. */
export async function appendMemory(file: string, text: string): Promise<void> {
	const current = await fs.readFile(file, 'utf8').catch(() => '');
	const bullet = `- ${text.replace(/\s*\n\s*/g, ' ')}`;
	let next: string;
	const at = current.indexOf(memoryHeading);
	if (at < 0) {
		next = `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}${memoryHeading}\n\n${bullet}\n`;
	} else {
		// The section ends at the next heading of any level.
		const after = at + memoryHeading.length;
		const nextHeading = current.slice(after).search(/\n#{1,6} /);
		const end = nextHeading < 0 ? current.length : after + nextHeading;
		const section = current.slice(0, end).replace(/\s*$/, '');
		next = `${section}\n${bullet}\n${current.slice(end).replace(/^\s*/, end < current.length ? '\n' : '')}`;
	}
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, next, 'utf8');
}
