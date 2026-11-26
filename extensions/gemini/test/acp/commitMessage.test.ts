/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffAgainstHead, newFileDiff, writeCommitMessage } from '../../src/acp/commitMessage';

/** A repository with one commit of `a.ts` and `src/b.ts`. */
function committedRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), 'commit-message-'));
	const run = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
	run('init', '-q', '-b', 'main');
	run('config', 'user.email', 't@example.com');
	run('config', 'user.name', 'T');
	mkdirSync(path.join(root, 'src'));
	writeFileSync(path.join(root, 'a.ts'), 'one\n');
	writeFileSync(path.join(root, 'src', 'b.ts'), 'two\n');
	run('add', '.');
	run('commit', '-q', '-m', 'Add the first files');
	return root;
}

describe('diffAgainstHead', () => {
	it('diffs the given files, new ones included, or all of the folder\'s work', async () => {
		const root = committedRepo();
		writeFileSync(path.join(root, 'a.ts'), 'one!\n');
		writeFileSync(path.join(root, 'src', 'b.ts'), 'two!\n');
		writeFileSync(path.join(root, 'src', 'c.ts'), 'three\n');
		const some = await diffAgainstHead(root, [path.join(root, 'a.ts'), path.join(root, 'src', 'c.ts')]);
		expect([...some.matchAll(/^diff --git a\/(.+?) b\//gm)].map(m => m[1])).toEqual(['a.ts', 'src/c.ts']);
		expect(some).toContain('+three');
		const all = await diffAgainstHead(root);
		expect([...all.matchAll(/^diff --git a\/(.+?) b\//gm)].map(m => m[1])).toEqual(['a.ts', 'src/b.ts', 'src/c.ts']);
		expect(await diffAgainstHead(root, [path.join(tmpdir(), 'elsewhere.ts')])).toBe('');
	});

	it('writes a new file as git diff does', () => {
		expect(newFileDiff('x.ts', 'a\nb\n')).toBe('diff --git a/x.ts b/x.ts\nnew file mode 100644\n--- /dev/null\n+++ b/x.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n');
	});
});

describe('writeCommitMessage', () => {
	it('asks the quick model with the diff and recent subjects, and cleans its answer', async () => {
		const root = committedRepo();
		writeFileSync(path.join(root, 'a.ts'), 'one!\n');
		const asked: string[] = [];
		const message = await writeCommitMessage(root, [path.join(root, 'a.ts')], async request => {
			asked.push(request.prompt);
			return '```\nEmphasise one\n```';
		});
		expect(message).toBe('Emphasise one');
		expect(asked[0]).toContain('- Add the first files');
		expect(asked[0]).toContain('+one!');
	});

	it('gives nothing when there is no writer, nothing changed, or the request fails', async () => {
		const root = committedRepo();
		writeFileSync(path.join(root, 'a.ts'), 'one!\n');
		expect(await writeCommitMessage(root, [path.join(root, 'a.ts')], undefined)).toBeUndefined();
		expect(await writeCommitMessage(root, [path.join(root, 'src', 'b.ts')], async () => 'Unused')).toBeUndefined();
		expect(await writeCommitMessage(root, undefined, async () => { throw new Error('quota'); })).toBeUndefined();
		expect(await writeCommitMessage(root, undefined, async () => undefined)).toBeUndefined();
	});
});
