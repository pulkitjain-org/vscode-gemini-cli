/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DebugRecord, DebugRecordWriter, deleteDebugRecord, listDebugRecords, readDebugRecord, recordIsEmpty, recordPath, writeDebugRecord } from '../../../src/acp/debug/debugRecord';

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

async function storage(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'debug-record-'));
	dirs.push(dir);
	return dir;
}

const record: DebugRecord = {
	version: 1,
	agent: 'agent-1',
	nonce: 'gc7f3a',
	folder: '/work/shop',
	title: 'Fix checkout total',
	startedAt: 1000,
	points: [{ id: 'p1', kind: 'logpoint', file: 'cart.ts', line: 42, message: '@@gc:gc7f3a:p1@@ {"cart.total":{cart.total}}' }, { id: 'p2', kind: 'breakpoint', file: 'cart.ts', line: 88, condition: 'n > 1' }],
	regions: [{ file: 'checkout.js', point: 'p3', nonce: 'gc7f3a', text: '// GEMINI-DEBUG-START gc7f3a p3\nx\n// GEMINI-DEBUG-END gc7f3a p3', normalized: '//GEMINI-DEBUG-STARTgc7f3ap3x//GEMINI-DEBUG-ENDgc7f3ap3', line: 17 }],
	sessions: ['gc7f3a'],
	logFile: '/var/log/shop/server.log',
	routePort: 4321,
};

describe('debug record', () => {
	it('writes the record under globalStorage/debug and reads it back whole, without evidence or tokens', async () => {
		const dir = await storage();
		const file = recordPath(dir, 'agent/1');
		await writeDebugRecord(file, record);
		const text = await readFile(file, 'utf8');
		expect({ file: path.relative(dir, file), back: await readDebugRecord(file), hasToken: /token/i.test(text), empty: recordIsEmpty(record), emptyOne: recordIsEmpty({ ...record, points: [], regions: [], sessions: [], logFile: undefined, routePort: undefined }) })
			.toEqual({ file: path.join('debug', 'agent_1.json'), back: record, hasToken: false, empty: false, emptyOne: true });
	});

	it('reads nothing from a missing, broken or foreign file, and drops malformed entries', async () => {
		const dir = await storage();
		const broken = path.join(dir, 'debug', 'broken.json');
		const foreign = path.join(dir, 'debug', 'foreign.json');
		const partial = path.join(dir, 'debug', 'partial.json');
		await writeDebugRecord(broken, record);
		await writeFile(broken, '{ not json');
		await writeFile(foreign, JSON.stringify({ version: 2, agent: 'a' }));
		await writeFile(partial, JSON.stringify({ ...record, points: [{ id: 'p1' }, record.points[1]], regions: ['x'], sessions: ['s', 3], logFile: 7 }));
		expect({
			missing: await readDebugRecord(path.join(dir, 'none.json')),
			broken: await readDebugRecord(broken),
			foreign: await readDebugRecord(foreign),
			partial: await readDebugRecord(partial),
			listed: (await listDebugRecords(dir)).map(r => path.basename(r.file)),
		}).toEqual({
			missing: undefined,
			broken: undefined,
			foreign: undefined,
			partial: { ...record, points: [record.points[1]], regions: [], sessions: ['s'], logFile: undefined },
			listed: ['partial.json'],
		});
	});

	it('batches writes to one per delay, keeps the latest, and deletes the record at Clean up', async () => {
		const dir = await storage();
		const file = recordPath(dir, 'agent-1');
		const writes: number[] = [];
		const writer = new DebugRecordWriter(file, 20, async (f, r) => {
			writes.push(r.startedAt);
			await writeDebugRecord(f, r);
		});
		writer.update({ ...record, startedAt: 1 });
		writer.update({ ...record, startedAt: 2 });
		writer.update({ ...record, startedAt: 3 });
		await new Promise(r => setTimeout(r, 60));
		const onDisk = (await readDebugRecord(file))?.startedAt;
		writer.update({ ...record, startedAt: 4 });
		await writer.flush();
		const flushed = (await readDebugRecord(file))?.startedAt;
		writer.update({ ...record, startedAt: 5 });
		await writer.delete();
		writer.update({ ...record, startedAt: 6 });
		await new Promise(r => setTimeout(r, 40));
		const left = await readdir(path.join(dir, 'debug'));
		await deleteDebugRecord(file);
		expect({ writes, onDisk, flushed, left }).toEqual({ writes: [3, 4], onDisk: 3, flushed: 4, left: [] });
	});
});
