/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFileAccess, ClientFileSystem, createFileHandlers, secretPathReason, sliceLines } from '../../src/acp/fileAccess';

const root = path.resolve('/work/project');
const inRoot = (...parts: string[]) => path.join(root, ...parts);

describe('secretPathReason', () => {
	it.each([
		'.env', '.env.local', '.env.production', 'config/server.pem', 'tls.key', 'id_rsa', 'id_ed25519',
		'.npmrc', '.netrc', 'credentials.json', '.ssh/config', '.aws/config', '.git/config', 'certs/store.p12',
	])('treats %s as secret', file => {
		expect(secretPathReason(file)).toBeDefined();
	});

	it.each([
		'.env.example', '.env.sample', 'src/env.ts', 'keys.ts', 'id_rsa.pub', 'docs/credentials.md', 'src/monkey.ts', '.gitignore', '.github/workflows/ci.yml',
	])('does not treat %s as secret', file => {
		expect(secretPathReason(file)).toBeUndefined();
	});
});

describe('checkFileAccess', () => {
	const options = { roots: [root], isIgnored: async (p: string) => p.includes('node_modules') };

	it('allows workspace files', async () => {
		expect(await checkFileAccess(inRoot('src', 'a.ts'), 'read', options)).toBeUndefined();
		expect(await checkFileAccess(inRoot('src', 'a.ts'), 'write', options)).toBeUndefined();
	});

	it('denies files outside the workspace and relative paths', async () => {
		expect(await checkFileAccess(path.resolve('/work/other/a.ts'), 'read', options)).toMatch(/outside the workspace/);
		expect(await checkFileAccess(inRoot('..', 'project-other', 'a.ts'), 'read', options)).toMatch(/outside the workspace/);
		expect(await checkFileAccess('src/a.ts', 'read', options)).toMatch(/absolute/);
	});

	it('denies secrets for reads and writes', async () => {
		expect(await checkFileAccess(inRoot('.env'), 'read', options)).toMatch(/secrets/);
		expect(await checkFileAccess(inRoot('.env'), 'write', options)).toMatch(/secrets/);
	});

	it('only checks secrets inside the workspace', async () => {
		const nested = path.resolve('/home/me/.aws/tools');
		expect(await checkFileAccess(path.join(nested, 'a.ts'), 'read', { roots: [nested] })).toBeUndefined();
	});

	it('denies reading git-ignored files but allows writing them', async () => {
		expect(await checkFileAccess(inRoot('node_modules', 'x', 'index.js'), 'read', options)).toMatch(/ignored by git/);
		expect(await checkFileAccess(inRoot('node_modules', 'x', 'index.js'), 'write', options)).toBeUndefined();
	});
});

describe('sliceLines', () => {
	const text = 'one\ntwo\nthree\nfour';
	it('returns everything without line or limit', () => expect(sliceLines(text)).toBe(text));
	it('starts at a 1-based line', () => expect(sliceLines(text, 3)).toBe('three\nfour'));
	it('limits the number of lines', () => expect(sliceLines(text, 2, 2)).toBe('two\nthree'));
	it('limits from the start', () => expect(sliceLines(text, null, 1)).toBe('one'));
});

describe('createFileHandlers', () => {
	function memoryFileSystem(files: Record<string, string>): ClientFileSystem & { files: Record<string, string> } {
		return {
			files,
			async readTextFile(p) { return files[p]; },
			async writeTextFile(p, content) { files[p] = content; },
		};
	}

	it('reads and writes through the host', async () => {
		const fs = memoryFileSystem({ [inRoot('a.ts')]: 'x\ny' });
		const handlers = createFileHandlers(fs, () => ({ roots: [root] }));
		expect(await handlers.readTextFile({ sessionId: 's', path: inRoot('a.ts'), line: 2 })).toEqual({ content: 'y' });
		expect(await handlers.writeTextFile({ sessionId: 's', path: inRoot('b.ts'), content: 'new' })).toEqual({});
		expect(fs.files[inRoot('b.ts')]).toBe('new');
	});

	it('reads a missing file as empty, so the CLI can create it (see the note in fileAccess.ts)', async () => {
		const handlers = createFileHandlers(memoryFileSystem({}), () => ({ roots: [root] }));
		expect(await handlers.readTextFile({ sessionId: 's', path: inRoot('missing.ts') })).toEqual({ content: '' });
	});

	it('refuses denied paths without touching the file system', async () => {
		const fs = memoryFileSystem({ [inRoot('.env')]: 'SECRET=1' });
		const handlers = createFileHandlers(fs, () => ({ roots: [root] }));
		await expect(handlers.readTextFile({ sessionId: 's', path: inRoot('.env') })).rejects.toThrow(/denied/);
		await expect(handlers.writeTextFile({ sessionId: 's', path: inRoot('.env'), content: '' })).rejects.toThrow(/denied/);
		expect(fs.files[inRoot('.env')]).toBe('SECRET=1');
	});
});
