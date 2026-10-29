/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// How much memory the indexer process takes building and holding the index
// of a 100,000-file folder (FINDINGS.md, "Workspace index"). It makes the
// folder, so it runs only with GEMINI_INDEX_PERF=1; the ordinary suite skips it.
// The result is written to <tmpdir>/geminicode-indexer-memory.json.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IndexClient } from '../../../src/acp/index/indexClient';
import type { IndexStatus } from '../../../src/acp/index/indexerProtocol';

const fileCount = 100_000;
/** The most the indexer may take for a folder this size, resident, in MB. */
const capMb = 512;

describe.runIf(process.env.GEMINI_INDEX_PERF === '1')('the indexer on a 100,000-file folder', () => {
	vi.setConfig({ hookTimeout: 600_000, testTimeout: 600_000 });
	const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'index-memory-')));
	const script = path.join(base, 'indexer.js');
	const folder = path.join(base, 'folder');
	let client: IndexClient;

	beforeAll(async () => {
		await build({ entryPoints: [path.join(__dirname, '../../../src/indexer.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: script, logLevel: 'silent' });
		for (let i = 0; i < fileCount; i++) {
			const dir = path.join(folder, 'src', `m${Math.floor(i / 1000)}`, `p${Math.floor(i / 50) % 20}`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(path.join(dir, `file${i}.ts`), `import { helper${(i + 1) % fileCount} } from './file${(i + 1) % fileCount}';\nexport function helper${i}(value: number): number {\n\treturn helper${(i + 1) % fileCount}(value) + ${i};\n}\n`);
		}
		client = new IndexClient({ script, execPath: process.execPath, baseDir: path.join(base, 'indexes'), log: () => undefined, restartDelaysMs: [] });
	}, 600_000);

	afterAll(() => {
		client.dispose();
		rmSync(base, { recursive: true, force: true });
	});

	it('builds it and stays under the memory cap', async () => {
		const ready = new Promise<IndexStatus>(resolve => {
			const listener = client.onDidChangeStatus(status => {
				if (status.root === folder && status.state.kind === 'ready') {
					listener.dispose();
					resolve(status);
				}
			});
		});
		const started = Date.now();
		await client.request('ensure', { root: folder, settings: { exclude: [], maxFileBytes: 1024 * 1024 }, build: true });
		const status = await ready;
		const buildMs = Date.now() - started;
		const residentKb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(client.pid)], { encoding: 'utf8' }).trim());
		const files = (await client.request('files', { root: folder }))?.length;
		const result = { files, buildMs, residentMb: Math.round(residentKb / 1024), state: status.state.kind };
		// The runner keeps a worker's console to itself; the number goes to a file beside the system's temporary files.
		writeFileSync(path.join(tmpdir(), 'geminicode-indexer-memory.json'), JSON.stringify(result));
		console.log(`Indexer at ${fileCount} files: ${JSON.stringify(result)}`);
		expect(result.residentMb).toBeLessThan(capMb);
		expect(result.state).toBe('ready');
	}, 600_000);
});
