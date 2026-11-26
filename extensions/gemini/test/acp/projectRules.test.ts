/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextFileNamesIn, linkCoordinatorRules, linkThreadRules, ruleEntries } from '../../src/acp/projectRules';

describe('project rules', () => {
	let dir: string;
	let repo: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-rules-'));
		repo = path.join(dir, 'repo');
		fs.mkdirSync(path.join(repo, '.gemini', 'skills'), { recursive: true });
		fs.writeFileSync(path.join(repo, '.gemini', 'settings.json'), '{\n\t// rules\n\t"context": { "fileName": ["CLAUDE.md", "../x.md"] }\n}');
		fs.writeFileSync(path.join(repo, 'GEMINI.md'), '# Rules');
		fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# More rules');
		fs.writeFileSync(path.join(repo, '.gitignore'), '.gemini/\n');
		execFileSync('git', ['init', '-q'], { cwd: repo });
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('reads the context file names settings add, leaving out paths', () => {
		expect(contextFileNamesIn('{"context":{"fileName":"AGENTS.md"}}')).toEqual(['AGENTS.md']);
		expect(contextFileNamesIn('not json')).toEqual([]);
	});

	it('links every rule entry into a coordinator\'s folder, and relinks without touching the source', async () => {
		const entries = await ruleEntries(repo, path.join(dir, 'none.json'));
		expect(entries).toEqual(['.gemini', '.agents', 'GEMINI.md', 'AGENTS.md', 'CLAUDE.md']);
		const home = path.join(dir, 'coordinator');
		expect(await linkCoordinatorRules(repo, home, entries)).toEqual(['.gemini', 'GEMINI.md', 'CLAUDE.md']);
		expect(fs.readFileSync(path.join(home, 'GEMINI.md'), 'utf8')).toBe('# Rules');
		expect(fs.existsSync(path.join(home, '.gemini', 'skills'))).toBe(true);
		fs.rmSync(path.join(repo, 'CLAUDE.md'));
		expect(await linkCoordinatorRules(repo, home, entries)).toEqual(['.gemini', 'GEMINI.md']);
		expect(fs.existsSync(path.join(home, 'CLAUDE.md'))).toBe(false);
		expect(fs.existsSync(path.join(repo, '.gemini', 'skills'))).toBe(true);
		// Skipped now: the earlier link goes, and the folder it pointed to stays.
		expect(await linkCoordinatorRules(repo, home, ['GEMINI.md'], ['.gemini', '.agents'])).toEqual(['GEMINI.md']);
		expect(fs.existsSync(path.join(home, '.gemini'))).toBe(false);
		expect(fs.existsSync(path.join(repo, '.gemini', 'skills'))).toBe(true);
	});

	it('links into a worktree only what the repository ignores and the worktree lacks', async () => {
		const worktree = path.join(dir, 'worktree');
		fs.mkdirSync(worktree);
		fs.writeFileSync(path.join(worktree, 'GEMINI.md'), '# Checked out');
		const entries = await ruleEntries(repo, path.join(dir, 'none.json'));
		expect(await linkThreadRules(repo, worktree, entries)).toEqual(['.gemini']);
		expect(fs.readFileSync(path.join(worktree, 'GEMINI.md'), 'utf8')).toBe('# Checked out');
	});
});
