/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { maxReviewDiff, reviewRequest, workingChanges } from '../../src/acp/reviewPrompt';

let repo: string;

beforeEach(async () => {
	repo = await fs.mkdtemp(path.join(os.tmpdir(), 'review-'));
	const run = (...args: string[]) => execFileSync('git', args, { cwd: repo });
	run('init', '-q', '-b', 'main');
	run('config', 'user.email', 't@example.com');
	run('config', 'user.name', 'T');
	await fs.writeFile(path.join(repo, 'a.ts'), 'one\n');
	run('add', '.');
	run('commit', '-q', '-m', 'first');
});

afterEach(() => fs.rm(repo, { recursive: true, force: true }));

describe('workingChanges', () => {
	it('reads staged and unstaged changes and new files', async () => {
		await fs.writeFile(path.join(repo, 'a.ts'), 'two\n');
		await fs.writeFile(path.join(repo, 'b.ts'), 'new\n');
		const changes = await workingChanges(repo);
		expect(changes.diff).toContain('-one');
		expect(changes.diff).toContain('+two');
		expect(changes.untracked).toEqual(['b.ts']);
	});
});

describe('workingChanges with a huge diff', () => {
	it('stops reading a little past the cut and names the changed files, rather than holding the whole diff', async () => {
		await fs.writeFile(path.join(repo, 'a.ts'), 'two\n');
		await fs.writeFile(path.join(repo, 'big.ts'), Array.from({ length: 60_000 }, (_, i) => `export const line${i} = ${i};`).join('\n'));
		execFileSync('git', ['add', 'big.ts'], { cwd: repo });
		const changes = await workingChanges(repo);
		expect(changes.diff.length).toBeGreaterThan(maxReviewDiff);
		expect(changes.diff.length).toBeLessThan(maxReviewDiff * 4);
		expect(changes.files).toEqual(['a.ts', 'big.ts']);
	});
});

describe('reviewRequest', () => {
	it('asks for a review without edits, attaches the diff and lists new files', () => {
		const request = reviewRequest({ diff: 'diff --git a/a.ts b/a.ts\n-one\n+two\n', untracked: ['b.ts'] });
		expect(request.text).toContain('Do not edit');
		expect(request.text).toContain('- b.ts');
		expect(request.attachments).toEqual([{ kind: 'document', name: 'uncommitted.diff', mimeType: 'text/x-diff', text: 'diff --git a/a.ts b/a.ts\n-one\n+two\n' }]);
	});

	it('cuts a long diff and has the rest read a file at a time, never whole', () => {
		const request = reviewRequest({ diff: 'x'.repeat(maxReviewDiff + 10), untracked: [], files: ['a.ts', 'big.ts'] });
		expect(request.text).toContain('was cut');
		expect(request.text).toContain('`git diff HEAD -- <file>`');
		expect(request.text).toContain('The changed files:\n- a.ts\n- big.ts');
		expect(request.text).not.toMatch(/Run `git diff HEAD`/);
		expect(request.attachments[0]).toMatchObject({ text: 'x'.repeat(maxReviewDiff) });
	});

	it('attaches nothing when only new files changed', () => {
		expect(reviewRequest({ diff: '', untracked: ['b.ts'] }).attachments).toEqual([]);
	});
});
