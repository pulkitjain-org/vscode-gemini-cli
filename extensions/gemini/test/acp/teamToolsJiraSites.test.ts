/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/acp/auditLog';
import { JiraClient } from '../../src/acp/jira';
import { JiraSites } from '../../src/acp/jiraSites';
import { teamReachability } from '../../src/acp/teamHttp';
import { callTeamTool, TeamToolContext, teamWrite } from '../../src/acp/teamTools';

const servers: http.Server[] = [];
const dirs: string[] = [];
beforeEach(() => teamReachability.clear());
afterEach(async () => {
	servers.splice(0).forEach(s => s.close());
	await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

/** A Jira site with `tickets` (key → summary) that takes comments; records each write as `METHOD path`. */
async function fakeSite(tickets: Record<string, string>) {
	const writes: string[] = [];
	const server = http.createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			const url = req.url ?? '';
			const json = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
			if (url.startsWith('/rest/api/3/search/jql')) {
				return json(200, { issues: Object.entries(tickets).map(([key, summary]) => ({ key, fields: { summary, status: { name: 'To Do', statusCategory: { key: 'new' } } } })) });
			}
			const key = /\/rest\/api\/3\/issue\/([A-Z]+-\d+)/.exec(url)?.[1] ?? '';
			if (!tickets[key]) {
				return json(404, { errorMessages: ['Issue does not exist'] });
			}
			if (req.method === 'POST') {
				writes.push(`POST ${url}`);
				return json(201, { id: '900' });
			}
			return json(200, { key, fields: { summary: tickets[key], status: { name: 'To Do', statusCategory: { key: 'new' } } } });
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { url, writes, client: new JiraClient({ site: url, email: 'me@acme.com', token: 't' }) };
}

async function setUp() {
	// Both sites have project APP: Acme has APP-1 and Globex APP-1 and APP-2.
	const acme = await fakeSite({ 'APP-1': 'Acme one' });
	const globex = await fakeSite({ 'APP-1': 'Globex one', 'APP-2': 'Globex two' });
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-audit-'));
	dirs.push(dir);
	const audit = new AuditLog(dir);
	const sites = new JiraSites([{ id: 'default', name: 'Acme', client: acme.client }, { id: 'b', name: 'Globex', client: globex.client }]);
	const context: TeamToolContext = {
		audit,
		connected: () => new Set(['jira']),
		connectors: () => ({ jira: sites }),
		folder: () => undefined,
		defaults: async () => ({}),
	};
	return { acme, globex, audit, context };
}

const text = (result: { content: readonly { type: string; text?: string }[] }) => result.content.map(c => c.text ?? '').join('\n');

describe('team tools with two Jira sites', () => {
	it('sends a ticket to its site by link or by key, refuses a key both have, and names the site in the audit record', async () => {
		const { acme, globex, audit, context } = await setUp();
		const byLink = await teamWrite(context, { caller: 'ui' }, 'jira_comment', { key: `${acme.url}/browse/APP-1`, text: 'Hi' });
		const byKey = await callTeamTool(context, 'agent-1', 'jira_comment', { key: 'APP-2', text: 'Hi' });
		const both = await callTeamTool(context, 'agent-1', 'jira_get_issue', { key: 'APP-1' });
		const read = await callTeamTool(context, 'agent-1', 'jira_get_issue', { key: `${globex.url}/browse/APP-1` });
		const host = (url: string) => new URL(url).host;
		expect({
			byLink: byLink.ok,
			byKey: !byKey.isError,
			both: text(both),
			read: text(read).includes('Globex one'),
			acme: acme.writes,
			globex: globex.writes,
			effects: (await audit.read()).filter(e => e.phase === 'intent').map(e => e.effect),
		}).toEqual({
			byLink: true,
			byKey: true,
			both: `APP-1 is on more than one Jira site (Acme: ${acme.url}/browse/APP-1, Globex: ${globex.url}/browse/APP-1). Give the ticket's link instead of its key.`,
			read: true,
			acme: ['POST /rest/api/3/issue/APP-1/comment'],
			globex: ['POST /rest/api/3/issue/APP-2/comment'],
			effects: [`Comment on APP-1 (${host(acme.url)})`, `Comment on APP-2 (${host(globex.url)})`],
		});
	});

	it('searches every site, with each ticket\'s link, and says which have more than shown', async () => {
		const { acme, globex, context } = await setUp();
		const result = await callTeamTool(context, 'agent-1', 'jira_search', { jql: 'project = APP', max: 2 });
		expect(text(result).split('\n').filter(line => !line.startsWith('<')).map(line => line.replace(acme.url, 'acme').replace(globex.url, 'globex').replace(/127\.0\.0\.1:\d+/, 'host'))).toEqual([
			'APP-1 [To Do] Acme one (acme/browse/APP-1)',
			'APP-1 [To Do] Globex one (globex/browse/APP-1)',
			'Globex (host): has more matches than the 1 shown.',
		]);
	});
});
