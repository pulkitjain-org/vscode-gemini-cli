/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { workspaceRows } from '../../src/acp/agentList';
import { AgentsModel } from '../../src/acp/agents';

const worktree = (name: string) => ({ folder: `/t/${name}`, cwd: `/t/${name}`, branch: `gemini/${name}`, base: 'main' });

function fixture() {
	let time = 1_000;
	const model = new AgentsModel(undefined, () => time += 1);
	const shop = model.addWorkspace('/work/shop').id;
	const api = model.addWorkspace('/work/api').id;
	model.addAgent(shop, 'Checkout', undefined, 'checkout');
	const parent = model.addAgent(shop, 'Search', undefined, 'search');
	model.addFork(parent, 'Search, again', {}, undefined, undefined);
	model.addAgent(shop, 'Project', undefined, 'project', { role: 'coordinator' });
	model.addAgent(shop, 'Refunds', worktree('refunds'), 'refunds', { role: 'thread', coordinator: 'project', byCoordinator: true });
	model.addAgent(shop, 'Orphan', worktree('orphan'), 'orphan', { role: 'thread', coordinator: 'gone', byCoordinator: true });
	model.addAgent(shop, 'Old', undefined, 'old');
	model.addAgent(shop, 'Older', undefined, 'older');
	model.addAgent(api, 'Docs', undefined, 'docs');
	model.archive('older');
	model.archive('old');
	return { model, shop, api, now: () => time };
}

describe('workspaceRows', () => {
	it('lists a workspace\'s projects, then its own agents, then the archived ones, each where it belongs', () => {
		const { model, shop, api, now } = fixture();
		const rows = workspaceRows(model, shop, { projects: true, live: () => false, now: now() });
		expect({
			projects: rows.projects.map(a => a.id),
			agents: rows.agents.map(a => a.id),
			archived: rows.archived.map(a => a.id),
			api: workspaceRows(model, api, { projects: true, live: () => false, now: now() }).agents.map(a => a.id),
		}).toEqual({
			projects: ['project'],
			// Threads sit under their project and forks under their parent; a thread whose project is gone is an agent of its own.
			agents: ['orphan', 'search', 'checkout'],
			// Most recently archived first.
			archived: ['old', 'older'],
			api: ['docs'],
		});
	});

	it('lists a project and its threads as plain agents while Projects are off', () => {
		const { model, shop, now } = fixture();
		const rows = workspaceRows(model, shop, { projects: false, live: () => false, now: now() });
		expect([rows.projects, rows.agents.map(a => a.id)]).toEqual([[], ['orphan', 'refunds', 'project', 'search', 'checkout']]);
	});

	it('keeps an archived agent in the list while it runs in this window', () => {
		const { model, shop, now } = fixture();
		const rows = workspaceRows(model, shop, { projects: true, live: id => id === 'old', now: now() });
		expect([rows.agents.map(a => a.id), rows.archived.map(a => a.id)]).toEqual([['old', 'orphan', 'search', 'checkout'], ['older']]);
	});
});
