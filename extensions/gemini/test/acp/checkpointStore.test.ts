/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointStore, serialize } from '../../src/acp/checkpointStore';

describe('CheckpointStore', () => {
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
	});

	async function store() {
		const dir = await mkdtemp(path.join(tmpdir(), 'checkpoints-'));
		dirs.push(dir);
		return { dir: path.join(dir, 'checkpoints'), store: new CheckpointStore(path.join(dir, 'checkpoints'), undefined, 10) };
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

	it('moves a file of another version, or one that is not JSON, aside instead of writing over it', async () => {
		const { dir, store: s } = await store();
		await s.save('agent-1', saved);
		const newer = JSON.stringify({ version: 99, ...saved });
		await writeFile(path.join(dir, 'agent-1.json'), newer);
		expect(await s.load('agent-1')).toBeUndefined();
		await writeFile(path.join(dir, 'agent-2.json'), '{');
		expect(await s.load('agent-2')).toBeUndefined();
		expect((await readdir(dir)).sort()).toEqual(['agent-1.json.broken', 'agent-2.json.broken']);
		expect(await readFile(path.join(dir, 'agent-1.json.broken'), 'utf8')).toBe(newer);
	});

	it('writes a burst of saves once, the last one, and at once on flush', async () => {
		const { dir, store: s } = await store();
		const later = { ...saved, turns: [...saved.turns, { id: 'item-9', before: [['/b.ts', 'b'] as const], undoable: true }] };
		const first = s.save('agent-1', saved);
		const second = s.save('agent-1', later);
		expect(await readdir(dir).catch(() => [])).toEqual([]);
		await Promise.all([first, second]);
		expect(JSON.parse(await readFile(path.join(dir, 'agent-1.json'), 'utf8'))).toEqual({ version: 1, ...later });
		void s.save('agent-2', saved);
		await s.flush();
		expect((await readdir(dir)).sort()).toEqual(['agent-1.json', 'agent-2.json']);
	});

	it('says which agents have saved checkpoints', async () => {
		const { store: s } = await store();
		await s.save('agent-1', saved);
		expect(await s.savedOf(['agent-1', 'agent-2'])).toEqual(['agent-1']);
	});

	it('forgets a save still waiting when the agent is deleted', async () => {
		const { dir, store: s } = await store();
		const waiting = s.save('agent-1', saved);
		await s.delete('agent-1');
		await waiting;
		await new Promise(resolve => setTimeout(resolve, 30));
		expect(await readdir(dir).catch(() => [])).toEqual([]);
	});

	it('writes the same JSON as JSON.stringify, a piece at a time', () => {
		const big = { turns: [saved.turns[0], { id: 'b"2', before: [['/x "y".ts', 'line\n\ttab'] as const], undoable: false }], agentText: [['/a.ts', 'new'] as const, ['/b.ts', '\u2028'] as const] };
		expect([...serialize(big)].join('')).toBe(JSON.stringify({ version: 1, ...big }));
		expect([...serialize({ turns: [], agentText: [] })].join('')).toBe(JSON.stringify({ version: 1, turns: [], agentText: [] }));
	});
});
