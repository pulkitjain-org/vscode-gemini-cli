/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { teamRequest, TeamToolError } from '../../src/acp/teamHttp';

const servers: http.Server[] = [];
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
