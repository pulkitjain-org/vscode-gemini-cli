/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GitIgnoreChecker } from '../../src/acp/gitIgnore';

describe('GitIgnoreChecker', () => {
	const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'gitignore-')));
	const repo = path.join(base, 'repo');
	mkdirSync(path.join(repo, 'src'), { recursive: true });
	execFileSync('git', ['init', '-q'], { cwd: repo });
	writeFileSync(path.join(repo, '.gitignore'), '*.log\n!keep.log\nbuild/\n');
	const plain = path.join(base, 'plain');
	mkdirSync(plain);
	const checker = new GitIgnoreChecker();
	afterAll(() => {
		checker.dispose();
		rmSync(base, { recursive: true, force: true });
	});

	it('answers many files through one git process, honouring negated patterns', async () => {
		const files = ['a.log', 'keep.log', 'src/a.ts', 'build/out.js', 'src/deep/x.log'].map(f => path.join(repo, f));
		expect(await Promise.all(files.map(f => checker.isIgnored(f, repo)))).toEqual([true, false, false, true, true]);
		expect(await checker.isIgnored(path.join(repo, 'b.log'), repo)).toBe(true);
	});

	it('says not ignored outside a repository, and for a path git refuses', async () => {
		expect(await checker.isIgnored(path.join(plain, 'a.log'), plain)).toBe(false);
		expect(await checker.isIgnored(path.join(plain, 'b.log'), plain)).toBe(false);
		// Outside the folder's repository: git ends the process, and the file is checked on its own.
		expect(await checker.isIgnored(path.join(plain, 'c.log'), repo)).toBe(false);
		expect(await checker.isIgnored(path.join(repo, 'd.log'), repo)).toBe(true);
	});
});
