/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkIntegrity, Fetch, fetchCliVersions, installCli, pruneCliVersions, readTar } from '../../src/acp/cliInstall';
import { listManagedVersions, resolveCli } from '../../src/acp/cliResolution';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-install-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** An npm-style tarball: everything under `package/`. */
function packTarball(files: Record<string, string>): Buffer {
	const root = path.join(dir, 'src');
	for (const [name, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, 'package', name)), { recursive: true });
		fs.writeFileSync(path.join(root, 'package', name), content);
	}
	const out = path.join(dir, 'package.tgz');
	execFileSync('tar', ['czf', out, '-C', root, 'package']);
	fs.rmSync(root, { recursive: true });
	return fs.readFileSync(out);
}

function integrityOf(data: Buffer): string {
	return `sha512-${createHash('sha512').update(data).digest('base64')}`;
}

/** A registry serving one package version, recording the URLs asked for. */
function fakeRegistry(tarball: Buffer, integrity = integrityOf(tarball), version = '0.62.0') {
	const urls: string[] = [];
	const fetch: Fetch = async url => {
		urls.push(url);
		const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
		if (url === 'https://registry.example/@google%2fgemini-cli') {
			return json({ 'dist-tags': { latest: '0.62.0' }, versions: { '0.61.0': {}, '0.62.0': {}, '0.63.0-preview.1': {}, '0.10.0': {} } });
		}
		if (url === 'https://registry.example/@google%2fgemini-cli/latest' || url === `https://registry.example/@google%2fgemini-cli/${version}`) {
			return json({ version, dist: { tarball: 'https://registry.example/gemini-cli.tgz', integrity } });
		}
		if (url === 'https://registry.example/gemini-cli.tgz') {
			return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new Uint8Array(tarball).buffer };
		}
		return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
	};
	return { fetch, urls, registry: 'https://registry.example/' };
}

describe('installCli', () => {
	it('installs a version that the resolver then picks', async () => {
		const tarball = packTarball({ 'package.json': '{}', 'bundle/gemini.js': 'console.log(1)', 'bundle/chunk.js': 'x', 'README.md': 'docs' });
		const managedDir = path.join(dir, 'managed');
		const version = await installCli({ ...fakeRegistry(tarball), managedDir, version: 'latest' });
		expect(version).toBe('0.62.0');
		expect(fs.readdirSync(path.join(managedDir, '0.62.0')).sort()).toEqual(['bundle', 'package.json']);
		expect(fs.readFileSync(path.join(managedDir, '0.62.0', 'bundle', 'chunk.js'), 'utf8')).toBe('x');
		expect(resolveCli({ cliPath: undefined, version: undefined, managedDir })).toMatchObject({ source: 'managed', version: '0.62.0' });
	});

	it('does not download a version that is already installed', async () => {
		const tarball = packTarball({ 'package.json': '{}', 'bundle/gemini.js': '' });
		const managedDir = path.join(dir, 'managed');
		await installCli({ ...fakeRegistry(tarball), managedDir, version: '0.62.0' });
		const registry = fakeRegistry(tarball);
		await installCli({ ...registry, managedDir, version: '0.62.0' });
		expect(registry.urls).not.toContain('https://registry.example/gemini-cli.tgz');
	});

	it('rejects a download that does not match the checksum, leaving nothing behind', async () => {
		const tarball = packTarball({ 'package.json': '{}', 'bundle/gemini.js': '' });
		const managedDir = path.join(dir, 'managed');
		await expect(installCli({ ...fakeRegistry(tarball, integrityOf(Buffer.from('other'))), managedDir, version: 'latest' })).rejects.toThrow(/checksum/);
		expect(fs.existsSync(managedDir) ? fs.readdirSync(managedDir) : []).toEqual([]);
	});

	it('rejects a package without the CLI entry point', async () => {
		const tarball = packTarball({ 'package.json': '{}', 'bundle/other.js': '' });
		await expect(installCli({ ...fakeRegistry(tarball), managedDir: path.join(dir, 'managed'), version: 'latest' })).rejects.toThrow(/gemini\.js/);
	});

	it('reports a version the registry does not have', async () => {
		const tarball = packTarball({ 'package.json': '{}', 'bundle/gemini.js': '' });
		await expect(installCli({ ...fakeRegistry(tarball), managedDir: path.join(dir, 'managed'), version: '9.9.9' })).rejects.toThrow(/no @google\/gemini-cli/);
	});
});

describe('fetchCliVersions', () => {
	it('lists releases newest first, without prereleases', async () => {
		const result = await fetchCliVersions(fakeRegistry(Buffer.alloc(0)));
		expect(result).toEqual({ versions: ['0.62.0', '0.61.0', '0.10.0'], latest: '0.62.0' });
	});
});

describe('readTar', () => {
	it('reads long paths and strips the package folder', () => {
		const long = `bundle/${'a'.repeat(120)}/file.js`;
		const tarball = packTarball({ 'package.json': '{}', [long]: 'deep' });
		const files = readTar(execFileSync('gzip', ['-dc', path.join(dir, 'package.tgz')]));
		expect(files.map(f => f.path).sort()).toEqual([long, 'package.json'].sort());
		expect(tarball.length).toBeGreaterThan(0);
	});

	it('rejects a path that leaves the package', () => {
		const header = Buffer.alloc(512);
		header.write('package/../../evil.js', 0);
		header.write('0000644\0', 100);
		header.write('00000000000\0', 124);
		header.write('0', 156);
		expect(() => readTar(Buffer.concat([header, Buffer.alloc(1024)]))).toThrow(/unsafe path/);
	});
});

describe('checkIntegrity', () => {
	it('accepts a matching SHA-512 and rejects anything else', () => {
		const data = Buffer.from('hello');
		expect(() => checkIntegrity(data, `sha1-abc ${integrityOf(data)}`)).not.toThrow();
		expect(() => checkIntegrity(data, 'sha1-abc')).toThrow(/SHA-512/);
	});
});

describe('pruneCliVersions', () => {
	it('keeps the given versions and removes the rest and leftovers', () => {
		for (const name of ['0.60.0', '0.61.0', '0.62.0', '.tmp-0.63.0-abc', 'notes']) {
			fs.mkdirSync(path.join(dir, name, 'bundle'), { recursive: true });
			fs.writeFileSync(path.join(dir, name, 'bundle', 'gemini.js'), '');
		}
		expect(pruneCliVersions(dir, ['0.62.0', '0.61.0']).sort()).toEqual(['.tmp-0.63.0-abc', '0.60.0']);
		expect(listManagedVersions(dir).sort()).toEqual(['0.61.0', '0.62.0']);
		expect(fs.existsSync(path.join(dir, 'notes'))).toBe(true);
	});
});
