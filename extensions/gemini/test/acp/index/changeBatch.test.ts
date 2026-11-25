/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ignoredPaths } from '../../../src/acp/gitIgnore';
import { ChangeBatch, maxBatchPaths, maxWatchedPaths } from '../../../src/acp/index/changeBatch';

describe('ChangeBatch', () => {
	it('passes on a few changed paths, and asks for a reconcile past what the indexer applies one by one', () => {
		const few = new ChangeBatch();
		['a.ts', 'b.ts', 'a.ts'].forEach(p => few.add(p));
		const many = new ChangeBatch();
		for (let i = 0; i < 100_000; i++) {
			many.add(`f${i}.ts`);
		}
		const edge = new ChangeBatch();
		for (let i = 0; i < maxBatchPaths - 1; i++) {
			edge.add(`f${i}.ts`);
		}
		expect([few.changed, many.changed, edge.changed?.length]).toEqual([['a.ts', 'b.ts'], undefined, 300]);
	});

	it('leaves out what git ignores before it calls a batch too big, and asks only then', async () => {
		let asked = 0;
		const ignored = async (paths: readonly string[]) => {
			asked++;
			return new Set(paths.filter(p => p.startsWith('dist/')));
		};
		const small = new ChangeBatch(maxBatchPaths, maxWatchedPaths);
		['src/a.ts', 'dist/a.js'].forEach(p => small.add(p));
		const kept = await small.settled(ignored);
		const askedForSmall = asked;
		// A build: 2,000 files of output and three sources.
		const build = new ChangeBatch(maxBatchPaths, maxWatchedPaths);
		for (let i = 0; i < 2_000; i++) {
			build.add(`dist/chunk${i}.js`);
		}
		['src/a.ts', 'src/b.ts', 'src/c.ts'].forEach(p => build.add(p));
		// A change of many real files, and one of more files than are held.
		const many = new ChangeBatch(maxBatchPaths, maxWatchedPaths);
		const flood = new ChangeBatch(maxBatchPaths, maxWatchedPaths);
		for (let i = 0; i < 6_000; i++) {
			if (i < 400) {
				many.add(`src/f${i}.ts`);
			}
			flood.add(`dist/f${i}.js`);
		}
		expect([kept, askedForSmall, await build.settled(ignored), await many.settled(ignored), await flood.settled(ignored), asked]).toEqual([
			['src/a.ts', 'dist/a.js'], 0, ['src/a.ts', 'src/b.ts', 'src/c.ts'], undefined, undefined, 2,
		]);
	});

	it('keeps every path of a big batch when git cannot say', async () => {
		const batch = new ChangeBatch(3, 10);
		['a', 'b', 'c', 'd'].forEach(p => batch.add(p));
		expect(await batch.settled(async () => { throw new Error('no git'); })).toBeUndefined();
	});
});

describe('ignoredPaths', () => {
	it('names the paths git ignores in one run, and none outside a repository', async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ignored-paths-')));
		try {
			const repo = path.join(root, 'repo');
			await fs.mkdir(path.join(repo, 'dist'), { recursive: true });
			execFileSync('git', ['init', '--quiet'], { cwd: repo });
			await fs.writeFile(path.join(repo, '.gitignore'), 'dist/\n*.log\n');
			const paths = [path.join(repo, 'dist', 'a.js'), path.join(repo, 'src', 'a.ts'), path.join(repo, 'build.log'), path.join(repo, 'with space.log')];
			expect([[...await ignoredPaths(repo, paths)], [...await ignoredPaths(root, paths)], [...await ignoredPaths(repo, [])]]).toEqual([
				[paths[0], paths[2], paths[3]], [], [],
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
