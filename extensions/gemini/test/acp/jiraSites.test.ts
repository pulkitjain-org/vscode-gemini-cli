/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JiraClient } from '../../src/acp/jira';
import { JiraSites, projectOf } from '../../src/acp/jiraSites';
import { teamReachability } from '../../src/acp/teamHttp';

/** A fake Jira site with `tickets` (key → summary); records each request's path. */
async function site(tickets: Record<string, string>) {
	const paths: string[] = [];
	let down = false;
	const server = http.createServer((req, res) => {
		paths.push(req.url ?? '');
		req.resume();
		req.on('end', () => {
			if (down) {
				res.writeHead(503).end();
				return;
			}
			const issue = /\/rest\/api\/3\/issue\/([A-Z]+-\d+)/.exec(req.url ?? '')?.[1];
			if (issue) {
				res.writeHead(tickets[issue] ? 200 : 404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(tickets[issue] ? { key: issue, fields: { summary: tickets[issue], status: { name: 'To Do', statusCategory: { key: 'new' } } } } : { errorMessages: ['Issue does not exist'] }));
				return;
			}
			if (req.url?.startsWith('/rest/api/3/field')) {
				res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
				return;
			}
			if (req.url?.startsWith('/rest/api/3/search/jql')) {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ issues: Object.entries(tickets).map(([key, summary]) => ({ key, fields: { summary, status: { name: 'To Do', statusCategory: { key: 'new' } } } })) }));
				return;
			}
			res.writeHead(404).end();
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { url, paths, client: new JiraClient({ site: url, email: 'me@acme.com', token: 't' }), goDown: () => down = true };
}

const servers: http.Server[] = [];
beforeEach(() => teamReachability.clear());
afterEach(() => {
	servers.splice(0).forEach(s => s.close());
});

describe('JiraSites', () => {
	it('sends a ticket to the site that has it, and remembers its project', async () => {
		const acme = await site({ 'ACME-1': 'Hero' });
		const globex = await site({ 'GLX-7': 'Banner' });
		const sites = new JiraSites([{ id: 'default', name: 'Acme', client: acme.client }, { id: 'b', name: 'Globex', client: globex.client }]);
		const first = await sites.issue('GLX-7');
		const second = await sites.issue('GLX-8').catch((err: Error) => err.message);
		expect({
			first: first.summary,
			second: typeof second === 'string' ? 'failed on Globex' : 'found',
			acmeAsked: acme.paths.filter(p => p.includes('GLX')).length,
			url: (await sites.clientFor('GLX-7')).issueUrl('GLX-7'),
		}).toEqual({ first: 'Banner', second: 'failed on Globex', acmeAsked: 1, url: `${globex.url}/browse/GLX-7` });
	});

	it('uses a link\'s host before asking the sites', async () => {
		const acme = await site({});
		const globex = await site({ 'GLX-7': 'Banner' });
		const sites = new JiraSites([{ id: 'default', name: 'Acme', client: acme.client }, { id: 'b', name: 'Globex', client: globex.client }]);
		expect([await sites.clientFor(`${globex.url}/browse/GLX-7`) === globex.client, acme.paths]).toEqual([true, []]);
	});

	it('refuses a key two sites have, as it can\'t tell which is meant', async () => {
		const acme = await site({ 'CORE-1': 'One' });
		const globex = await site({ 'CORE-1': 'Other' });
		const sites = new JiraSites([{ id: 'default', name: 'Acme', client: acme.client }, { id: 'b', name: 'Globex', client: globex.client }]);
		await expect(sites.issue('CORE-1')).rejects.toThrow(`CORE-1 is on more than one Jira site (Acme: ${acme.url}/browse/CORE-1, Globex: ${globex.url}/browse/CORE-1)`);
	});

	it('lists every site\'s tickets, and a site that stops answering with its last tickets and the error', async () => {
		const acme = await site({ 'ACME-1': 'Hero' });
		const globex = await site({ 'GLX-7': 'Banner' });
		const sites = new JiraSites([{ id: 'default', name: 'Acme', client: acme.client }, { id: 'b', name: 'Globex', client: globex.client }]);
		await sites.myTickets(1000);
		globex.goDown();
		const later = await sites.myTickets(2000);
		expect({
			keys: later.issues.map(i => i.key),
			sites: later.sites?.map(s => ({ name: s.name, keys: s.issues.map(i => i.key), failed: !!s.error, asOf: s.asOf })),
		}).toEqual({
			keys: ['ACME-1', 'GLX-7'],
			sites: [{ name: 'Acme', keys: ['ACME-1'], failed: false, asOf: undefined }, { name: 'Globex', keys: ['GLX-7'], failed: true, asOf: 1000 }],
		});
	});

	it('never sends a ticket to the wrong site when both sites have its project', async () => {
		const acme = await site({ 'APP-1': 'Acme one' });
		const globex = await site({ 'APP-2': 'Globex two' });
		const sites = new JiraSites([{ id: 'default', name: 'Acme', client: acme.client }, { id: 'b', name: 'Globex', client: globex.client }]);
		// Both sites answer with APP tickets: APP is now on both, so a key in it is looked for on every site.
		await sites.myTickets();
		const one = await sites.issue('APP-1');
		const two = await sites.issue('APP-2');
		acme.paths.length = 0;
		const byLink = await sites.issue(`${acme.url}/browse/APP-1`);
		expect({ one: one.summary, two: two.summary, byLink: byLink.summary, linkAsked: acme.paths.map(p => p.split('?')[0]), globexAskedForLink: globex.paths.filter(p => p.includes('APP-1')).length }).toEqual({
			one: 'Acme one',
			two: 'Globex two',
			byLink: 'Acme one',
			linkAsked: ['/rest/api/3/issue/APP-1'],
			globexAskedForLink: 1,
		});
	});

	it('shares a search\'s places among the sites, and says which failed or have more', async () => {
		const acme = await site(Object.fromEntries([1, 2, 3, 4, 5].map(n => [`ACME-${n}`, `A${n}`])));
		const globex = await site({ 'GLX-1': 'G1' });
		const down = new JiraClient({ site: 'http://127.0.0.1:9', email: 'me@acme.com', token: 't' });
		const sites = new JiraSites([{ id: 'default', name: 'Acme', client: acme.client }, { id: 'b', name: 'Globex', client: globex.client }, { id: 'c', name: 'Initech', client: down }]);
		const found = await sites.searchSites('text ~ "x"', 4);
		expect({ keys: found.issues.map(i => i.key), notes: found.notes.map(n => n.replace(/127\.0\.0\.1:\d+/, 'host').replace(/(search .*\)): .*/, '$1: …')) }).toEqual({
			keys: ['ACME-1', 'ACME-2', 'ACME-3', 'GLX-1'],
			notes: ['Acme (host): has more matches than the 3 shown.', 'Couldn\'t search Initech (host): …'],
		});
	});

	it('refuses a link to a site that isn\'t connected, with one site or more, never sending it to another site\'s ticket', async () => {
		const acme = await site({ 'ACME-1': 'Hero' });
		const globex = await site({ 'GLX-7': 'Banner' });
		const one = new JiraSites([{ id: 'default', name: 'Acme', client: acme.client }]);
		const two = new JiraSites([{ id: 'default', name: 'Acme', client: acme.client }, { id: 'b', name: 'Globex', client: globex.client }]);
		const other = 'https://c.atlassian.net/browse/ACME-1';
		const outcomes = await Promise.all([one.issue(other), one.comment(other, 'Hi'), two.issue(other), two.comment(other, 'Hi')].map(p => p.then(() => 'sent', (err: Error) => err.message.split(' (')[0])));
		expect({ outcomes, asked: [...acme.paths, ...globex.paths] }).toEqual({
			outcomes: Array(4).fill('c.atlassian.net isn\'t a Jira site you\'ve connected'),
			asked: [],
		});
	});

	it('refuses a write by key while a site that may have it can\'t be asked, and still reads it', async () => {
		const acme = await site({ 'APP-9': 'Acme nine' });
		const down = new JiraClient({ site: 'http://127.0.0.1:9', email: 'me@acme.com', token: 't' });
		const sites = new JiraSites([{ id: 'default', name: 'Acme', client: acme.client }, { id: 'b', name: 'Initech', client: down }]);
		const write = await sites.comment('APP-9', 'Hi').then(() => 'sent', (err: Error) => err.message);
		const read = await sites.issue('APP-9');
		expect({ write, read: read.summary, wrote: acme.paths.filter(p => p.endsWith('/comment')) }).toEqual({
			write: 'Couldn\'t check Initech (127.0.0.1:9) for APP-9, which may have it too. Give the ticket\'s link instead of its key.',
			read: 'Acme nine',
			wrote: [],
		});
	});

	it('takes the project from a key', () => {
		expect([projectOf('acme-412'), projectOf('CORE_X-9')]).toEqual(['ACME', 'CORE_X']);
	});
});
