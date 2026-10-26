/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentFolder, type AgentRecord, AgentsModel, archiveAfterMs, freeTitle, isArchived, mergedThreads, resolvedAt, titleFromPrompt, warmThreads } from '../../src/acp/agents';

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

describe('freeTitle', () => {
	it('numbers a title that is taken', () => {
		expect([freeTitle('shop', new Set()), freeTitle('shop', new Set(['shop', 'shop 2', 'cms']))]).toEqual(['shop', 'shop 3']);
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

	it('makes a fork of a project\'s thread a thread of the same project', () => {
		const model = new AgentsModel();
		const workspace = model.addWorkspace('/work/shop').id;
		model.addAgent(workspace, 'Shop', undefined, 'c', { role: 'coordinator' });
		const thread = model.addAgent(workspace, 'Refunds', { folder: '/t/refunds', cwd: '/t/refunds', branch: 'gemini/refunds', base: 'main' }, 't', { role: 'thread', coordinator: 'c', byCoordinator: true });
		const fork = model.addFork(thread, 'Refunds, second try', {}, { folder: '/t/refunds-fork', cwd: '/t/refunds-fork', branch: 'gemini/refunds-fork', base: 'gemini/refunds' }, undefined, { role: 'thread', coordinator: 'c', byCoordinator: false });
		const reloaded = new AgentsModel(model.snapshot());
		expect(reloaded.threadsOf('c').map(a => a.id)).toEqual(['t', fork.id]);
		expect(reloaded.agent(fork.id)).toMatchObject({ forkedFrom: { agent: 't' }, project: { role: 'thread', coordinator: 'c', byCoordinator: false } });
	});

	it('adds a fork under its parent, on its own branch or in the folder it shares, across reloads', () => {
		const time = clock();
		const model = new AgentsModel(undefined, time.now);
		const workspace = model.addWorkspace('/work/shop').id;
		const parent = model.addAgent(workspace, 'Refunds', { folder: '/t/refunds', cwd: '/t/refunds/api', branch: 'gemini/refunds', base: 'main' }, 'p');
		time.advance(10);
		const branched = model.addFork(parent, 'Refund UI', {}, { folder: '/t/refunds-fork', cwd: '/t/refunds-fork/api', branch: 'gemini/refunds-fork', base: 'gemini/refunds' }, 'copied-session');
		time.advance(10);
		const shared = model.addFork(parent, 'Refund review', { sharedFolder: '/t/refunds/api' });
		const reloaded = new AgentsModel(model.snapshot());
		expect(reloaded.agent(branched.id)).toMatchObject({ title: 'Refund UI', titleSetByUser: true, sessionId: 'copied-session', forkedFrom: { agent: 'p', at: 1_010 } });
		expect(reloaded.forksOf('p').map(a => a.title)).toEqual(['Refund UI', 'Refund review']);
		expect(reloaded.parentOf(reloaded.agent(shared.id)!)?.id).toBe('p');
		expect([reloaded.folderOf(reloaded.agent(branched.id)!), reloaded.folderOf(reloaded.agent(shared.id)!), agentFolder(reloaded.agent('p')!, '/work/shop')]).toEqual(['/t/refunds-fork/api', '/t/refunds/api', '/t/refunds/api']);
		// A shared folder never makes it own the parent's worktree.
		expect(reloaded.agent(shared.id)?.worktree).toBeUndefined();
		reloaded.removeAgent('p');
		expect(reloaded.parentOf(reloaded.agent(shared.id)!)).toBeUndefined();
		expect(new AgentsModel({ workspaces: model.snapshot().workspaces, agents: [{ ...branched, forkedFrom: { agent: 'p', at: 1, sharedFolder: 'relative' } }] }).agent(branched.id)).toBeUndefined();
	});

	it('keeps a multi-repository thread\'s repositories across reloads', () => {
		const model = new AgentsModel();
		const workspace = model.addWorkspace('/work/shop').id;
		const worktree = { folder: '/t/fix', cwd: '/t/fix', branch: 'gemini/fix', base: 'main' };
		model.addAgent(workspace, 'Thread', worktree, 't', { role: 'thread', coordinator: 'c', byCoordinator: true });
		const repos = [{ key: 'shop', repository: '/work/shop', folder: '/t/fix/shop', cwd: '/t/fix/shop', branch: 'gemini/fix', base: 'main' }, { key: 'cms', repository: '/work/cms', folder: '/t/fix/cms', cwd: '/t/fix/cms', branch: 'gemini/fix', base: 'main', merged: true }];
		model.setRepos('t', repos);
		const reloaded = new AgentsModel(model.snapshot());
		expect(reloaded.agent('t')?.repos).toEqual(repos);
		expect(reloaded.folderOf(reloaded.agent('t')!)).toBe('/t/fix');
	});

	it('keeps a thread resolved until it is reopened, and only for threads', () => {
		const model = new AgentsModel(undefined, () => 5_000);
		const workspace = model.addWorkspace('/work/api').id;
		const coordinator = model.addAgent(workspace, 'Project', undefined, 'c', { role: 'coordinator' });
		const thread = model.addAgent(workspace, 'Thread', undefined, 't', { role: 'thread', coordinator: 'c', byCoordinator: true });
		let changes = 0;
		model.onDidChange(() => changes++);
		model.setThreadResolved(thread.id, true);
		model.setThreadResolved(thread.id, true);
		model.setThreadResolved(coordinator.id, true);
		expect(model.agent('t')?.project).toEqual({ role: 'thread', coordinator: 'c', byCoordinator: true, resolved: true, resolvedAt: 5_000 });
		expect(model.agent('c')?.project).toEqual({ role: 'coordinator' });
		model.setThreadResolved(thread.id, false);
		expect(model.agent('t')?.project).toEqual({ role: 'thread', coordinator: 'c', byCoordinator: true });
		expect(changes).toBe(2);
	});

	it('keeps a thread\'s brief and held notes across a reload until they are sent', () => {
		const model = new AgentsModel();
		const workspace = model.addWorkspace('/work/api').id;
		model.addAgent(workspace, 'Thread', undefined, 't', { role: 'thread', coordinator: 'c', byCoordinator: true });
		model.setThreadPending('t', { brief: 'Add dark mode', from: 'coordinator' });
		model.setThreadPending('t', { brief: 'Add dark mode', from: 'coordinator', notes: ['Also the toggle'] });
		const reloaded = new AgentsModel(JSON.parse(JSON.stringify(model.snapshot())));
		expect(reloaded.agent('t')?.project).toEqual({ role: 'thread', coordinator: 'c', byCoordinator: true, pending: { brief: 'Add dark mode', from: 'coordinator', notes: ['Also the toggle'] } });
		// Sent: the brief goes, then the notes.
		reloaded.setThreadPending('t', { notes: ['Also the toggle'] });
		reloaded.setThreadPending('t', { notes: [] });
		expect(reloaded.agent('t')?.project).toEqual({ role: 'thread', coordinator: 'c', byCoordinator: true });
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

	it('keeps records it does not recognise, and their fields, and saves them back as they were (ADR 0008)', () => {
		const model = new AgentsModel();
		const ws = model.addWorkspace('/w');
		const agent = model.addAgent(ws.id, 'a');
		const fromNewer = { id: 'r', workspaceId: ws.id, title: 'Reviewer', createdAt: 1, updatedAt: 1, project: { role: 'reviewer' } };
		const orphan = { id: 'orphan', workspaceId: 'gone', title: 't', createdAt: 1, updatedAt: 1 };
		const oddWorkspace = { id: 'x', folder: 'relative/path', kind: 'remote' };
		const restored = new AgentsModel(JSON.parse(JSON.stringify({
			workspaces: [...model.snapshot().workspaces, oddWorkspace],
			agents: [{ ...agent, pinned: true }, fromNewer, orphan, { id: 'bad' }, 'junk'],
		})));
		restored.rename(agent.id, 'b');
		expect(restored.agent(agent.id)).toMatchObject({ title: 'b', pinned: true });
		expect(restored.agent('r')).toBeUndefined();
		expect(restored.stored()).toEqual({
			version: 2,
			workspaces: [ws, oddWorkspace],
			agents: [{ ...agent, title: 'b', titleSetByUser: true, pinned: true }, fromNewer, orphan, { id: 'bad' }],
		});
		expect(restored.snapshot().version).toBe(2);
	});

	it('takes in the changes of another window, keeping an unsaved change of its own unless theirs is newer', () => {
		const time = clock();
		const model = new AgentsModel(undefined, time.now);
		const ws = model.addWorkspace('/w');
		const a = model.addAgent(ws.id, 'a');
		const b = model.addAgent(ws.id, 'b');
		model.rename(a.id, 'renamed here');
		const ours = model.agent(a.id)!;
		const unsaved = (record: { readonly id: string }) => record === ours;
		const theirs: AgentRecord[] = [{ ...a, title: 'older there' }, { ...b, title: 'newer there', updatedAt: b.updatedAt + 5 }, { ...b, id: 'c', title: 'new there' }];
		const removed = model.applyExternal({ agents: { upserted: theirs, removed: [] } }, unsaved);
		expect(removed).toEqual([]);
		expect(model.agentsIn(ws.id).map(x => x.title).sort()).toEqual(['new there', 'newer there', 'renamed here']);
		const used: AgentRecord = { ...ours, title: 'used there', updatedAt: ours.updatedAt + 1 };
		expect(model.applyExternal({ agents: { upserted: [used], removed: ['c'] } }, unsaved).map(x => x.id)).toEqual(['c']);
		expect(model.agent(a.id)?.title).toBe('used there');
		// An agent whose workspace arrives later shows once it does.
		const ws2 = { id: 'w2', folder: path.resolve('/w2') };
		const elsewhere: AgentRecord = { ...b, id: 'd', workspaceId: 'w2' };
		model.applyExternal({ agents: { upserted: [elsewhere], removed: [] } });
		expect(model.agent('d')).toBeUndefined();
		model.applyExternal({ workspaces: { upserted: [ws2], removed: [] } });
		expect(model.agent('d')?.workspaceId).toBe('w2');
	});

	it('lists the threads merged back, whose checkpoints can go', () => {
		const model = new AgentsModel();
		const ws = model.addWorkspace('/w').id;
		model.addAgent(ws, 'P', undefined, 'c', { role: 'coordinator' });
		model.addAgent(ws, 'open', undefined, 't1', { role: 'thread', coordinator: 'c', byCoordinator: true });
		model.addAgent(ws, 'merged', undefined, 't2', { role: 'thread', coordinator: 'c', byCoordinator: true });
		model.setThreadResolved('t2', true);
		expect(mergedThreads(model.snapshot().agents)).toEqual(['t2']);
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

describe('many threads', () => {
	function project(count: number, time: ReturnType<typeof clock>) {
		const model = new AgentsModel(undefined, time.now);
		const workspace = model.addWorkspace('/work/api').id;
		model.addAgent(workspace, 'Project', undefined, 'c', { role: 'coordinator' });
		// Each thread a moment after the last.
		const ids = Array.from({ length: count }, (_, i) => {
			time.advance(1);
			return model.addAgent(workspace, `Thread ${i}`, undefined, `t${i}`, { role: 'thread', coordinator: 'c', byCoordinator: true }).id;
		});
		return { model, ids };
	}

	it('starts only the most recently used open threads with their project', () => {
		const time = clock();
		const { model, ids } = project(10, time);
		time.advance(1);
		model.recordPrompt('t2', 'Fix it');
		time.advance(1);
		model.setThreadResolved('t9', true);
		expect(warmThreads(model.threadsOf('c'), 3)).toEqual(['t2', 't8', 't7']);
		expect(warmThreads(model.threadsOf('c'))).toHaveLength(6);
		expect(warmThreads(model.threadsOf('c'), 100)).toHaveLength(ids.length - 1);
	});

	it('archives a thread a week after its merge, and never an open one', () => {
		const time = clock();
		const { model } = project(2, time);
		model.setThreadResolved('t0', true);
		time.advance(archiveAfterMs - 1);
		expect(isArchived(model.agent('t0')!, time.now())).toBe(false);
		time.advance(1);
		expect(isArchived(model.agent('t0')!, time.now())).toBe(true);
		expect(isArchived(model.agent('t1')!, time.now())).toBe(false);
		expect(isArchived(model.agent('c')!, time.now())).toBe(false);
		// Reopened, it is back in the list.
		model.setThreadResolved('t0', false);
		expect(isArchived(model.agent('t0')!, time.now())).toBe(false);
		// Merged before the time was kept: its last use counts.
		const old = { ...model.agent('t1')!, project: { role: 'thread' as const, coordinator: 'c', byCoordinator: true, resolved: true } };
		expect(isArchived(old, time.now())).toBe(true);
	});

	it('archives an agent the user archived until its next prompt, keeping its record', () => {
		const time = clock();
		const { model } = project(1, time);
		const workspace = model.workspaces[0].id;
		const agent = model.addAgent(workspace, 'Login fix').id;
		time.advance(5);
		model.archive(agent);
		const archived = { now: isArchived(model.agent(agent)!, time.now()), later: isArchived(model.agent(agent)!, time.now() + archiveAfterMs * 10), title: model.agent(agent)!.title };
		time.advance(1);
		model.recordPrompt(agent, 'Carry on');
		expect({ archived, afterPrompt: isArchived(model.agent(agent)!, time.now()) }).toEqual({ archived: { now: true, later: true, title: 'Login fix' }, afterPrompt: false });
	});

	it('dates a thread\'s merge from when it was resolved, else from its last use', () => {
		const time = clock();
		const { model } = project(2, time);
		time.advance(5);
		model.setThreadResolved('t0', true);
		const merged = time.now();
		time.advance(5);
		const old = { ...model.agent('t1')!, project: { role: 'thread' as const, coordinator: 'c', byCoordinator: true, resolved: true } };
		expect([resolvedAt(model.agent('t0')!), resolvedAt(old), resolvedAt(model.agent('c')!)]).toEqual([merged, old.updatedAt, model.agent('c')!.updatedAt]);
	});
});
