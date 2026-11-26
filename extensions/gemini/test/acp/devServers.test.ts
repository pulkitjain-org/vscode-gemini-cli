/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { describeDevServer, findDevServers } from '../../src/acp/devServers';

describe('findDevServers', () => {
	const servers: { close(): void }[] = [];
	afterEach(() => servers.splice(0).forEach(s => s.close()));

	function listen<T extends net.Server>(server: T, host: string): Promise<number> {
		servers.push(server);
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
		});
	}

	it('finds HTTP servers on IPv4 and IPv6 with their titles, and skips ports that are closed or not HTTP', async () => {
		const app = await listen(http.createServer((_req, res) => res.end('<html><head><title> My\n app </title></head></html>')), '127.0.0.1');
		// Where the machine has IPv6.
		const api = await listen(http.createServer((_req, res) => res.writeHead(404).end('{}')), '::1').catch(() => undefined);
		const notHttp = await listen(net.createServer(socket => socket.end()), '127.0.0.1');
		const closed = await listen(http.createServer(), '127.0.0.1');
		servers.pop()!.close();
		const found = await findDevServers([app, ...api ? [api] : [], notHttp, closed]);
		expect(found.map(describeDevServer)).toEqual([
			`http://localhost:${app}/ (HTTP 200, "My app")`,
			...api ? [`http://localhost:${api}/ (HTTP 404)`] : [],
		]);
	});
});
