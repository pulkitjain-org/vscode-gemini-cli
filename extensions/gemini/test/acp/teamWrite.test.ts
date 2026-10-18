/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditEntry, AuditLog } from '../../src/acp/auditLog';
import { JiraClient } from '../../src/acp/jira';
import type { TeamDefaults } from '../../src/acp/teamDefaults';
import { callTeamTool, TeamToolContext, teamWrite } from '../../src/acp/teamTools';

// One call path (gemini/docs/adr/0004-one-tool-adapter.md): a page's write and an agent's tool call
// for the same action run the same code and leave the same audit record, but for who asked.

const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
	servers.splice(0).forEach(s => s.close());
	await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

/** A Jira that allows one move, In Review (31), and takes comments. */
async function fakeJira() {
	const requests: { method: string; url: string; body: string }[] = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', chunk => body += chunk);
		req.on('end', () => {
			requests.push({ method: req.method ?? '', url: req.url ?? '', body });
			if (req.method === 'GET' && req.url?.includes('/transitions')) {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ transitions: [{ id: '31', name: 'Submit for review', to: { name: 'In Review', statusCategory: { key: 'indeterminate' } }, fields: {} }] }));
			} else if (req.url?.endsWith('/comment')) {
				res.writeHead(201, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ id: '77104' }));
			} else {
				res.writeHead(204);
				res.end();
			}
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function setUp(defaults: TeamDefaults = {}) {
	const jira = await fakeJira();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-audit-'));
	dirs.push(dir);
	const audit = new AuditLog(dir);
	const context: TeamToolContext = {
		audit,
		connected: () => new Set(['jira']),
		connectors: () => ({ jira: new JiraClient({ site: jira.url, email: 'me@acme.com', token: 't' }) }),
		folder: () => '/work/acme-checkout',
		defaults: async () => defaults,
	};
	return { jira, audit, context };
}

/** A record without what differs between any two writes (its id and time) or between the callers. */
function shape(entry: AuditEntry): Omit<AuditEntry, 'id' | 'time' | 'caller' | 'agent'> {
	const { id: _id, time: _time, caller: _caller, agent: _agent, ...rest } = entry;
	return rest;
}

describe('one call path for pages and agents', () => {
	it('records the same intent and result for a move from Home and from an agent', async () => {
		const { audit, context } = await setUp();
		const args = { key: 'ACME-412', to: 'In Review', comment: 'Ready for review.' };
		const fromAgent = await callTeamTool(context, 'agent-1', 'jira_transition', args);
		const fromPage = await teamWrite(context, { caller: 'ui', folder: '/work/acme-checkout' }, 'jira_transition', args);
		expect(fromAgent.isError).toBeFalsy();
		expect(fromPage.ok).toBe(true);
		const entries = await audit.read();
		const agent = entries.filter(e => e.caller === 'agent');
		const page = entries.filter(e => e.caller === 'ui');
		expect(agent.map(e => e.phase)).toEqual(['intent', 'result']);
		expect(page.map(shape)).toEqual(agent.map(shape));
		expect(agent[0].agent).toBe('agent-1');
		expect(page[0].agent).toBeUndefined();
	});

	it('posts a move\'s comment with the team\'s visibility, for an agent as for a page', async () => {
		const { jira, context } = await setUp({ jira: { commentVisibility: 'Developers' } });
		const fromAgent = await callTeamTool(context, 'agent-1', 'jira_transition', { key: 'ACME-412', to: 'In Review', comment: 'Look at the cap.' });
		expect(fromAgent.isError).toBeFalsy();
		const posts = jira.requests.filter(r => r.method === 'POST').map(r => ({ url: r.url, body: JSON.parse(r.body) as Record<string, unknown> }));
		expect(posts.map(p => p.url)).toEqual(['/rest/api/3/issue/ACME-412/transitions', '/rest/api/3/issue/ACME-412/comment']);
		expect(posts[0].body.update).toBeUndefined();
		expect(posts[1].body.visibility).toEqual({ type: 'role', value: 'Developers' });
	});

	it('moves by the transition id a page chose, and keeps the remote ids for the audit log only', async () => {
		const { audit, context } = await setUp({ jira: { commentVisibility: 'Developers' } });
		const result = await teamWrite(context, { caller: 'ui', folder: '/work/acme-checkout' }, 'jira_transition', { key: 'ACME-412', to: 'In Review', transition: '31', comment: 'Done.' });
		expect(result).toMatchObject({ ok: true, remote: 'transition 31 → In Review · comment 77104' });
		const fromAgent = await callTeamTool(context, 'agent-1', 'jira_transition', { key: 'ACME-412', to: 'In Review' });
		expect(JSON.stringify(fromAgent)).not.toContain('77104');
		expect((await audit.read()).filter(e => e.phase === 'result').map(e => e.remote)).toEqual(['transition 31 → In Review · comment 77104', 'transition 31 → In Review']);
	});

	it('keeps the page-only writes away from agents', async () => {
		const { context } = await setUp();
		expect((await callTeamTool(context, 'agent-1', 'gitlab_approve', { mr: '3' })).isError).toBe(true);
		expect((await teamWrite(context, { caller: 'agent', agent: 'agent-1' }, 'gitlab_approve', { mr: '3' })).ok).toBe(false);
	});
});
