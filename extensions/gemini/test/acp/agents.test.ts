/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentsModel, titleFromPrompt } from '../../src/acp/agents';

function clock(start = 1_000) {
	let time = start;
	return { now: () => time, advance: (ms: number) => time += ms };
}

describe('titleFromPrompt', () => {
	it('uses the first non-empty line, with spaces collapsed', () => {
		expect(titleFromPrompt('\n  Fix   the login\nredirect please')).toBe('Fix the login');
	});

	it('shortens long prompts', () => {
		const title = titleFromPrompt('a'.repeat(100))!;
		expect(title).toHaveLength(48);
		expect(title.endsWith('…')).toBe(true);
	});

	it('gives nothing for a blank prompt', () => {
		expect(titleFromPrompt('  \n ')).toBeUndefined();
	});
});

describe('AgentsModel', () => {
	it('adds a folder once', () => {
		const model = new AgentsModel();
		const a = model.addWorkspace('/work/api');
		const again = model.addWorkspace('/work/api/');
		expect(again).toBe(a);
		expect(model.workspaces).toHaveLength(1);
	});

	it('adds an agent with an id given ahead, once', () => {
		const model = new AgentsModel();
		const workspace = model.addWorkspace('/work/api').id;
		expect(model.addAgent(workspace, 'New agent', undefined, 'given').id).toBe('given');
		expect(() => model.addAgent(workspace, 'Again', undefined, 'given')).toThrow();
	});

	it('keeps change totals only while there are changes', () => {
		const model = new AgentsModel();
		const agent = model.addAgent(model.addWorkspace('/work/api').id, 'New agent');
		let changes = 0;
		model.onDidChange(() => changes++);
		model.setChanges(agent.id, { files: 0, added: 0, removed: 0 });
		expect(changes).toBe(0);
		model.setChanges(agent.id, { files: 2, added: 5, removed: 1 });
		model.setChanges(agent.id, { files: 2, added: 5, removed: 1 });
		expect(model.agent(agent.id)?.changes).toEqual({ files: 2, added: 5, removed: 1 });
		model.setChanges(agent.id, { files: 0, added: 0, removed: 0 });
		expect(model.agent(agent.id)?.changes).toBeUndefined();
		expect(changes).toBe(2);
	});

		it('keeps the session id across a reload', () => {
		const model = new AgentsModel();
		const agent = model.addAgent(model.addWorkspace('/work/api').id, 'New agent');
		let changes = 0;
		model.onDidChange(() => changes++);
		model.setSessionId(agent.id, 's1');
		model.setSessionId(agent.id, 's1');
		expect(changes).toBe(1);
		expect(new AgentsModel(JSON.parse(JSON.stringify(model.snapshot()))).agent(agent.id)?.sessionId).toBe('s1');
	});

		it('names an agent after its first prompt only', () => {
		const time = clock();
		const model = new AgentsModel(undefined, time.now);
		const agent = model.addAgent(model.addWorkspace('/w').id, 'New agent');
		time.advance(10);
		model.recordPrompt(agent.id, 'Fix the login redirect');
		time.advance(10);
		model.recordPrompt(agent.id, 'Now add a test');
		expect(model.agent(agent.id)!.title).toBe('Fix the login redirect');
	});

	it('keeps a name the user chose', () => {
		const model = new AgentsModel();
		const agent = model.addAgent(model.addWorkspace('/w').id, 'New agent');
		model.rename(agent.id, 'Mine');
		model.recordPrompt(agent.id, 'Something else');
		expect(model.agent(agent.id)!.title).toBe('Mine');
	});

	it('lists the most recently used agents first', () => {
		const time = clock();
		const model = new AgentsModel(undefined, time.now);
		const ws = model.addWorkspace('/w').id;
		const first = model.addAgent(ws, 'first');
		time.advance(10);
		const second = model.addAgent(ws, 'second');
		time.advance(10);
		model.recordPrompt(first.id, 'again');
		expect(model.agentsIn(ws).map(a => a.id)).toEqual([first.id, second.id]);
	});

	it('removes a workspace with its agents', () => {
		const model = new AgentsModel();
		const ws = model.addWorkspace('/w').id;
		const agent = model.addAgent(ws, 'a');
		model.addAgent(model.addWorkspace('/other').id, 'b');
		expect(model.removeWorkspace(ws).map(a => a.id)).toEqual([agent.id]);
		expect(model.snapshot().agents.map(a => a.title)).toEqual(['b']);
	});

	it('round-trips through a snapshot and drops bad records', () => {
		const model = new AgentsModel();
		const ws = model.addWorkspace('/w');
		model.addAgent(ws.id, 'a');
		const restored = new AgentsModel(JSON.parse(JSON.stringify({
			workspaces: [...model.snapshot().workspaces, { id: 'x', folder: 'relative/path' }],
			agents: [...model.snapshot().agents, { id: 'orphan', workspaceId: 'gone', title: 't', createdAt: 1, updatedAt: 1 }, { id: 'bad' }],
		})));
		expect(restored.workspaces).toEqual([ws]);
		expect(restored.agentsIn(ws.id).map(a => a.title)).toEqual(['a']);
	});

	it('tells listeners about every change', () => {
		const model = new AgentsModel();
		let changes = 0;
		model.onDidChange(() => changes++);
		const agent = model.addAgent(model.addWorkspace('/w').id, 'a');
		model.rename(agent.id, 'b');
		model.removeAgent(agent.id);
		expect(changes).toBe(4);
	});

	it('keeps the branch an agent works on and runs it there', () => {
		const folder = path.resolve('/work/api');
		const model = new AgentsModel();
		const workspace = model.addWorkspace(folder);
		const worktree = { folder: path.resolve('/wt/fix'), cwd: path.resolve('/wt/fix/app'), branch: 'gemini/fix', base: 'main' };
		const agent = model.addAgent(workspace.id, 'New agent', worktree);
		const plain = model.addAgent(workspace.id, 'Other');
		expect(model.folderOf(agent)).toBe(worktree.cwd);
		expect(model.folderOf(plain)).toBe(folder);
		const reloaded = new AgentsModel(JSON.parse(JSON.stringify(model.snapshot())));
		expect(reloaded.agent(agent.id)?.worktree).toEqual(worktree);
		expect(reloaded.agent(plain.id)?.worktree).toBeUndefined();
		const broken = { ...model.snapshot(), agents: [{ ...agent, worktree: { folder: 1 } }] };
		expect(new AgentsModel(broken as never).agent(agent.id)).toBeUndefined();
	});
});
