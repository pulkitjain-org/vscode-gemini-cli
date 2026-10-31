/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The endpoint a program posts HTTP markers to (DEBUG_MODE.md, The ingest
// endpoint): one small server for all agents on 127.0.0.1, a route per
// debug session behind a 128-bit token, the Host check against DNS
// rebinding, a body cap, and a token bucket per route. The request handling
// is pure functions over (method, url, headers, body), so the tests cover
// every answer without a socket; `startIngest` puts them on node:http.

import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { TokenBucket } from './evidenceStore';
import { matchOutputLine } from './points';

export const ingestLimits = {
	maxBodyBytes: 16 * 1024,
	/** The body must arrive within this. */
	readDeadlineMs: 2000,
	eventsPerSecond: 200,
	burst: 400,
} as const;

export interface IngestRoute {
	readonly token: string;
	readonly nonce: string;
	/** Whose route it is: the agent's id. */
	readonly agent: string;
	/** `host.docker.internal` is accepted only for a route made for a container. */
	readonly fromContainer?: boolean;
}

export interface IngestEvent {
	readonly agent: string;
	readonly point: string;
	readonly payload: string;
}

export interface IngestRequest {
	readonly method: string;
	readonly url: string;
	readonly host: string | undefined;
	/** The body; `too-large` when it passed the cap, `timeout` when it did not arrive in time. */
	readonly body: string | 'too-large' | 'timeout';
}

export interface IngestAnswer {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly events: readonly IngestEvent[];
	/** Lines not kept: the wrong nonce, no marker, over the rate, or the body refused. */
	readonly dropped: number;
	readonly agent?: string;
}

/** A new route token: 128 random bits. */
export function newIngestToken(): string {
	return randomBytes(16).toString('hex');
}

const cors = { 'Access-Control-Allow-Origin': '*' } as const;
const tokenPattern = /^\/debug\/([0-9a-f]{32})$/;

/** The hosts the Host header may name for `port`; `container` adds Docker's name for this Mac. */
export function allowedHosts(port: number, container: boolean): readonly string[] {
	return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...container ? [`host.docker.internal:${port}`] : []];
}

/** The routes open on the endpoint, by token, with each route's rate. */
export class IngestRoutes {

	private readonly byToken = new Map<string, { readonly route: IngestRoute; readonly bucket: TokenBucket }>();

	constructor(private readonly now: () => number = Date.now) { }

	/** Opens a route for `agent` with a new token; returns it. */
	open(agent: string, nonce: string, options: { readonly fromContainer?: boolean; readonly token?: string } = {}): IngestRoute {
		const route: IngestRoute = { token: options.token ?? newIngestToken(), nonce, agent, fromContainer: options.fromContainer };
		this.byToken.set(route.token, { route, bucket: new TokenBucket(ingestLimits.eventsPerSecond, ingestLimits.burst, this.now()) });
		return route;
	}

	/** Closes `agent`'s routes, at Clean up. */
	close(agent: string): void {
		for (const [token, entry] of this.byToken) {
			if (entry.route.agent === agent) {
				this.byToken.delete(token);
			}
		}
	}

	get size(): number {
		return this.byToken.size;
	}

	get(token: string): { readonly route: IngestRoute; readonly bucket: TokenBucket } | undefined {
		return this.byToken.get(token);
	}
}

/** The answer to one request, with the events it carried. */
export function handleIngest(request: IngestRequest, routes: IngestRoutes, port: number, now: number = Date.now()): IngestAnswer {
	const none = (status: number, headers: Record<string, string> = {}): IngestAnswer => ({ status, headers, events: [], dropped: 0 });
	if (request.method === 'OPTIONS') {
		// Never needed for the simple requests the templates send, but harmless, and it keeps a page's console quiet.
		return none(204, { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
	}
	if (request.method !== 'POST') {
		return none(405, { Allow: 'POST' });
	}
	const token = tokenPattern.exec(request.url)?.[1];
	const entry = token ? routes.get(token) : undefined;
	if (!entry) {
		return none(404);
	}
	if (!allowedHosts(port, !!entry.route.fromContainer).includes(request.host ?? '')) {
		return none(421);
	}
	if (request.body === 'too-large') {
		return { status: 413, headers: cors, events: [], dropped: 1, agent: entry.route.agent };
	}
	if (request.body === 'timeout') {
		return { status: 408, headers: cors, events: [], dropped: 1, agent: entry.route.agent };
	}
	const events: IngestEvent[] = [];
	let dropped = 0;
	for (const line of request.body.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		const matched = matchOutputLine(line);
		if (!matched || matched.nonce !== entry.route.nonce) {
			dropped++;
			continue;
		}
		if (!entry.bucket.take(now)) {
			dropped++;
			continue;
		}
		events.push({ agent: entry.route.agent, point: matched.point, payload: matched.payload });
	}
	return { status: 204, headers: cors, events, dropped, agent: entry.route.agent };
}

export interface IngestServer {
	readonly port: number;
	close(): Promise<void>;
}

export interface IngestOptions {
	readonly routes: IngestRoutes;
	/** Every request's events and drops, with the agent they are for. */
	onAnswer(answer: IngestAnswer): void;
	readonly now?: () => number;
}

/** Starts the endpoint on 127.0.0.1 with a port the system picks. */
export function startIngest(options: IngestOptions): Promise<IngestServer> {
	return new Promise((resolve, reject) => {
		let port = 0;
		const server = http.createServer((req, res) => {
			void readBody(req).then(body => {
				const answer = handleIngest({ method: req.method ?? '', url: req.url ?? '', host: req.headers.host, body }, options.routes, port, (options.now ?? Date.now)());
				res.writeHead(answer.status, answer.headers).end();
				if (answer.agent) {
					options.onAnswer(answer);
				}
			}, () => {
				if (!res.headersSent) {
					res.writeHead(400).end();
				}
			});
		});
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			port = (server.address() as AddressInfo).port;
			resolve({
				port,
				close: () => new Promise<void>(done => {
					server.close(() => done());
					server.closeAllConnections();
				}),
			});
		});
	});
}

/** The body as text, or why it was not read: streamed, without parsing, under the cap and the deadline. */
function readBody(req: http.IncomingMessage): Promise<string | 'too-large' | 'timeout'> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let done = false;
		const finish = (value: string | 'too-large' | 'timeout') => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				resolve(value);
			}
		};
		const timer = setTimeout(() => {
			finish('timeout');
			req.destroy();
		}, ingestLimits.readDeadlineMs);
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > ingestLimits.maxBodyBytes) {
				finish('too-large');
				req.resume();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
		req.on('error', err => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				reject(err);
			}
		});
	});
}
