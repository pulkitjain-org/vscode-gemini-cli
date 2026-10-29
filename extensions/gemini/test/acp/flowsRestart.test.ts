/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentsModel } from '../../src/acp/agents';
import { FlowRecordStore } from '../../src/acp/flowRecords';
import { readTeamDefaults, suggestedTransition } from '../../src/acp/teamDefaults';

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-flows-'));
	dirs.push(dir);
	return dir;
}

const moves = [
	{ id: '21', name: 'Start work', to: 'In Progress' },
	{ id: '31', name: 'Submit for review', to: 'In Review' },
	{ id: '41', name: 'Ship', to: 'Done' },
	{ id: '51', name: 'Hand to QA', to: 'Ready for QA' },
];

describe('suggested Jira moves', () => {
	it('takes the team\'s transition id, and falls back to the status name', () => {
		expect(suggestedTransition(moves, 'review', { review: '51' })).toBe('51');
		expect(suggestedTransition(moves, 'review', undefined)).toBe('31');
		// An id the ticket's workflow doesn't offer from its status: the name decides.
		expect(suggestedTransition(moves, 'done', { done: '99' })).toBe('41');
		// Flow records written before the ids name the status.
		expect(suggestedTransition(moves, 'In Progress', { start: '51' })).toBe('21');
		expect(suggestedTransition(moves, undefined, { start: '21' })).toBeUndefined();
	});

	it('reads the ids from the team\'s defaults, numbers or strings', async () => {
		const repo = await tempDir();
		await fs.mkdir(path.join(repo, '.gemini'));
		// With a comment, as the CLI's own settings files allow.
		await fs.writeFile(path.join(repo, '.gemini', 'geminicode-tools.json'), `// The ACME board's transition ids.\n${JSON.stringify({ jira: { transitions: { start: 21, review: '31', done: '' } } })}`);
		expect((await readTeamDefaults(repo)).jira?.transitions).toEqual({ start: '21', review: '31' });
	});
});

describe('what a restart keeps', () => {
	it('keeps a flow\'s typed fields on its record until the flow closes', async () => {
		const store = new FlowRecordStore(await tempDir());
		const id = await store.open({ command: 'gemini.team.moveTicket', args: ['ACME-412'], title: 'Move ACME-412' });
		await store.saveFields(id, { comment: 'Look at the 200-character cap.', addComment: true });
		expect((await store.get(id))?.fields).toEqual({ comment: 'Look at the 200-character cap.', addComment: true });
		await store.close(id);
		await store.saveFields(id, { comment: 'late' });
		expect(await store.list()).toEqual([]);
	});

	it('keeps the last checks on the agent\'s record', () => {
		const model = new AgentsModel(undefined, () => 1000);
		const workspace = model.addWorkspace('/work/acme-checkout');
		const agent = model.addAgent(workspace.id, 'ACME-421 Promo code');
		model.setChecks(agent.id, 'Snyk clean · Snyk Code 2 issues');
		const reloaded = new AgentsModel(model.snapshot());
		expect(reloaded.agent(agent.id)?.checks).toEqual({ summary: 'Snyk clean · Snyk Code 2 issues', at: 1000 });
	});
});
