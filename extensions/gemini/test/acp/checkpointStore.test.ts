/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from '../../src/acp/checkpointStore';

describe('CheckpointStore', () => {
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
	});

	async function store() {
		const dir = await mkdtemp(path.join(tmpdir(), 'checkpoints-'));
		dirs.push(dir);
		return { dir: path.join(dir, 'checkpoints'), store: new CheckpointStore(path.join(dir, 'checkpoints')) };
	}

	const saved = { turns: [{ id: 'item-3', before: [['/a.ts', 'old'] as const, ['/new.ts', null] as const], undoable: true }], agentText: [['/a.ts', 'new'] as const] };

	it('gives back what was saved, and nothing once deleted', async () => {
		const { store: s } = await store();
		expect(await s.load('agent-1')).toBeUndefined();
		void s.save('agent-1', saved);
		expect(await s.load('agent-1')).toEqual({ version: 1, ...saved });
		await s.delete('agent-1');
		expect(await s.load('agent-1')).toBeUndefined();
	});

	it('removes the file when no turns are left', async () => {
		const { dir, store: s } = await store();
		await s.save('agent-1', saved);
		await s.save('agent-1', { turns: [], agentText: [] });
		expect(await readdir(dir)).toEqual([]);
	});

	it('ignores a file from another version or one that is not JSON', async () => {
		const { dir, store: s } = await store();
		await s.save('agent-1', saved);
		await writeFile(path.join(dir, 'agent-1.json'), JSON.stringify({ version: 99, ...saved }));
		expect(await s.load('agent-1')).toBeUndefined();
		await writeFile(path.join(dir, 'agent-1.json'), '{');
		expect(await s.load('agent-1')).toBeUndefined();
	});
});
