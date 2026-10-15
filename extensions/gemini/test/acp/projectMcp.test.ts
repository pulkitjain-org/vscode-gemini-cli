/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { ProjectMcpServer, type ProjectCaller } from '../../src/acp/projectMcp';

describe('ProjectMcpServer', () => {
	let server: ProjectMcpServer | undefined;
	afterEach(() => server?.dispose());

	async function setup() {
		const calls: [ProjectCaller, string, Record<string, unknown>][] = [];
		server = new ProjectMcpServer({ call: async (caller, name, args) => { calls.push([caller, name, args]); return { content: [{ type: 'text', text: 'ok' }] }; } }, '1.0.0');
		await server.start();
		return { server, calls };
	}

	async function rpc(config: { url: string; headers: { name: string; value: string }[] }, method: string, params?: unknown, token?: string) {
		const response = await fetch(config.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: token ?? config.headers[0].value },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		});
		return { status: response.status, body: response.status === 200 ? await response.json() as { result: { tools?: { name: string }[]; isError?: boolean } } : undefined };
	}

	it('lists each role\'s own tools', async () => {
		const { server } = await setup();
		const coordinator = server.configFor({ role: 'coordinator', project: 'p1' })!;
		const thread = server.configFor({ role: 'thread', project: 'p1', thread: 't1' })!;
		expect((await rpc(coordinator, 'tools/list')).body!.result.tools!.map(t => t.name)).toEqual(['start_thread', 'message_thread', 'list_threads', 'read_thread', 'post']);
		expect((await rpc(thread, 'tools/list')).body!.result.tools!.map(t => t.name)).toEqual(['report']);
	});

	it('gives add_repo to a thread in several repositories only', async () => {
		server = new ProjectMcpServer({ call: async () => ({ content: [] }), multiRepo: caller => caller.role === 'thread' && caller.thread === 'many' }, '1.0.0');
		await server.start();
		const many = server.configFor({ role: 'thread', project: 'p1', thread: 'many' })!;
		const one = server.configFor({ role: 'thread', project: 'p1', thread: 'one' })!;
		expect((await rpc(many, 'tools/list')).body!.result.tools!.map(t => t.name)).toEqual(['add_repo', 'report']);
		expect((await rpc(one, 'tools/list')).body!.result.tools!.map(t => t.name)).toEqual(['report']);
		expect((await rpc(one, 'tools/call', { name: 'add_repo', arguments: { repo: 'cms', reason: 'x' } })).body!.result.isError).toBe(true);
	});

	it('passes calls to the host with the caller', async () => {
		const { server, calls } = await setup();
		const thread = server.configFor({ role: 'thread', project: 'p1', thread: 't1' })!;
		await rpc(thread, 'tools/call', { name: 'report', arguments: { kind: 'result', text: 'done' } });
		expect(calls).toEqual([[{ role: 'thread', project: 'p1', thread: 't1' }, 'report', { kind: 'result', text: 'done' }]]);
		// A thread cannot call the coordinator's tools.
		expect((await rpc(thread, 'tools/call', { name: 'start_thread', arguments: {} })).body!.result.isError).toBe(true);
		expect(calls).toHaveLength(1);
	});

	it('refuses a thread\'s token on the coordinator\'s route', async () => {
		const { server } = await setup();
		const coordinator = server.configFor({ role: 'coordinator', project: 'p1' })!;
		const thread = server.configFor({ role: 'thread', project: 'p1', thread: 't1' })!;
		expect((await rpc(coordinator, 'tools/list', undefined, thread.headers[0].value)).status).toBe(401);
	});
});
