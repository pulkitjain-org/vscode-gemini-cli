/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendMemory } from '../../src/acp/memory';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-')); });
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe('appendMemory', () => {
	it('creates the file and the heading', async () => {
		const file = path.join(dir, 'sub', 'GEMINI.md');
		await appendMemory(file, 'Use pnpm,\nnot npm');
		expect(await fs.readFile(file, 'utf8')).toBe('## Gemini Added Memories\n\n- Use pnpm, not npm\n');
	});

	it('adds a heading after existing rules, then bullets under it', async () => {
		const file = path.join(dir, 'GEMINI.md');
		await fs.writeFile(file, '# Rules\n\nBe brief.');
		await appendMemory(file, 'One');
		await appendMemory(file, 'Two');
		expect(await fs.readFile(file, 'utf8')).toBe('# Rules\n\nBe brief.\n\n## Gemini Added Memories\n\n- One\n- Two\n');
	});

	it('keeps sections after the memories', async () => {
		const file = path.join(dir, 'GEMINI.md');
		await fs.writeFile(file, '## Gemini Added Memories\n\n- One\n\n## Testing\n\nRun npm test.\n');
		await appendMemory(file, 'Two');
		expect(await fs.readFile(file, 'utf8')).toBe('## Gemini Added Memories\n\n- One\n- Two\n\n## Testing\n\nRun npm test.\n');
	});
});
