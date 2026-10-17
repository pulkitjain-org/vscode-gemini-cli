/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { lastEvent, parseFigmaLink } from '../../src/acp/figma';
import { GitLabClient, parseMrRef, projectPathFromRemote, stripAnsi } from '../../src/acp/gitlab';
import { adfToText, JiraClient, jiraKeyIn, textToAdf } from '../../src/acp/jira';
import { parseSnykCode, parseSnykTest } from '../../src/acp/snyk';
import { isReleaseBranch, releaseBranchForVersion, sortReleaseBranches } from '../../src/acp/teamDefaults';
import { normalizeBaseUrl, teamRequest, TeamToolError } from '../../src/acp/teamHttp';
import { teamReadTools, teamToolsFor, teamWriteTools } from '../../src/acp/teamTools';
import { TeamToolsMcpServer } from '../../src/acp/teamToolsMcp';

/** A local HTTP server answering with `handler`; records each request. */
async function serve(handler: (req: http.IncomingMessage, body: string) => { status?: number; body?: unknown; text?: string }) {
	const requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', chunk => body += chunk);
		req.on('end', () => {
			requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
			const answer = handler(req, body);
			res.writeHead(answer.status ?? 200, { 'Content-Type': answer.text !== undefined ? 'text/plain' : 'application/json' });
			res.end(answer.text ?? (answer.body === undefined ? '' : JSON.stringify(answer.body)));
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const servers: http.Server[] = [];
afterEach(() => {
	servers.splice(0).forEach(s => s.close());
});

describe('teamRequest', () => {
	it('says to check the VPN when a VPN-only host does not answer', async () => {
		const err = await teamRequest('gitlab', 'http://127.0.0.1:1/api/v4/user', { timeoutMs: 2000 }).catch(e => e);
		expect(err).toBeInstanceOf(TeamToolError);
		expect(err.kind).toBe('unreachable');
		expect(err.message).toMatch(/Can't reach GitLab at 127\.0\.0\.1:1\. Check that your VPN is on\./);
	});

	it('names an expired or revoked token', async () => {
		const { url } = await serve(() => ({ status: 401, body: { message: '401 Unauthorized' } }));
		const err = await teamRequest('sonar', `${url}/api/x`).catch(e => e);
		expect(err.kind).toBe('auth');
		expect(err.message).toMatch(/replace it in Connections/);
	});

	it('passes on the server\'s own error text', async () => {
		const { url } = await serve(() => ({ status: 400, body: { errorMessages: ['Field fixVersions is required.'] } }));
		await expect(teamRequest('jira', `${url}/x`)).rejects.toThrow(/Jira answered 400\. Field fixVersions is required\./);
	});

	it('adds https:// to a bare host and drops trailing slashes', () => {
		expect(normalizeBaseUrl('gitlab.acme.internal/')).toBe('https://gitlab.acme.internal');
		expect(normalizeBaseUrl('http://localhost:9000')).toBe('http://localhost:9000');
	});
});

describe('Jira', () => {
	it('turns Atlassian Document Format into text and back', () => {
		const adf = {
			type: 'doc', content: [
				{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
				{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Shows a ' }, { type: 'text', text: 'gift', marks: [{ type: 'code' }] }, { type: 'text', text: ' box' }] }] }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'Design', marks: [{ type: 'link', attrs: { href: 'https://figma.com/design/K/x?node-id=1-2' } }] }] },
			],
		};
		expect(adfToText(adf).trim()).toBe('### Acceptance criteria\n\n- Shows a `gift` box\n\nDesign (https://figma.com/design/K/x?node-id=1-2)');
		expect(textToAdf('One\ntwo\n\nThree')).toEqual({
			type: 'doc', version: 1, content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'One' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'Three' }] },
			],
		});
	});

	it('finds ticket keys in branch names, lower case only for known projects', () => {
		expect(jiraKeyIn('ACME-412-gift-message')).toBe('ACME-412');
		expect(jiraKeyIn('feature/acme-412-gift', ['ACME'])).toBe('ACME-412');
		expect(jiraKeyIn('release-2026')).toBeUndefined();
		expect(jiraKeyIn('release/2026.11', ['ACME'])).toBeUndefined();
	});

	it('moves a ticket with the field and comment its transition asks for', async () => {
		const { url, requests } = await serve(req => req.method === 'GET'
			? { body: { transitions: [{ id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } }, fields: { fixVersions: { name: 'Fix versions', required: true, schema: { type: 'array' }, allowedValues: [{ id: '100', name: '2026.11' }] } } }] } }
			: { status: 204 });
		const jira = new JiraClient({ site: url, email: 'me@acme.com', token: 't' });
		await expect(jira.transition('ACME-1', 'Done')).rejects.toThrow(/needs Fix versions \(one of: 2026\.11\)/);
		await jira.transition('ACME-1', 'done', 'Shipped', { 'Fix versions': '2026.11' });
		const post = requests.find(r => r.method === 'POST')!;
		expect(post.headers.authorization).toBe(`Basic ${Buffer.from('me@acme.com:t').toString('base64')}`);
		expect(JSON.parse(post.body)).toEqual({
			transition: { id: '31' },
			fields: { fixVersions: [{ id: '100' }] },
			update: { comment: [{ add: { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Shipped' }] }] } } }] },
		});
	});
});

describe('GitLab', () => {
	it('finds the project of a git remote on the GitLab host', () => {
		expect(projectPathFromRemote('git@gitlab.acme.internal:shop/acme-checkout.git', 'https://gitlab.acme.internal')).toBe('shop/acme-checkout');
		expect(projectPathFromRemote('https://gitlab.acme.internal/shop/web/acme-checkout', 'gitlab.acme.internal')).toBe('shop/web/acme-checkout');
		expect(projectPathFromRemote('ssh://git@gitlab.acme.internal:2222/shop/a.git', 'https://gitlab.acme.internal')).toBe('shop/a');
		expect(projectPathFromRemote('git@github.com:shop/a.git', 'https://gitlab.acme.internal')).toBeUndefined();
	});

	it('reads merge request links and numbers', () => {
		expect(parseMrRef('https://gitlab.acme.internal/shop/acme-checkout/-/merge_requests/318/diffs')).toEqual({ project: 'shop/acme-checkout', iid: 318 });
		expect(parseMrRef('!322')).toEqual({ iid: 322 });
		expect(parseMrRef('feature')).toBeUndefined();
	});

	it('sends the token in PRIVATE-TOKEN and lists review requests for the user', async () => {
		const { url, requests } = await serve(req => req.url === '/api/v4/user'
			? { body: { id: 7, username: 'pulkit.jain', name: 'Pulkit' } }
			: { body: [{ iid: 322, project_id: 3, title: 'Wishlist sync', web_url: `x/shop/a/-/merge_requests/322`, source_branch: 'f', target_branch: 'develop', author: { username: 'marie.dubois' }, references: { full: 'shop/a!322' } }] });
		const gitlab = new GitLabClient({ url, token: 'glpat-x' });
		const list = await gitlab.reviewRequests();
		expect(list[0]).toMatchObject({ iid: 322, project: 'shop/a', author: 'marie.dubois', targetBranch: 'develop' });
		expect(requests[1].url).toBe('/api/v4/merge_requests?scope=all&state=opened&reviewer_id=7&per_page=20&order_by=updated_at');
		expect(requests.every(r => r.headers['private-token'] === 'glpat-x')).toBe(true);
	});

	it('strips colour codes and section markers from job logs', () => {
		expect(stripAnsi('\u001b[31mFAIL\u001b[0m test')).toBe('FAIL test');
	});
});

describe('Snyk', () => {
	it('reads dependency issues with their fix, worst first', () => {
		const out = JSON.stringify({ vulnerabilities: [
			{ id: 'SNYK-1', title: 'Prototype Pollution', severity: 'medium', packageName: 'lodash', version: '4.17.20', isUpgradable: true, upgradePath: [false, 'lodash@4.17.21'] },
			{ id: 'SNYK-2', title: 'SSRF', severity: 'high', packageName: 'axios', version: '1.6.0', fixedIn: ['1.7.4'] },
			{ id: 'SNYK-2', title: 'SSRF', severity: 'high', packageName: 'axios', version: '1.6.0', fixedIn: ['1.7.4'] },
		] });
		const result = parseSnykTest(out, 1);
		expect(result.findings.map(f => [f.severity, f.where, f.fix])).toEqual([
			['high', 'axios@1.6.0', 'fixed in axios 1.7.4'],
			['medium', 'lodash@4.17.20', 'upgrade to lodash@4.17.21'],
		]);
	});

	it('says plainly when it can\'t test', () => {
		expect(parseSnykTest('', 3).problem).toMatch(/no project/);
		expect(parseSnykTest('{"error":"getaddrinfo ENOTFOUND snyk.acme.internal"}', 2).problem).toMatch(/VPN/);
	});

	it('reads Snyk Code SARIF', () => {
		const sarif = { runs: [{ tool: { driver: { rules: [{ id: 'js/XSS', shortDescription: { text: 'Cross-site Scripting' } }] } }, results: [{ ruleId: 'js/XSS', level: 'error', message: { text: 'Unsanitized input' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/gift.ts' }, region: { startLine: 12 } } }] }] }] };
		expect(parseSnykCode(JSON.stringify(sarif), 1).findings[0]).toMatchObject({ severity: 'high', title: 'Cross-site Scripting', file: 'src/gift.ts', line: 12 });
	});
});

describe('Figma', () => {
	it('reads the file and node of a link', () => {
		expect(parseFigmaLink('https://www.figma.com/design/AbC123/Checkout?node-id=12-34&m=dev')).toEqual({ fileKey: 'AbC123', nodeId: '12:34' });
		expect(parseFigmaLink('https://example.com/design/x')).toBeUndefined();
	});

	it('reads the answer in an event stream', () => {
		expect(lastEvent('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n')).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
	});
});

describe('release branches', () => {
	it('matches the team\'s pattern and sorts by version', () => {
		expect(isReleaseBranch('release/2026.11')).toBe(true);
		expect(isReleaseBranch('releases/2026.11')).toBe(false);
		expect(sortReleaseBranches(['release/2026.11', 'release/1.10', 'release/1.9', 'release/2026.10'])).toEqual(['release/1.9', 'release/1.10', 'release/2026.10', 'release/2026.11']);
		expect(releaseBranchForVersion('2026.11', ['release/2026.10', 'release/2026.11'])).toBe('release/2026.11');
	});
});

describe('geminicode-tools server', () => {
	let server: TeamToolsMcpServer | undefined;
	afterEach(() => server?.dispose());

	it('lists only the connected tools\' functions, and wants each agent\'s own token', async () => {
		const connected = new Set(['jira'] as const);
		server = new TeamToolsMcpServer({ connected: () => connected, connectors: () => ({}), folder: () => undefined, defaults: async () => ({}) }, '1.0.0');
		await server.start();
		const config = server.configFor('a1')!;
		const rpc = (token: string) => fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
		const listed = await (await rpc(config.headers[0].value)).json() as { result: { tools: { name: string }[] } };
		expect(listed.result.tools.map(t => t.name)).toEqual(['jira_get_issue', 'jira_search', 'jira_comment', 'jira_transition']);
		expect((await rpc(server.configFor('a2')!.headers[0].value)).status).toBe(401);
	});

	it('keeps writes apart from reads', () => {
		expect(teamWriteTools.map(t => t.name)).toEqual(['jira_comment', 'jira_transition', 'gitlab_create_mr', 'gitlab_reply']);
		expect(teamReadTools).toHaveLength(12);
		expect(teamToolsFor(new Set())).toEqual([]);
	});
});
