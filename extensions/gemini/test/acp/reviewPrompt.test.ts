/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
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

describe('reviewRequest', () => {
	it('asks for a review without edits, attaches the diff and lists new files', () => {
		const request = reviewRequest({ diff: 'diff --git a/a.ts b/a.ts\n-one\n+two\n', untracked: ['b.ts'] });
		expect(request.text).toContain('Do not edit');
		expect(request.text).toContain('- b.ts');
		expect(request.attachments).toEqual([{ kind: 'document', name: 'uncommitted.diff', mimeType: 'text/x-diff', text: 'diff --git a/a.ts b/a.ts\n-one\n+two\n' }]);
	});

	it('cuts a long diff and says how to read the rest', () => {
		const request = reviewRequest({ diff: 'x'.repeat(maxReviewDiff + 10), untracked: [] });
		expect(request.text).toContain('was cut');
		expect(request.attachments[0]).toMatchObject({ text: 'x'.repeat(maxReviewDiff) });
	});

	it('attaches nothing when only new files changed', () => {
		expect(reviewRequest({ diff: '', untracked: ['b.ts'] }).attachments).toEqual([]);
	});
});
