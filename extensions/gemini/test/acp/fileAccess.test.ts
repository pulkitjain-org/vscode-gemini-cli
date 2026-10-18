/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkFileAccess, ClientFileSystem, createFileHandlers, isInside, secretPathReason, sliceLines } from '../../src/acp/fileAccess';

const root = path.resolve('/work/project');
const inRoot = (...parts: string[]) => path.join(root, ...parts);

describe('isInside', () => {
	it('accepts the root and its children, including names starting with ..', () => {
		expect(isInside('/repo', '/repo')).toBe(true);
		expect(isInside('/repo', '/repo/src/a.ts')).toBe(true);
		expect(isInside('/repo', '/repo/..foo')).toBe(true);
	});

	it('rejects parents and siblings', () => {
		expect(isInside('/repo', '/')).toBe(false);
		expect(isInside('/repo', '/repo2/a.ts')).toBe(false);
		expect(isInside('/repo', '/repo/../other')).toBe(false);
	});
});

describe('secretPathReason', () => {
	it.each([
		'.env', '.env.local', '.env.production', 'config/server.pem', 'tls.key', 'id_rsa', 'id_ed25519',
		'.npmrc', '.netrc', 'credentials.json', '.ssh/config', '.aws/config', '.git/config', 'certs/store.p12',
		'deploy/my-project-service-account.json', 'keys/service_account_ci.json', 'application_default_credentials.json', '.kube/config', '.docker/config.json', 'kubeconfig', '.config/gcloud/credentials.db',
	])('treats %s as secret', file => {
		expect(secretPathReason(file)).toBeDefined();
	});

	it.each([
		'.env.example', '.env.sample', 'src/env.ts', 'keys.ts', 'id_rsa.pub', 'docs/credentials.md', 'src/monkey.ts', '.gitignore', '.github/workflows/ci.yml',
		'src/serviceAccounts.ts', 'docs/service-account.md', 'Dockerfile', 'k8s/deployment.yaml',
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

describe('checkFileAccess with symlinks', () => {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-links-')));
	const workspace = path.join(base, 'workspace');
	const outside = path.join(base, 'home');
	fs.mkdirSync(path.join(outside, '.aws'), { recursive: true });
	fs.writeFileSync(path.join(outside, '.aws', 'credentials'), 'secret');
	fs.writeFileSync(path.join(outside, 'notes.txt'), 'notes');
	fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
	fs.mkdirSync(path.join(workspace, 'secrets'), { recursive: true });
	fs.writeFileSync(path.join(workspace, 'secrets', '.env'), 'KEY=1');
	fs.writeFileSync(path.join(workspace, 'real.md'), 'real');
	fs.symlinkSync(path.join(outside, '.aws', 'credentials'), path.join(workspace, 'docs', 'setup.txt'));
	fs.symlinkSync(outside, path.join(workspace, 'linked'));
	fs.symlinkSync(path.join(workspace, 'secrets', '.env'), path.join(workspace, 'env.txt'));
	fs.symlinkSync(path.join(workspace, 'real.md'), path.join(workspace, 'alias.md'));
	afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
	const policy = { roots: [workspace] };

	it('denies a link to a file outside the workspace, for reads and writes', async () => {
		expect(await checkFileAccess(path.join(workspace, 'docs', 'setup.txt'), 'read', policy)).toMatch(/outside the workspace/);
		expect(await checkFileAccess(path.join(workspace, 'docs', 'setup.txt'), 'write', policy)).toMatch(/outside the workspace/);
	});

	it('denies new files in a linked folder that leads out of the workspace', async () => {
		expect(await checkFileAccess(path.join(workspace, 'linked', 'notes.txt'), 'read', policy)).toMatch(/outside the workspace/);
		expect(await checkFileAccess(path.join(workspace, 'linked', 'new', 'file.txt'), 'write', policy)).toMatch(/outside the workspace/);
	});

	it('denies a link to a secret inside the workspace', async () => {
		expect(await checkFileAccess(path.join(workspace, 'env.txt'), 'read', policy)).toMatch(/secrets/);
	});

	it('allows links within the workspace and new files', async () => {
		expect(await checkFileAccess(path.join(workspace, 'alias.md'), 'read', policy)).toBeUndefined();
		expect(await checkFileAccess(path.join(workspace, 'docs', 'new.md'), 'write', policy)).toBeUndefined();
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
