/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Installs GeminiCode's own copies of the Gemini CLI: one folder per version
// under the managed folder, taken from the npm registry. Only `bundle/` and
// `package.json` are kept; the CLI's optional packages (node-pty, keytar)
// are left out, and the CLI runs without them.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { compareVersions, isVersion, listManagedVersions } from './cliResolution';

export const cliPackageName = '@google/gemini-cli';
export const defaultRegistry = 'https://registry.npmjs.org';

/** The parts of `fetch` used here, so tests can pass a fake. */
export type Fetch = (url: string, init?: { readonly headers?: Record<string, string>; readonly signal?: AbortSignal }) => Promise<{
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
	arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface RegistryOptions {
	readonly fetch: Fetch;
	/** Without a trailing slash; defaults to the public npm registry. */
	readonly registry?: string;
	readonly signal?: AbortSignal;
}

export interface CliVersions {
	/** Release versions, newest first; prereleases are left out. */
	readonly versions: readonly string[];
	readonly latest: string | undefined;
}

/** The CLI's released versions, from the registry's short package document. */
export async function fetchCliVersions(options: RegistryOptions): Promise<CliVersions> {
	const doc = await getJson(options, `${registryOf(options)}/${encodePackage(cliPackageName)}`, { accept: 'application/vnd.npm.install-v1+json' }) as {
		readonly versions?: Record<string, unknown>;
		readonly 'dist-tags'?: Record<string, unknown>;
	};
	const versions = Object.keys(doc.versions ?? {}).filter(v => isVersion(v) && !v.includes('-')).sort(compareVersions).reverse();
	const latest = doc['dist-tags']?.latest;
	return { versions, latest: typeof latest === 'string' && isVersion(latest) ? latest : versions[0] };
}

export interface InstallOptions extends RegistryOptions {
	readonly managedDir: string;
	/** A version, or `latest`. */
	readonly version: string;
}

/** Downloads, checks and unpacks a CLI version into the managed folder. Resolves with the version installed. */
export async function installCli(options: InstallOptions): Promise<string> {
	const manifest = await getJson(options, `${registryOf(options)}/${encodePackage(cliPackageName)}/${encodeURIComponent(options.version)}`) as {
		readonly version?: unknown;
		readonly dist?: { readonly tarball?: unknown; readonly integrity?: unknown };
	};
	const version = manifest.version;
	const tarball = manifest.dist?.tarball;
	const integrity = manifest.dist?.integrity;
	if (typeof version !== 'string' || !isVersion(version) || typeof tarball !== 'string' || typeof integrity !== 'string') {
		throw new Error(`The registry has no usable ${cliPackageName} ${options.version}.`);
	}
	if (listManagedVersions(options.managedDir).includes(version)) {
		return version;
	}
	const response = await options.fetch(tarball, { signal: options.signal });
	if (!response.ok) {
		throw new Error(`Downloading ${cliPackageName} ${version} failed (HTTP ${response.status}).`);
	}
	const archive = Buffer.from(await response.arrayBuffer());
	checkIntegrity(archive, integrity);
	// Async, so the ~100 MB unpack runs off the extension host's thread.
	const files = readTar(await promisify(gunzip)(archive)).filter(file => isKept(file.path));
	if (!files.some(file => file.path === 'bundle/gemini.js')) {
		throw new Error(`${cliPackageName} ${version} has no bundle/gemini.js.`);
	}

	// Unpack next to the final folder, then rename, so a version folder is never half-written.
	await fs.promises.mkdir(options.managedDir, { recursive: true });
	const staging = await fs.promises.mkdtemp(path.join(options.managedDir, `.tmp-${version}-`));
	try {
		for (const file of files) {
			const target = path.join(staging, file.path);
			await fs.promises.mkdir(path.dirname(target), { recursive: true });
			await fs.promises.writeFile(target, file.data, { mode: file.mode & 0o777 || 0o644 });
		}
		const final = path.join(options.managedDir, version);
		await fs.promises.rm(final, { recursive: true, force: true });
		await fs.promises.rename(staging, final);
	} catch (err) {
		await fs.promises.rm(staging, { recursive: true, force: true });
		throw err;
	}
	return version;
}

/** Deletes managed versions other than `keep`, and anything left from an interrupted install. */
export function pruneCliVersions(managedDir: string, keep: readonly string[]): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(managedDir);
	} catch {
		return [];
	}
	const removed = names.filter(name => name.startsWith('.tmp-') || (isVersion(name) && !keep.includes(name)));
	for (const name of removed) {
		fs.rmSync(path.join(managedDir, name), { recursive: true, force: true });
	}
	return removed;
}

/** Throws unless `data` matches an npm `integrity` value (SRI, sha512). */
export function checkIntegrity(data: Buffer, integrity: string): void {
	const expected = integrity.split(/\s+/).find(entry => entry.startsWith('sha512-'));
	if (!expected) {
		throw new Error('The registry did not give a SHA-512 checksum for the download.');
	}
	const actual = `sha512-${createHash('sha512').update(data).digest('base64')}`;
	if (actual !== expected) {
		throw new Error('The download does not match the registry\'s checksum.');
	}
}

export interface TarFile {
	/** Relative to the package root (npm's `package/` prefix removed). */
	readonly path: string;
	readonly mode: number;
	readonly data: Buffer;
}

/** The regular files in an npm package tarball (ustar, with pax and GNU long names). Rejects paths that leave the package. */
export function readTar(tar: Buffer): TarFile[] {
	const files: TarFile[] = [];
	let offset = 0;
	let longName: string | undefined;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) {
			break;
		}
		const size = parseOctal(header.subarray(124, 136));
		const type = String.fromCharCode(header[156] || 48);
		const body = tar.subarray(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;
		if (type === 'x') {
			longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? longName;
			continue;
		}
		if (type === 'L') {
			longName = body.toString('utf8').replace(/\0.*$/s, '');
			continue;
		}
		const prefix = readString(header.subarray(345, 500));
		const name = longName ?? (prefix ? `${prefix}/${readString(header.subarray(0, 100))}` : readString(header.subarray(0, 100)));
		longName = undefined;
		if (type !== '0' && type !== '7') {
			continue;
		}
		const relative = name.replace(/^[^/]+\//, '');
		const normalized = path.posix.normalize(relative);
		if (!relative || path.posix.isAbsolute(relative) || normalized.startsWith('..') || normalized !== relative) {
			throw new Error(`The package contains an unsafe path: ${name}`);
		}
		files.push({ path: relative, mode: parseOctal(header.subarray(100, 108)), data: Buffer.from(body) });
	}
	return files;
}

function isKept(file: string): boolean {
	return file === 'package.json' || file.startsWith('bundle/');
}

function parseOctal(field: Buffer): number {
	const text = readString(field).trim();
	return text ? parseInt(text, 8) : 0;
}

function readString(field: Buffer): string {
	const end = field.indexOf(0);
	return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function registryOf(options: RegistryOptions): string {
	return (options.registry ?? defaultRegistry).replace(/\/+$/, '');
}

function encodePackage(name: string): string {
	return name.replace('/', '%2f');
}

async function getJson(options: RegistryOptions, url: string, headers: Record<string, string> = {}): Promise<unknown> {
	const response = await options.fetch(url, { headers: { accept: 'application/json', ...headers }, signal: options.signal });
	if (!response.ok) {
		throw new Error(response.status === 404 ? `The registry has no ${cliPackageName} matching that version.` : `The npm registry answered HTTP ${response.status}.`);
	}
	return response.json();
}
