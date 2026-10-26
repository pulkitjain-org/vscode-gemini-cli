/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../../src/acp/auditLog';
import { GitLabClient } from '../../src/acp/gitlab';
import { teamReachability } from '../../src/acp/teamHttp';
import { callTeamTool, readOnlyRefusal, TeamToolContext, teamToolsFor, teamWrite } from '../../src/acp/teamTools';
import { TeamToolsMcpServer } from '../../src/acp/teamToolsMcp';

// Writes that can't be taken back: a later step that fails doesn't turn a done write into a
// failure (a retry would repeat it), a write with no answer stays unknown, and a reviewer only reads.

const servers: http.Server[] = [];
const dirs: string[] = [];
beforeEach(() => teamReachability.clear());
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		server.close();
	}
	await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

/** A GitLab whose answers `route` decides; undefined leaves the request unanswered. */
async function fakeGitLab(route: (method: string, url: string) => { status: number; body?: unknown } | undefined) {
	const requests: { method: string; url: string }[] = [];
	const server = http.createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			requests.push({ method: req.method ?? '', url: req.url ?? '' });
			const answer = route(req.method ?? '', req.url ?? '');
			if (answer) {
				res.writeHead(answer.status, { 'Content-Type': 'application/json' }).end(answer.body === undefined ? '' : JSON.stringify(answer.body));
			}
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function setUp(url: string, readOnly: ReadonlySet<string> = new Set()) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-write-safety-'));
	dirs.push(dir);
	const audit = new AuditLog(dir);
	const context: TeamToolContext = {
		audit,
		connected: () => new Set(['gitlab']),
		connectors: () => ({ gitlab: new GitLabClient({ url, token: 't' }) }),
		folder: () => undefined,
		defaults: async () => ({}),
		readOnly: agent => readOnly.has(agent),
	};
	return { audit, context, dir };
}

describe('team writes that partly fail', () => {
	it('reports a reply whose resolve failed as done, with a warning, and records it as made', async () => {
		const gitlab = await fakeGitLab((method, url) => method === 'PUT' ? { status: 500, body: { message: 'boom' } } : url.endsWith('/notes') ? { status: 201, body: { id: 55 } } : { status: 404 });
		const { audit, context } = await setUp(gitlab.url);
		const result = await teamWrite(context, { caller: 'ui' }, 'gitlab_reply', { project: '7', mr: '3', discussion: 'd1', text: 'Fixed in abc.', resolve: true });
		expect(result).toMatchObject({ ok: true, remote: 'note 55 on !3', warning: expect.stringContaining('The thread wasn\'t resolved') });
		expect((await audit.read()).map(e => e.phase)).toEqual(['intent', 'result']);
	});

	it('leaves a write that got no answer as unknown in the audit log', async () => {
		const gitlab = await fakeGitLab(() => undefined);
		const { audit, context } = await setUp(gitlab.url);
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		try {
			const writing = teamWrite(context, { caller: 'ui' }, 'gitlab_reply', { project: '7', mr: '3', text: 'Looks good.' });
			await vi.waitFor(() => expect(gitlab.requests).toHaveLength(1), { interval: 5 });
			await vi.advanceTimersByTimeAsync(20_000);
			expect(await writing).toMatchObject({ ok: false, unsure: true, text: 'GitLab didn\'t answer within 20 s. It may have gone through; check before trying again.' });
		} finally {
			vi.useRealTimers();
		}
		expect((await audit.unfinished()).map(e => e.tool)).toEqual(['gitlab_reply']);
	});
});

describe('a reviewer\'s team tools', () => {
	it('offers a read-only agent no write, and refuses one it asks for anyway', async () => {
		const gitlab = await fakeGitLab(() => ({ status: 201, body: { id: 1 } }));
		const { audit, context } = await setUp(gitlab.url, new Set(['reviewer']));
		expect(teamToolsFor(new Set(['gitlab']), true).map(t => t.name)).toEqual(['gitlab_get_mr', 'gitlab_list_mrs', 'gitlab_job_log', 'gitlab_get_issue']);
		const refused = await callTeamTool(context, 'reviewer', 'gitlab_reply', { project: '7', mr: '3', text: 'LGTM' });
		expect(refused).toEqual({ content: [{ type: 'text', text: readOnlyRefusal }], isError: true });
		expect(gitlab.requests).toHaveLength(0);
		expect(await audit.read()).toEqual([]);
		const server = new TeamToolsMcpServer(context, '1.0.0');
		try {
			await server.start();
			const list = async (agent: string) => {
				const config = server.configFor(agent)!;
				const answer = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: config.headers[0].value }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
				return ((await answer.json()) as { result: { tools: { name: string }[] } }).result.tools.map(t => t.name);
			};
			expect((await list('reviewer')).includes('gitlab_reply')).toBe(false);
			expect((await list('author')).includes('gitlab_reply')).toBe(true);
		} finally {
			server.dispose();
		}
	});

	it('merges only a merge request that is named', async () => {
		const gitlab = await fakeGitLab(() => ({ status: 200, body: [] }));
		const { context } = await setUp(gitlab.url);
		expect(await callTeamTool(context, 'author', 'gitlab_merge', {})).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Name the merge request to merge') }] });
	});
});

describe('Open Merge Request\'s uploads', () => {
	it('uploads a file through the audited path, and refuses one too large for GitLab', async () => {
		const gitlab = await fakeGitLab(method => method === 'POST' ? { status: 201, body: { markdown: '![shot](/uploads/x/shot.png)' } } : { status: 404 });
		const { audit, context, dir } = await setUp(gitlab.url);
		const file = path.join(dir, 'shot.png');
		await fs.writeFile(file, 'png');
		const made = await teamWrite(context, { caller: 'ui' }, 'gitlab_upload', { project: '7', file });
		expect(made).toMatchObject({ ok: true, data: { markdown: '![shot](/uploads/x/shot.png)' } });
		expect((await audit.read()).map(e => `${e.phase} ${e.effect}`)).toEqual(['intent Upload shot.png to 7', 'result Upload shot.png to 7']);
		const big = path.join(dir, 'big.mov');
		const handle = await fs.open(big, 'w');
		await handle.truncate(101 * 1024 * 1024);
		await handle.close();
		expect(await teamWrite(context, { caller: 'ui' }, 'gitlab_upload', { project: '7', file: big })).toMatchObject({ ok: false, text: expect.stringContaining('larger than 100 MB') });
		// Agents are never offered it.
		expect((await callTeamTool(context, 'author', 'gitlab_upload', { project: '7', file })).isError).toBe(true);
	});
});
