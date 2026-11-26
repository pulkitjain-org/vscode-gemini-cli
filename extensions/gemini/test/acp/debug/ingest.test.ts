/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { allowedHosts, handleIngest, type IngestAnswer, IngestRoutes, ingestLimits, newIngestToken, startIngest } from '../../../src/acp/debug/ingest';

const port = 4321;

function routes(now = () => 0) {
	const list = new IngestRoutes(now);
	const route = list.open('agent-1', 'gc7f3a', { token: 'a'.repeat(32) });
	const container = list.open('agent-2', 'bbbb2222', { token: 'b'.repeat(32), fromContainer: true });
	return { list, route, container };
}

describe('ingest endpoint', () => {
	it('answers 204 with the events for a known token, dropping lines with another nonce or no marker', () => {
		const { list } = routes();
		const answer = handleIngest({ method: 'POST', url: `/debug/${'a'.repeat(32)}`, host: `127.0.0.1:${port}`, body: '@@gc:gc7f3a:p1@@ {"a":1}\n@@gc:other1:p1@@ {}\nplain line\n\n@@gc:gc7f3a:p2@@ {"b":2}\n' }, list, port);
		expect(answer).toEqual({
			status: 204,
			headers: { 'Access-Control-Allow-Origin': '*' },
			events: [{ agent: 'agent-1', point: 'p1', payload: '{"a":1}' }, { agent: 'agent-1', point: 'p2', payload: '{"b":2}' }],
			dropped: 2,
			agent: 'agent-1',
		});
	});

	it('answers 404 for a missing or unknown token, 421 for another Host, 405 for other methods, 413 and 408 for a refused body', () => {
		const { list } = routes();
		const url = `/debug/${'a'.repeat(32)}`;
		const host = `127.0.0.1:${port}`;
		const status = (request: Parameters<typeof handleIngest>[0]) => handleIngest(request, list, port).status;
		expect({
			unknown: status({ method: 'POST', url: `/debug/${'c'.repeat(32)}`, host, body: '' }),
			noToken: status({ method: 'POST', url: '/debug/', host, body: '' }),
			otherPath: status({ method: 'POST', url: '/mcp/agent-1', host, body: '' }),
			rebound: status({ method: 'POST', url, host: `evil.example:${port}`, body: '' }),
			wrongPort: status({ method: 'POST', url, host: '127.0.0.1:1', body: '' }),
			noHost: status({ method: 'POST', url, host: undefined, body: '' }),
			localhost: status({ method: 'POST', url, host: `localhost:${port}`, body: '' }),
			ipv6: status({ method: 'POST', url, host: `[::1]:${port}`, body: '' }),
			dockerPlain: status({ method: 'POST', url, host: `host.docker.internal:${port}`, body: '' }),
			dockerContainer: status({ method: 'POST', url: `/debug/${'b'.repeat(32)}`, host: `host.docker.internal:${port}`, body: '' }),
			get: status({ method: 'GET', url, host, body: '' }),
			options: status({ method: 'OPTIONS', url, host, body: '' }),
			tooLarge: handleIngest({ method: 'POST', url, host, body: 'too-large' }, list, port),
			timeout: handleIngest({ method: 'POST', url, host, body: 'timeout' }, list, port).status,
			hosts: allowedHosts(80, true),
		}).toEqual({
			unknown: 404, noToken: 404, otherPath: 404, rebound: 421, wrongPort: 421, noHost: 421, localhost: 204, ipv6: 204, dockerPlain: 421, dockerContainer: 204, get: 405, options: 204,
			tooLarge: { status: 413, headers: { 'Access-Control-Allow-Origin': '*' }, events: [], dropped: 1, agent: 'agent-1' },
			timeout: 408,
			hosts: ['127.0.0.1:80', 'localhost:80', '[::1]:80', 'host.docker.internal:80'],
		});
	});

	it('limits a route to 200 events a second with bursts of 400, counting the excess as drops', () => {
		let now = 0;
		const { list } = routes(() => now);
		const url = `/debug/${'a'.repeat(32)}`;
		const host = `127.0.0.1:${port}`;
		const body = Array.from({ length: 500 }, (_, i) => `@@gc:gc7f3a:p1@@ ${i}`).join('\n');
		const burst = handleIngest({ method: 'POST', url, host, body }, list, port, now);
		now += 1000;
		const later = handleIngest({ method: 'POST', url, host, body }, list, port, now);
		list.close('agent-1');
		const closed = handleIngest({ method: 'POST', url, host, body }, list, port, now);
		expect({ burst: [burst.events.length, burst.dropped], later: [later.events.length, later.dropped], closed: closed.status, left: list.size, token: /^[0-9a-f]{32}$/.test(newIngestToken()) })
			.toEqual({ burst: [ingestLimits.burst, 100], later: [ingestLimits.eventsPerSecond, 300], closed: 404, left: 1, token: true });
	});

	describe('on a real loopback socket', () => {
		const servers: { close(): Promise<void> }[] = [];
		afterEach(async () => {
			await Promise.all(servers.splice(0).map(s => s.close()));
		});

		it('receives a batch posted as a simple request, refuses another Host, and caps the body at 16 KB', async () => {
			const list = new IngestRoutes();
			const route = list.open('agent-1', 'gc7f3a');
			const answers: IngestAnswer[] = [];
			const server = await startIngest({ routes: list, onAnswer: answer => answers.push(answer) });
			servers.push(server);
			const url = `http://127.0.0.1:${server.port}/debug/${route.token}`;
			const posted = await fetch(url, { method: 'POST', body: '@@gc:gc7f3a:p1@@ {"a":1}\n@@gc:gc7f3a:p2@@ {"b":2}' });
			const unknown = await fetch(`http://127.0.0.1:${server.port}/debug/${'0'.repeat(32)}`, { method: 'POST', body: 'x' });
			const otherHost = await new Promise<number>((resolve, reject) => {
				const request = http.request(url, { method: 'POST', headers: { Host: 'evil.example:80' } }, response => resolve(response.statusCode ?? 0));
				request.on('error', reject);
				request.end('@@gc:gc7f3a:p1@@ {}');
			});
			const tooLarge = await fetch(url, { method: 'POST', body: `@@gc:gc7f3a:p1@@ ${'x'.repeat(ingestLimits.maxBodyBytes + 1)}` });
			expect({
				posted: [posted.status, posted.headers.get('access-control-allow-origin'), (await posted.text()).length],
				unknown: unknown.status,
				otherHost,
				tooLarge: tooLarge.status,
				answers: answers.map(a => ({ status: a.status, events: a.events.map(e => `${e.point} ${e.payload}`), dropped: a.dropped })),
			}).toEqual({
				posted: [204, '*', 0],
				unknown: 404,
				otherHost: 421,
				tooLarge: 413,
				answers: [{ status: 204, events: ['p1 {"a":1}', 'p2 {"b":2}'], dropped: 0 }, { status: 413, events: [], dropped: 1 }],
			});
		});
	});
});
