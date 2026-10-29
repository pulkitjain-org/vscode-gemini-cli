/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Finds the web servers already running on this machine, for the browser's
// `browser_dev_servers` tool: agents otherwise start a second dev server or
// guess its port. Only asked when an agent calls the tool, and every port is
// tried at once with a short timeout, so it costs well under a second.

import * as http from 'node:http';

/** The ports dev servers usually take: Next, CRA and Express, Angular, Astro, Flask, Vite, Live Server, Storybook, Django, the generic ones. */
export const devServerPorts: readonly number[] = [3000, 3001, 3002, 4000, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 6006, 8000, 8001, 8080, 8081, 8888, 9000];

/** How long one port gets to answer. */
const timeoutMs = 600;
/** How much of a page is read to find its title. */
const maxBodyBytes = 16 * 1024;

export interface DevServer {
	readonly url: string;
	readonly status: number;
	readonly title?: string;
}

/**
 * The local web servers answering on `ports`, in port order, as `localhost`
 * URLs. A port counts when it answers HTTP, on IPv4 or IPv6 (Vite and others
 * listen only on `::1` under newer Node versions).
 */
export async function findDevServers(ports: readonly number[] = devServerPorts): Promise<DevServer[]> {
	const found = await Promise.all(ports.map(async port => await probe('127.0.0.1', port) ?? await probe('::1', port)));
	return found.filter((server): server is DevServer => !!server);
}

/** One line per server, as the tool shows them. */
export function describeDevServer(server: DevServer): string {
	return `${server.url} (HTTP ${server.status}${server.title ? `, "${server.title}"` : ''})`;
}

function probe(host: string, port: number): Promise<DevServer | undefined> {
	return new Promise(resolve => {
		const req = http.get({ host, port, path: '/', timeout: timeoutMs, headers: { Accept: 'text/html' } }, res => {
			const chunks: Buffer[] = [];
			let size = 0;
			const done = () => {
				const body = Buffer.concat(chunks).toString('utf8');
				const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(body)?.[1].replace(/\s+/g, ' ').trim();
				resolve({ url: `http://localhost:${port}/`, status: res.statusCode ?? 0, ...(title ? { title } : {}) });
				req.destroy();
			};
			res.on('data', (chunk: Buffer) => {
				chunks.push(chunk);
				size += chunk.length;
				if (size >= maxBodyBytes) {
					done();
				}
			});
			res.on('end', done);
			res.on('close', done);
			res.on('error', done);
		});
		req.on('timeout', () => req.destroy());
		req.on('error', () => resolve(undefined));
	});
}
