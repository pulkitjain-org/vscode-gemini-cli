/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { build } from 'esbuild';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IndexClient } from '../../../src/acp/index/indexClient';
import type { HostMessage, IndexStatus } from '../../../src/acp/index/indexerProtocol';

/** Stands in for the forked process: records what the client does to it, answers what it is told to. */
class FakeChild extends EventEmitter {
	readonly calls: string[] = [];
	readonly pid = 4242;
	connected = true;
	readonly stderr = undefined;
	constructor(private readonly answers: (message: HostMessage) => boolean) {
		super();
	}
	send(message: HostMessage, callback?: (err: Error | null) => void): boolean {
		callback?.(null);
		if (this.answers(message)) {
			setImmediate(() => this.emit('message', { kind: 'answer', id: message.id, result: [] }));
		}
		return true;
	}
	disconnect(): void {
		this.calls.push('disconnect');
		this.connected = false;
	}
	kill(signal?: string): boolean {
		this.calls.push(`kill ${signal}`);
		return true;
	}
}

describe('IndexClient stopping its process', () => {
	const fakeClient = (child: FakeChild, stopGraceMs: number) => new IndexClient({ script: 'indexer.js', execPath: process.execPath, baseDir: '/nowhere', log: () => undefined, stopGraceMs, fork: (() => child) as never });

	it('disconnects first, and signals only a process that does not exit in the grace', async () => {
		const child = new FakeChild(() => true);
		const client = fakeClient(child, 30);
		await client.request('status', { roots: [] });
		client.dispose();
		expect(child.calls).toEqual(['disconnect']);
		await new Promise(resolve => setTimeout(resolve, 45));
		expect(child.calls).toEqual(['disconnect', 'kill SIGTERM']);
		await new Promise(resolve => setTimeout(resolve, 40));
		expect(child.calls).toEqual(['disconnect', 'kill SIGTERM', 'kill SIGKILL']);

		const prompt = new FakeChild(() => true);
		const quick = fakeClient(prompt, 30);
		await quick.request('status', { roots: [] });
		quick.dispose();
		prompt.emit('exit', 0, null);
		await new Promise(resolve => setTimeout(resolve, 80));
		expect(prompt.calls).toEqual(['disconnect']);
	});

	it('ends a process after three unanswered requests in a row, not three over its life', async () => {
		// Only the timers: the fake child answers through setImmediate.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
		try {
			let answer = false;
			const child = new FakeChild(() => answer);
			const client = fakeClient(child, 30);
			const timesOut = async () => {
				const failed = expect(client.request('status', { roots: [] })).rejects.toThrow('did not answer status within 30 s');
				await vi.advanceTimersByTimeAsync(30_000);
				await failed;
			};
			await timesOut();
			await timesOut();
			answer = true;
			await client.request('status', { roots: [] });
			answer = false;
			await timesOut();
			await timesOut();
			expect(child.calls).toEqual([]);
			await timesOut();
			expect(child.calls).toEqual(['kill undefined']);
			client.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('IndexClient with the real indexer process', () => {
	const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'index-client-')));
	const script = path.join(base, 'indexer.js');
	const folder = path.join(base, 'folder');
	const logs: string[] = [];
	let client: IndexClient;
	const settings = { exclude: [], maxFileBytes: 1024 * 1024 };

	beforeAll(async () => {
		await build({ entryPoints: [path.join(__dirname, '../../../src/indexer.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: script, logLevel: 'silent' });
		mkdirSync(path.join(folder, 'src'), { recursive: true });
		writeFileSync(path.join(folder, 'src', 'billing.ts'), 'export function chargeInvoice(id: string) {\n\treturn id;\n}\n');
		client = new IndexClient({ script, execPath: process.execPath, baseDir: path.join(base, 'indexes'), log: message => logs.push(message), restartDelaysMs: [10, 10] });
	}, 30_000);

	afterAll(() => {
		client.dispose();
		rmSync(base, { recursive: true, force: true });
	});

	const ready = () => new Promise<IndexStatus>(resolve => {
		const listener = client.onDidChangeStatus(status => {
			if (status.root === folder && status.state.kind === 'ready') {
				listener.dispose();
				resolve(status);
			}
		});
	});

	it('starts the process on the first request, builds, and answers queries', async () => {
		expect(client.running).toBe(false);
		const built = ready();
		const first = await client.request('ensure', { root: folder, settings, build: true });
		expect(client.running).toBe(true);
		expect(first.state.kind).toBe('building');
		expect((await built).state).toMatchObject({ kind: 'ready', files: 1 });
		const answer = await client.request('search', { root: folder, query: { query: 'charge invoice' } });
		expect(answer.result.hits.map(h => h.path)).toEqual(['src/billing.ts']);
	});

	it('stores fetched documentation and searches it', async () => {
		const html = '<html><head><title>Retries – Payments Docs</title></head><body><nav>Home Docs</nav><main><h1>Retries</h1><p>Failed <code>chargeInvoice</code> calls are retried with backoff.</p><h2>Limits</h2><p>At most five attempts.</p></main></body></html>';
		const status = await client.request('docsIngest', { source: { id: 'payments', url: 'https://docs.example.com/', run: 1 }, pages: [{ url: 'https://docs.example.com/retries', body: html, type: 'html', etag: '"v1"' }], unchanged: [], complete: true });
		expect(status).toMatchObject({ id: 'payments', pages: 1, sections: 2, title: 'Payments Docs' });
		const found = await client.request('docsSearch', { ids: ['payments'], query: 'how many attempts' });
		expect(found.hits.map(h => [h.heading, h.text])).toEqual([['Retries › Limits', 'At most five attempts.']]);
		expect(await client.request('docsValidators', { id: 'payments' })).toEqual({ 'https://docs.example.com/retries': { etag: '"v1"' } });
	});

	it('starts the process again after it crashes, and rejects what it was answering', async () => {
		const started = new Promise<void>(resolve => {
			const listener = client.onDidStart(() => {
				listener.dispose();
				resolve();
			});
		});
		(client as unknown as { child: { kill(signal: string): void } }).child.kill('SIGKILL');
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(client.running).toBe(false);
		const status = await client.request('status', { roots: [folder] });
		await started;
		expect(status[0].state).toMatchObject({ kind: 'ready', files: 1 });
		expect(logs.some(line => line.includes('Indexer exited'))).toBe(true);
	});

	it('gives up after crashing again and again, then tries again after a cooldown', async () => {
		const flaky = new IndexClient({ script, execPath: process.execPath, baseDir: path.join(base, 'indexes'), log: () => undefined, restartDelaysMs: [], cooldownMs: 300 });
		const changes: boolean[] = [];
		flaky.onDidChangeFailed(failed => changes.push(failed));
		try {
			await flaky.request('status', { roots: [folder] });
			(flaky as unknown as { child: { kill(signal: string): void } }).child.kill('SIGKILL');
			await new Promise(resolve => setTimeout(resolve, 100));
			expect(flaky.failed).toBe(true);
			await expect(flaky.request('status', { roots: [folder] })).rejects.toThrow('stopped after crashing');
			await new Promise(resolve => setTimeout(resolve, 350));
			expect([flaky.failed, changes]).toEqual([false, [true, false]]);
			expect((await flaky.request('status', { roots: [folder] }))[0].root).toBe(folder);
		} finally {
			flaky.dispose();
		}
	});
});
