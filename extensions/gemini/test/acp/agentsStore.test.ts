/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentsModel, type AgentRecord, type AgentsSnapshot } from '../../src/acp/agents';
import { AgentsStore } from '../../src/acp/agentsStore';

async function until(predicate: () => boolean): Promise<void> {
	for (let waited = 0; !predicate(); waited += 20) {
		if (waited > 5_000) {
			throw new Error('Timed out');
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

describe('AgentsStore', () => {
	const dirs: string[] = [];
	const disposables: { dispose(): void }[] = [];

	afterEach(async () => {
		disposables.splice(0).forEach(d => d.dispose());
		await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
	});

	async function folder() {
		const dir = await mkdtemp(path.join(tmpdir(), 'agents-store-'));
		dirs.push(dir);
		return path.join(dir, 'records');
	}

	/** A window: its own store and model, loaded from the folder. */
	async function window(dir: string, legacy?: AgentsSnapshot) {
		const store = new AgentsStore(dir);
		const model = new AgentsModel(await store.load(legacy));
		disposables.push(store, model);
		return { store, model };
	}

	it('moves the global state snapshot in once, and leaves it alone after', async () => {
		const dir = await folder();
		const legacy = new AgentsModel();
		const ws = legacy.addWorkspace('/work/api');
		legacy.addAgent(ws.id, 'First');
		legacy.addAgent(ws.id, 'Second');
		const first = await window(dir, legacy.snapshot());
		expect(first.model.agentsIn(ws.id).map(a => a.title).sort()).toEqual(['First', 'Second']);
		expect(await readdir(path.join(dir, 'agents'))).toHaveLength(2);
		// Once moved in, an older snapshot doesn't bring back what was removed since.
		first.model.removeAgent(first.model.agentsIn(ws.id)[0].id);
		await first.store.save(first.model);
		const again = await window(dir, legacy.snapshot());
		expect(again.model.agentsIn(ws.id)).toHaveLength(1);
	});

	it('keeps the agents of both windows when each saves its own list', async () => {
		const dir = await folder();
		const legacy = new AgentsModel();
		const ws = legacy.addWorkspace('/work/api');
		legacy.addAgent(ws.id, 'Shared', undefined, 'shared');
		const a = await window(dir, legacy.snapshot());
		const b = await window(dir, legacy.snapshot());
		// Window A adds an agent; window B, which never heard of it, changes its own and saves its whole list.
		a.model.addAgent(ws.id, 'Made in A', undefined, 'from-a');
		await a.store.save(a.model);
		b.model.addAgent(ws.id, 'Made in B', undefined, 'from-b');
		b.model.recordPrompt('shared', 'hello');
		await b.store.save(b.model);
		await a.store.save(a.model);
		const reopened = await window(dir);
		expect(reopened.model.agentsIn(ws.id).map(agent => agent.id).sort()).toEqual(['from-a', 'from-b', 'shared']);
		expect(reopened.model.agent('shared')?.title).toBe('hello');
	});

	it('follows the changes of another window, and hears of the agents it removed', async () => {
		const dir = await folder();
		const legacy = new AgentsModel();
		const ws = legacy.addWorkspace('/work/api');
		legacy.addAgent(ws.id, 'Shared', undefined, 'shared');
		const a = await window(dir, legacy.snapshot());
		const b = await window(dir, legacy.snapshot());
		const removed: AgentRecord[] = [];
		disposables.push(b.store.watch(b.model, agents => removed.push(...agents)));
		await new Promise(resolve => setTimeout(resolve, 50));
		a.model.addAgent(ws.id, 'Made in A', undefined, 'from-a');
		await a.store.save(a.model);
		await until(() => !!b.model.agent('from-a'));
		a.model.removeAgent('shared');
		await a.store.save(a.model);
		await until(() => removed.length > 0);
		expect(removed.map(agent => agent.id)).toEqual(['shared']);
		expect(b.model.agentsIn(ws.id).map(agent => agent.id)).toEqual(['from-a']);
	});

	it('keeps records this version does not recognise, and saves them back as they were', async () => {
		const dir = await folder();
		const legacy = new AgentsModel();
		const ws = legacy.addWorkspace('/work/api');
		const known = legacy.addAgent(ws.id, 'Known');
		const fromNewer = { id: 'reviewer', workspaceId: ws.id, title: 'Reviewer', createdAt: 1, updatedAt: 1, project: { role: 'reviewer', of: 'x' } };
		const extraField = { ...known, id: 'extra', title: 'Extra', badge: 'new in 0.2' };
		const first = await window(dir, { workspaces: legacy.snapshot().workspaces, agents: [...legacy.snapshot().agents, fromNewer as never, extraField] });
		expect(first.model.agent('reviewer')).toBeUndefined();
		first.model.rename('extra', 'Renamed');
		await first.store.save(first.model);
		const reopened = new AgentsModel(await new AgentsStore(dir).load(undefined));
		expect(reopened.stored().agents.find(agent => agent.id === 'reviewer')).toEqual(fromNewer);
		expect(reopened.agent('extra')).toMatchObject({ title: 'Renamed', badge: 'new in 0.2' });
	});

	it('saves only what changed in a list of 500 threads', async () => {
		// Reading the 500 files back takes about 20 ms on a Mac's disk; files written a moment ago read slower, so this times nothing.
		const dir = await folder();
		const legacy = new AgentsModel();
		const ws = legacy.addWorkspace('/work/shop');
		for (let i = 0; i < 500; i++) {
			legacy.addAgent(ws.id, `Thread ${i}`, undefined, `t${i}`);
		}
		await window(dir, legacy.snapshot());
		const { store, model } = await window(dir);
		expect(model.agentsIn(ws.id)).toHaveLength(500);
		model.recordPrompt('t499', 'One more note');
		const stored = model.stored().agents;
		expect(stored.filter(record => !store.agents.isSaved(record)).map(record => record.id)).toEqual(['t499']);
	});
});
