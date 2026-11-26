/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LogTail, logTailLimits, type TailEnd } from '../../../src/acp/debug/logTail';

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

async function tail(filters?: string[]) {
	const dir = await mkdtemp(path.join(tmpdir(), 'logtail-'));
	dirs.push(dir);
	const file = path.join(dir, 'server.log');
	await writeFile(file, 'old line 1\nold line 2\n');
	const lines: string[] = [];
	const ends: TailEnd[] = [];
	const t = new LogTail(file, { filters, onLines: l => lines.push(...l), onEnd: r => ends.push(r) });
	const opened = await t.open();
	return { dir, file, lines, ends, t, opened };
}

describe('log tail', () => {
	it('reads only what is added after the pick, joining partial lines across polls', async () => {
		const { file, lines, t, opened } = await tail();
		await appendFile(file, 'new 1\nnew 2\npart');
		const first = await t.poll();
		await appendFile(file, 'ial\r\n');
		const second = await t.poll();
		const third = await t.poll();
		expect({ opened, first, second, third, lines }).toEqual({
			opened: { ok: true, size: 22 },
			first: { lines: 2, truncated: false, rotated: false, capped: false },
			second: { lines: 1, truncated: false, rotated: false, capped: false },
			third: { lines: 0, truncated: false, rotated: false },
			lines: ['new 1', 'new 2', 'partial'],
		});
	});

	it('starts again at zero when the file is truncated, and from the start of a rotated file', async () => {
		const { file, lines, t } = await tail();
		await appendFile(file, 'a\n');
		await t.poll();
		await truncate(file, 0);
		await appendFile(file, 'after truncate\n');
		const truncated = await t.poll();
		await rename(file, `${file}.1`);
		await writeFile(file, 'after rotate\n');
		const rotated = await t.poll();
		expect({ truncated: truncated, rotated: rotated, lines }).toEqual({
			truncated: { lines: 1, truncated: true, rotated: false, capped: false },
			rotated: { lines: 1, truncated: false, rotated: true, capped: false },
			lines: ['a', 'after truncate', 'after rotate'],
		});
	});

	it('ends the grant when the file is deleted, and refuses a binary file or a folder', async () => {
		const { dir, file, ends, t } = await tail();
		await rm(file);
		const result = await t.poll();
		const binary = path.join(dir, 'bin.log');
		await writeFile(binary, Buffer.from([0x41, 0x00, 0x42]));
		const binaryTail = new LogTail(binary, { onLines: () => undefined });
		const folderTail = new LogTail(dir, { onLines: () => undefined });
		expect({ result, ends, after: await t.poll(), binary: await binaryTail.open(), folder: await folderTail.open() }).toEqual({
			result: { ended: 'deleted' },
			ends: ['deleted'],
			after: { ended: 'stopped' },
			binary: { ok: false, error: 'The file is binary.' },
			folder: { ok: false, error: 'Only a file can be followed, not a folder.' },
		});
	});

	it('cuts lines at 2 KB, passes marker lines through the filters, and reads at most 1 MB per run', async () => {
		const { file, lines, t } = await tail(['ERROR', 'checkout']);
		await appendFile(file, `${'x'.repeat(3000)}\nINFO quiet\nERROR loud\n@@gc:gc7f3a:p1@@ {"a":1}\nin checkout\n`);
		await t.poll();
		const filtered = [...lines];
		lines.length = 0;
		const tooMuch = `ERROR ${'y'.repeat(1000)}\n`.repeat(1100);
		await appendFile(file, tooMuch);
		const capped = await t.poll();
		await appendFile(file, 'ERROR after cap\n');
		const stillCapped = await t.poll();
		t.newRun();
		await appendFile(file, 'ERROR next run\n');
		const nextRun = await t.poll();
		expect({
			filtered: filtered.map(l => l.length > 100 ? `${l.length} chars` : l),
			capped: capped,
			read: lines.length <= Math.ceil(logTailLimits.maxBytesPerRun / 1007) && lines.length > 1000,
			stillCapped,
			nextRun,
			last: lines.at(-1),
		}).toEqual({
			filtered: ['ERROR loud', '@@gc:gc7f3a:p1@@ {"a":1}', 'in checkout'],
			capped: { lines: lines.length - 2, truncated: false, rotated: false, capped: true },
			read: true,
			stillCapped: { lines: 0, truncated: false, rotated: false, capped: true },
			// What arrived while the run was capped is read by the next run.
			nextRun: { lines: 2, truncated: false, rotated: false, capped: false },
			last: 'ERROR next run',
		});
	});

	it('follows the file with a watcher and the backstop until stopped', async () => {
		const { file, lines, ends, t } = await tail();
		t.start();
		await appendFile(file, 'watched\n');
		const deadline = Date.now() + 5000;
		while (!lines.length && Date.now() < deadline) {
			await new Promise(r => setTimeout(r, 50));
		}
		t.stop();
		t.stop();
		expect({ lines, ends }).toEqual({ lines: ['watched'], ends: ['stopped'] });
	});
});
