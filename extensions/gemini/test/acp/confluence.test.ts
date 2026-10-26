/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdfDocument, AdfNode, ConfluenceClient, ConfluenceConflictError, confluencePageId, cqlQuery, describePage } from '../../src/acp/confluence';
import { blockChanges } from '../../src/acp/blockMerge';
import { DraftStore } from '../../src/acp/confluenceDrafts';
import { holdBlocks } from '../../src/acp/draftReview';
import { teamReachability, teamRequest } from '../../src/acp/teamHttp';
import { callTeamTool, teamWrite, type ConfluenceAccount, type TeamToolContext, type TeamToolResult } from '../../src/acp/teamTools';
import { AuditLog } from '../../src/acp/auditLog';
import { fakePanels, hostExport } from '../webview/pages';

const doc = (...texts: string[]) => ({ type: 'doc' as const, version: 1 as const, content: texts.map(p) });
const p = (text: string): AdfNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });

/** A fake Confluence holding one page at `version` with `pageBody`; records each request. With `racing`, someone saves just before the first write. */
async function confluence(version: number, pageBody: AdfDocument = doc('Run the tests.'), racing = false) {
	const requests: { method: string; url: string; body: string }[] = [];
	let current = version;
	let race = racing;
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', chunk => body += chunk);
		req.on('end', () => {
			requests.push({ method: req.method ?? '', url: req.url ?? '', body });
			const send = (status: number, value: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
			if (req.url?.startsWith('/wiki/api/v2/pages/42') && req.method === 'GET') {
				send(200, { id: '42', title: 'Checklist', spaceId: '7', version: { number: current, createdAt: '2026-10-24T10:00:00Z' }, body: { atlas_doc_format: { value: JSON.stringify(pageBody) } }, _links: { webui: '/spaces/CHK/pages/42/Checklist' } });
			} else if (req.url?.startsWith('/wiki/api/v2/pages/42') && req.method === 'PUT' && race) {
				race = false;
				current++;
				send(409, { message: 'Version must be incremented on update.' });
			} else if (req.url?.startsWith('/wiki/api/v2/pages/42') && req.method === 'PUT') {
				current++;
				send(200, { id: '42', title: JSON.parse(body).title, spaceId: '7', version: { number: current } });
			} else if (req.url?.startsWith('/wiki/rest/api/search')) {
				send(200, { results: [{ content: { id: '42', title: 'Checklist' }, url: '/spaces/CHK/pages/42/Checklist', excerpt: 'Run the @@@hl@@@tests@@@endhl@@@', resultGlobalContainer: { title: 'Checkout' } }] });
			} else {
				send(404, {});
			}
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { url, requests, client: new ConfluenceClient({ site: url, email: 'me@acme.com', token: 't' }, (u, r) => teamRequest('confluence', u, r)), bump: () => current++ };
}

const servers: http.Server[] = [];
beforeEach(() => teamReachability.clear());
afterEach(() => {
	servers.splice(0).forEach(s => s.close());
});

describe('ConfluenceClient', () => {
	it('reads a page as the model sees it, and finds pages by text', async () => {
		const site = await confluence(14);
		const page = await site.client.page('42');
		const found = await site.client.search('tests', 'CHK');
		expect({ text: describePage(page, 'CHK'), found, cql: decodeURIComponent(site.requests[1].url.split('cql=')[1].split('&')[0]) }).toEqual({
			text: `Checklist (${site.url}/wiki/spaces/CHK/pages/42/Checklist)\nSpace CHK · version 14 · updated 2026-10-24\n\nRun the tests.`,
			found: [{ id: '42', title: 'Checklist', space: 'Checkout', url: `${site.url}/wiki/spaces/CHK/pages/42/Checklist`, excerpt: 'Run the tests' }],
			cql: 'type = page AND text ~ "tests" AND space = "CHK" ORDER BY lastmodified DESC',
		});
	});

	it('publishes a new version, and refuses one made from an older version without writing', async () => {
		const site = await confluence(14);
		const saved = await site.client.updatePage('42', { title: 'Checklist', body: doc('Run the tests.', 'Check every size.'), baseVersion: 14 });
		site.bump();
		const refused = await site.client.updatePage('42', { title: 'Checklist', body: doc('Mine'), baseVersion: 15 }).catch((err: unknown) => err);
		expect({
			saved: saved.version,
			sent: JSON.parse(site.requests.find(r => r.method === 'PUT')!.body).version,
			refused: refused instanceof ConfluenceConflictError ? refused.current.version : refused,
			writes: site.requests.filter(r => r.method === 'PUT').length,
		}).toEqual({ saved: 15, sent: { number: 15 }, refused: 16, writes: 1 });
	});

	it('reads a query as CQL only when it has a field and an operator, and keeps to the space either way', () => {
		expect([
			cqlQuery('a = b in prod', 'CHK'),
			cqlQuery('label = runbook ORDER BY title', 'CHK'),
			cqlQuery('title ~ "release"'),
		]).toEqual([
			'type = page AND text ~ "a = b in prod" AND space = "CHK" ORDER BY lastmodified DESC',
			'(label = runbook) AND space = "CHK" ORDER BY title',
			'title ~ "release"',
		]);
	});

	it('takes the page id from its links', () => {
		expect([
			confluencePageId('https://acme.atlassian.net/wiki/spaces/CHK/pages/123456/Release+checklist'),
			confluencePageId('https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=99'),
			confluencePageId('https://acme.atlassian.net/wiki/spaces/CHK/pages/edit-v2/77'),
			confluencePageId('31'),
			confluencePageId('https://acme.atlassian.net/wiki/spaces/CHK/overview'),
		]).toEqual(['123456', '99', '77', '31', undefined]);
	});
});

describe('DraftStore', () => {
	it('keeps a draft until removed, and forgets one untouched for two weeks', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drafts-'));
		let now = new Date('2026-10-01T00:00:00Z');
		const store = new DraftStore(dir, () => now);
		const draft = { id: 'd1', site: 'https://acme.atlassian.net', target: { kind: 'new' as const, spaceId: '7', spaceKey: 'CHK' }, title: 'Notes', markdown: '# Notes', createdAt: now.toISOString() };
		await store.save(draft);
		await store.save({ ...draft, id: 'd2' });
		await store.remove('d2');
		const kept = (await store.list()).map(d => d.id);
		now = new Date('2026-10-20T00:00:00Z');
		expect([kept, await store.list(), await store.get('../d1')]).toEqual([['d1'], [], undefined]);
	});
});

/** The Confluence feature, as its own bundle has it, with a stand-in for `vscode`, on a fake site. */
interface Feature {
	readonly drafts: DraftStore;
	call(name: string, args: Record<string, unknown>, agent?: string): Promise<TeamToolResult>;
}

describe('ConfluenceFeature', () => {
	const macro: AdfNode = { type: 'extension', attrs: { extensionKey: 'toc' } };
	const page: AdfDocument = { type: 'doc', version: 1, content: [macro, p('Run the tests.'), p('Check sizes.')] };
	let Feature: new (deps: unknown) => Feature;

	beforeAll(async () => {
		Feature = await hostExport('src/host/confluenceFeature.ts', 'ConfluenceFeature');
	});

	async function setUp(site: Awaited<ReturnType<typeof confluence>>, agentInFront?: () => string | undefined) {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'confluence-'));
		const account: ConfluenceAccount = { id: 'j1', name: 'Acme', site: site.url, email: 'me@acme.com', token: 't' };
		const feature = new Feature({
			extensionUri: 'extension', storageDir: dir, accounts: () => [account],
			request: (url: string, request: unknown) => teamRequest('confluence', url, request as never),
			write: async () => ({ ok: false, text: '' }),
			openLink: async () => undefined,
			...agentInFront ? { agentInFront } : {},
			log: { info() { }, warn() { } },
		});
		return feature;
	}

	/** The agent's draft of a new version of page 42, and the user's review of it saved: `kept` picks the changes kept by their order. */
	async function reviewed(feature: Feature, site: { url: string }, kept: (index: number) => boolean) {
		await feature.call('confluence_draft_page', { title: 'Checklist', markdown: 'Run all the tests.\n\nCheck sizes.\n\nShip it.', page: `${site.url}/wiki/spaces/CHK/pages/42/Checklist` });
		const [draft] = await feature.drafts.list();
		// What the Review Page makes of the agent's Markdown: the macro it can't write stays.
		const held = holdBlocks(page.content, [p('Run all the tests.'), p('Check sizes.'), p('Ship it.')]);
		const changes = blockChanges(page.content, held.content).flatMap(part => part.kind === 'change' ? [part.key] : []);
		await feature.drafts.save({ ...draft, saved: { type: 'doc', version: 1, content: held.content }, review: { kept: changes.filter((_, i) => kept(i)), held: held.held } });
		return draft.id;
	}

	it('publishes the page with only the changes kept, and what the agent can\'t write', async () => {
		const site = await confluence(14, page);
		const feature = await setUp(site);
		const id = await reviewed(feature, site, i => i === 1);
		const result = await feature.call('confluence_publish', { draft: id, title: 'Checklist' });
		const put = site.requests.find(r => r.method === 'PUT')!;
		expect({ ok: !result.isError, body: JSON.parse(JSON.parse(put.body).body.value), left: await feature.drafts.list() }).toEqual({
			ok: true,
			body: { type: 'doc', version: 1, content: [macro, p('Run the tests.'), p('Check sizes.'), p('Ship it.')] },
			left: [],
		});
	});

	it('writes nothing over a newer version, before the write or when Confluence refuses it (409)', async () => {
		const newer = await confluence(14, page);
		const raced = await confluence(14, page, true);
		const results: unknown[] = [];
		for (const [site, bump] of [[newer, true], [raced, false]] as const) {
			const feature = await setUp(site);
			const id = await reviewed(feature, site, () => true);
			if (bump) {
				site.bump();
			}
			const result = await feature.call('confluence_publish', { draft: id, title: 'Checklist' });
			results.push({ error: result.isError, data: result.data, kept: (await feature.drafts.list()).length, writes: site.requests.filter(r => r.method === 'PUT').length });
		}
		expect(results).toEqual([
			{ error: true, data: { conflict: 'true', version: 15 }, kept: 1, writes: 0 },
			{ error: true, data: { conflict: 'true', version: 15 }, kept: 1, writes: 1 },
		]);
	});

	it('refuses a page on a site that isn\'t connected, rather than a page of the same id elsewhere', async () => {
		const site = await confluence(14, page);
		const feature = await setUp(site);
		const read = await feature.call('confluence_get_page', { link: 'https://other.atlassian.net/wiki/spaces/X/pages/42/Plan' });
		const drafted = await feature.call('confluence_draft_page', { title: 'Plan', markdown: 'Hi', page: 'https://other.atlassian.net/wiki/spaces/X/pages/42/Plan' });
		expect({ read: read.isError, drafted: drafted.isError, says: read.content[0].type === 'text' && read.content[0].text.startsWith('other.atlassian.net isn\'t a connected Confluence site'), requests: site.requests.length }).toEqual({ read: true, drafted: true, says: true, requests: 0 });
	});

	it('is a write only GeminiCode\'s Review Page makes: an agent asking for it is refused', async () => {
		let called = false;
		const context: TeamToolContext = {
			connected: () => new Set(['confluence']),
			connectors: () => ({ confluence: [{ id: 'j1', name: 'Acme', site: 'https://acme.atlassian.net', email: 'me@acme.com', token: 't' }] }),
			folder: () => undefined,
			defaults: async () => ({}),
			confluence: () => ({ call: async () => (called = true, { content: [] }), openDraft: async () => undefined }),
		};
		const fromAgent = await callTeamTool(context, 'agent-1', 'confluence_publish', { draft: 'd1' });
		const asAgent = await teamWrite(context, { caller: 'agent', agent: 'agent-1' }, 'confluence_publish', { draft: 'd1' });
		expect({ fromAgent: fromAgent.isError, asAgent: asAgent.ok, called }).toEqual({ fromAgent: true, asAgent: false, called: false });
	});

	it('opens the Review Page in the active group when the drafting agent\'s tab isn\'t in front', async () => {
		const site = await confluence(14, page);
		const asked: string[] = [];
		const feature = await setUp(site, () => (asked.push('front'), 'another-agent'));
		const before = fakePanels().length;
		await feature.call('confluence_draft_page', { title: 'Checklist', markdown: 'Hi', page: `${site.url}/wiki/spaces/CHK/pages/42/Checklist` }, 'agent-1');
		await new Promise(resolve => setTimeout(resolve, 20));
		expect({ asked, column: fakePanels().slice(before).map(panel => panel.column) }).toEqual({ asked: ['front'], column: [-1] });
	});

	it('names the draft\'s site in the audit log when more than one Confluence site is connected', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'confluence-audit-'));
		const audit = new AuditLog(dir);
		const account = (host: string): ConfluenceAccount => ({ id: host, name: host, site: `https://${host}`, email: 'me@acme.com', token: 't' });
		const context: TeamToolContext = {
			audit,
			connected: () => new Set(['confluence']),
			connectors: () => ({ confluence: [account('acme.atlassian.net'), account('beta.atlassian.net')] }),
			folder: () => undefined,
			defaults: async () => ({}),
			confluence: () => ({ call: async () => ({ content: [{ type: 'text', text: 'Published' }] }), openDraft: async () => undefined }),
		};
		await teamWrite(context, { caller: 'ui' }, 'confluence_publish', { draft: 'd1', title: 'Checklist', site: 'beta.atlassian.net', page: '42' });
		expect((await audit.read()).map(entry => entry.effect)).toEqual([
			'Publish "Checklist" to Confluence as a new version of page 42 (beta.atlassian.net)',
			'Publish "Checklist" to Confluence as a new version of page 42 (beta.atlassian.net)',
		]);
	});
});
