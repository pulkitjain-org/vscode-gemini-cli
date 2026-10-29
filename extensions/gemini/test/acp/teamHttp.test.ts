/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retryAfterSeconds, TeamReachability, teamReachability, teamRequest, teamRequestPage, TeamToolError } from '../../src/acp/teamHttp';

const servers: http.Server[] = [];
beforeEach(() => teamReachability.clear());
afterEach(() => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		server.close();
	}
});

async function serve(handle: (req: http.IncomingMessage, res: http.ServerResponse) => void, host = '127.0.0.1'): Promise<string> {
	const server = http.createServer(handle);
	servers.push(server);
	await new Promise<void>(resolve => server.listen(0, host, resolve));
	return `http://${host === '127.0.0.1' ? '127.0.0.1' : 'localhost'}:${(server.address() as AddressInfo).port}`;
}

/** A server that answers with the headers and method it got. */
function echo(req: http.IncomingMessage, res: http.ServerResponse): void {
	res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ method: req.method, token: req.headers['private-token'] ?? null, url: req.url }));
}

describe('teamRequest redirects', () => {
	it('keeps the token for the same origin and drops it for another', async () => {
		// localhost and 127.0.0.1 are different origins, as a GitLab host and its object storage are.
		const storage = await serve(echo, 'localhost');
		const gitlab = await serve((req, res) => {
			if (req.url === '/api/v4/moved') {
				return void res.writeHead(301, { Location: '/api/v4/here' }).end();
			}
			if (req.url === '/api/v4/trace') {
				return void res.writeHead(302, { Location: `${storage}/bucket/trace.log?signed=1` }).end();
			}
			echo(req, res);
		});
		const headers = { 'PRIVATE-TOKEN': 'glpat-secret' };
		expect({
			sameOrigin: await teamRequest('gitlab', `${gitlab}/api/v4/moved`, { headers }),
			otherOrigin: await teamRequest('gitlab', `${gitlab}/api/v4/trace`, { headers }),
		}).toEqual({
			sameOrigin: { method: 'GET', token: 'glpat-secret', url: '/api/v4/here' },
			otherOrigin: { method: 'GET', token: null, url: '/bucket/trace.log?signed=1' },
		});
	});

	it('turns a POST into a GET after a 303, as fetch does, and gives up on a loop', async () => {
		const url = await serve((req, res) => {
			if (req.url === '/created') {
				return void res.writeHead(303, { Location: '/result' }).end();
			}
			if (req.url === '/loop') {
				return void res.writeHead(302, { Location: '/loop' }).end();
			}
			echo(req, res);
		});
		expect(await teamRequest('jira', `${url}/created`, { method: 'POST', body: { a: 1 } })).toMatchObject({ method: 'GET', url: '/result' });
		await expect(teamRequest('jira', `${url}/loop`)).rejects.toMatchObject({ kind: 'failed', message: expect.stringContaining('kept redirecting') });
	});
});

describe('teamRequest time limit', () => {
	it('fails a host that sends its headers and then stalls', async () => {
		const url = await serve((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.write('{"partial":');
		});
		const failure: unknown = await teamRequest('gitlab', `${url}/api/v4/user`, { timeoutMs: 200 }).catch(err => err);
		expect(failure instanceof TeamToolError && failure.kind).toBe('unreachable');
	});
});

describe('one reachability state per server', () => {
	it('fails at once while a server is unreachable, and lets a call through when its wait ends', async () => {
		let calls = 0;
		const url = await serve((_req, res) => {
			calls++;
			res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
		});
		// The server answered nothing once: as if the VPN was off.
		teamReachability.failed('gitlab', `${url}/api/v4/user`);
		const blocked: unknown = await teamRequest('gitlab', `${url}/api/v4/user`).catch(err => err);
		expect(blocked instanceof TeamToolError && { kind: blocked.kind, message: blocked.message, blocked: blocked.detail.blocked }).toEqual({ kind: 'unreachable', message: 'GitLab is unreachable right now (VPN?)', blocked: true });
		expect(calls).toBe(0);
		teamReachability.retryNow('gitlab');
		expect(await teamRequest('gitlab', `${url}/api/v4/user`)).toEqual({ ok: true });
		expect(calls).toBe(1);
		expect(teamReachability.health('gitlab')).toEqual({ kind: 'ok' });
	});

	it('backs off 30 s, 1 min, 2 min, up to 5 min, and recovers on the first answer', () => {
		let now = 0;
		const reachability = new TeamReachability(() => now);
		const changes: string[] = [];
		reachability.onDidChange(change => changes.push(change.health.kind));
		const waits: number[] = [];
		for (let i = 0; i < 6; i++) {
			reachability.failed('gitlab', 'https://gitlab.acme.internal/api/v4/user');
			const health = reachability.health('gitlab');
			waits.push(health.kind === 'unreachable' ? health.retryAt - now : -1);
			now += 1000;
		}
		expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
		expect(reachability.blocked('gitlab', 'https://gitlab.acme.internal/api/v4/projects')?.message).toBe('GitLab is unreachable right now (VPN?)');
		// Another server of the same tool is a state of its own.
		expect(reachability.blocked('gitlab', 'https://other.acme.internal/api/v4/user')).toBeUndefined();
		now += 300_000;
		expect(reachability.blocked('gitlab', 'https://gitlab.acme.internal/api/v4/user')).toBeUndefined();
		reachability.succeeded('gitlab', 'https://gitlab.acme.internal/api/v4/user');
		expect(changes.at(-1)).toBe('ok');
	});

	it('stops calling with a refused token until the token changes', async () => {
		const tokens: string[] = [];
		const url = await serve((req, res) => {
			tokens.push(String(req.headers['private-token']));
			res.writeHead(req.headers['private-token'] === 'new' ? 200 : 401, { 'Content-Type': 'application/json' }).end('{}');
		});
		const call = (token: string) => teamRequest('gitlab', `${url}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': token } }).then(() => 'ok', (err: TeamToolError) => `${err.kind}${err.detail.blocked ? ' (blocked)' : ''}`);
		expect([await call('old'), await call('old'), await call('new')]).toEqual(['auth', 'auth (blocked)', 'ok']);
		expect(tokens).toEqual(['old', 'new']);
	});
});

describe('busy servers and slow writes', () => {
	it('retries a read once after a 503, and never a write', async () => {
		const seen: string[] = [];
		const url = await serve((req, res) => {
			seen.push(req.method ?? '');
			const first = seen.filter(method => method === req.method).length === 1;
			res.writeHead(first ? 503 : 200, { 'Content-Type': 'application/json', 'Retry-After': '0' }).end('{"done":true}');
		});
		expect(await teamRequest('gitlab', `${url}/api/v4/x`)).toEqual({ done: true });
		await expect(teamRequest('gitlab', `${url}/api/v4/x`, { method: 'POST', body: {} })).rejects.toMatchObject({ status: 503 });
		expect(seen).toEqual(['GET', 'GET', 'POST']);
	});

	it('says how long a rate limit lasts, and waits for a short one', async () => {
		let calls = 0;
		const url = await serve((_req, res) => {
			calls++;
			res.writeHead(429, { 'Retry-After': '60' }).end();
		});
		await expect(teamRequest('jira', `${url}/rest/api/3/myself`)).rejects.toThrow('Jira is rate-limiting requests; try again in 60 s.');
		expect(calls).toBe(1);
		expect(retryAfterSeconds('2', 0)).toBe(2);
		expect(retryAfterSeconds(new Date(5000).toUTCString(), 0)).toBe(5);
	});

	it('says a write that got no answer may have gone through, and keeps the server reachable', async () => {
		const url = await serve(() => undefined);
		const failure: unknown = await teamRequest('gitlab', `${url}/api/v4/projects/1/merge_requests/2/notes`, { method: 'POST', body: { body: 'x' }, timeoutMs: 200 }).catch(err => err);
		expect(failure instanceof TeamToolError && { message: failure.message, unsure: failure.detail.unsure }).toEqual({ message: 'GitLab didn\'t answer within 1 s. It may have gone through; check before trying again.', unsure: true });
		expect(teamReachability.blocked('gitlab', url)).toBeUndefined();
	});

	it('reads the total of a paged list', async () => {
		const url = await serve((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json', 'X-Total': '312', 'X-Next-Page': '2' }).end('[1,2]'));
		expect(await teamRequestPage('gitlab', `${url}/api/v4/x`)).toEqual({ body: [1, 2], total: 312, nextPage: 2 });
	});
});
