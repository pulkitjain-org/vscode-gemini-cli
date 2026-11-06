/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Installs GeminiCode's own copies of the Gemini CLI: one folder per version
// under the managed folder, taken from the npm registry, or the mirror in
// `gemini.cli.registry`. Only `bundle/` and `package.json` are kept; the CLI's
// optional packages (node-pty, keytar) are left out, and the CLI runs without
// them. The tarball (about 100 MB unpacked) is read as it downloads: each kept
// file is written as soon as it is complete, so the extension host holds one
// file at a time, never the archive, and its checksum is taken from the bytes
// as they pass and checked before the copy is put in place.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { patchCliFile } from './cliPatches';
import { compareVersions, isVersion, listManagedVersions } from './cliResolution';

export const cliPackageName = '@google/gemini-cli';
export const defaultRegistry = 'https://registry.npmjs.org';

/**
 * The registry to install from: `configured` (`gemini.cli.registry`, an
 * organisation's npm mirror) when it is an https address, or plain http on
 * this machine, else the public registry. No trailing slash.
 */
export function cliRegistry(configured: string | undefined): string {
	const value = configured?.trim();
	if (value) {
		try {
			const url = new URL(value);
			const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
			if ((url.protocol === 'https:' || url.protocol === 'http:' && local) && !url.username && !url.password && !url.search && !url.hash) {
				return url.href.replace(/\/+$/, '');
			}
		} catch {
			// Not an address: the public registry.
		}
	}
	return defaultRegistry;
}

/** The parts of `fetch` used here, so tests can pass a fake. */
export type Fetch = (url: string, init?: { readonly headers?: Record<string, string>; readonly signal?: AbortSignal }) => Promise<{
	readonly ok: boolean;
	readonly status: number;
	/** The response as it arrives; a fake without one is read whole with `arrayBuffer`. */
	readonly body?: ReadableStream<Uint8Array> | null;
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
	// Both checked before anything is downloaded.
	const expectedDigest = sha512Of(integrity);
	const download = tarballUrl(tarball, registryOf(options), version);
	if ((await listManagedVersions(options.managedDir)).includes(version)) {
		return version;
	}
	const response = await options.fetch(download, { signal: options.signal });
	if (!response.ok) {
		throw new Error(`Downloading ${cliPackageName} ${version} failed (HTTP ${response.status}).`);
	}

	// Unpack next to the final folder, then rename, so a version folder is never half-written.
	await fs.promises.mkdir(options.managedDir, { recursive: true });
	const staging = await fs.promises.mkdtemp(path.join(options.managedDir, `.tmp-${version}-`));
	try {
		const hash = createHash('sha512');
		const reader = new TarReader(isKept);
		let entryPoint = false;
		const write = async (file: TarFile) => {
			const target = path.join(staging, file.path);
			await fs.promises.mkdir(path.dirname(target), { recursive: true });
			// GeminiCode's cap on tool output in ACP mode (cliPatches.ts) goes in as the file is written.
			await fs.promises.writeFile(target, patchCliFile(file.path, file.data), { mode: file.mode & 0o777 || 0o644 });
			entryPoint ||= file.path === 'bundle/gemini.js';
		};
		await pipeline(
			response.body ? Readable.fromWeb(response.body) : Readable.from([Buffer.from(await response.arrayBuffer())]),
			new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					hash.update(chunk);
					callback(null, chunk);
				},
			}),
			createGunzip(),
			new Writable({
				write(chunk: Buffer, _encoding, callback) {
					let files: TarFile[];
					try {
						files = reader.read(chunk);
					} catch (err) {
						callback(err as Error);
						return;
					}
					(async () => {
						for (const file of files) {
							await write(file);
						}
					})().then(() => callback(), callback);
				},
			}),
		);
		if (hash.digest('base64') !== expectedDigest) {
			throw new Error('The download does not match the registry\'s checksum.');
		}
		if (!entryPoint) {
			throw new Error(`${cliPackageName} ${version} has no bundle/gemini.js.`);
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

/**
 * The address to download `tarball` from, as the registry's manifest gives it:
 * on the registry's own host, over https (or over the registry's own plain
 * http, which `cliRegistry` allows on this machine alone). Anywhere else is
 * refused: a manifest the registry serves must not send the download elsewhere.
 */
export function tarballUrl(tarball: string, registry: string, version: string): string {
	const own = new URL(`${registry}/`);
	let url: URL;
	try {
		url = new URL(tarball);
	} catch {
		throw new Error(`The registry gave no usable download address for ${cliPackageName} ${version}.`);
	}
	const secure = url.protocol === 'https:' || url.protocol === own.protocol;
	if (!secure || url.host !== own.host || url.username || url.password) {
		throw new Error(`The registry points the download of ${cliPackageName} ${version} at ${url.origin}, not at ${own.origin}; the install was refused.`);
	}
	return url.href;
}

/**
 * The installed versions to keep: the copy in use, and a version pinned in
 * `gemini.cli.version`. With the bundled CLI or another in use, none: those
 * copies would only ever be older than what runs. When it is not known which
 * CLI runs, the newest is kept, to be safe.
 */
export function cliCopiesToKeep(installed: readonly string[], inUse: { readonly source: string; readonly version?: string } | undefined, pinned?: string): string[] {
	const keep = new Set<string>();
	if (!inUse) {
		const newest = [...installed].sort(compareVersions).at(-1);
		if (newest) {
			keep.add(newest);
		}
	} else if (inUse.source === 'managed' && inUse.version) {
		keep.add(inUse.version);
	}
	if (pinned && installed.includes(pinned)) {
		keep.add(pinned);
	}
	return [...keep];
}

/**
 * Deletes managed versions other than `keep`, and anything left from an
 * interrupted install. Asynchronous: a CLI copy is thousands of files, which a
 * synchronous delete would remove with the extension host blocked.
 */
export async function pruneCliVersions(managedDir: string, keep: readonly string[]): Promise<string[]> {
	let names: string[];
	try {
		names = await fs.promises.readdir(managedDir);
	} catch {
		return [];
	}
	const removed = names.filter(name => name.startsWith('.tmp-') || (isVersion(name) && !keep.includes(name)));
	await Promise.all(removed.map(name => fs.promises.rm(path.join(managedDir, name), { recursive: true, force: true })));
	return removed;
}

/** The base64 SHA-512 digest an npm `integrity` value (SRI) expects; throws when it has none. */
function sha512Of(integrity: string): string {
	const expected = integrity.split(/\s+/).find(entry => entry.startsWith('sha512-'));
	if (!expected) {
		throw new Error('The registry did not give a SHA-512 checksum for the download.');
	}
	return expected.slice('sha512-'.length);
}

/** Throws unless `data` matches an npm `integrity` value (SRI, sha512). */
export function checkIntegrity(data: Buffer, integrity: string): void {
	if (createHash('sha512').update(data).digest('base64') !== sha512Of(integrity)) {
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
	return new TarReader().read(tar);
}

/** An entry being read: a regular file kept or skipped, or one that names the next entry (pax, GNU long name). */
interface TarEntry {
	readonly kind: 'file' | 'skip' | 'pax' | 'gnu-long';
	readonly path: string;
	readonly mode: number;
	/** Bytes of the body still to come. */
	remaining: number;
	/** Bytes after the body, up to the next 512-byte block. */
	padding: number;
	/** The body so far, for an entry whose body is wanted. */
	readonly chunks: Buffer[];
}

/**
 * Reads an npm package tarball (ustar, with pax and GNU long names) in
 * pieces, as it is downloaded: `read` takes each piece and gives back the
 * regular files completed by it, with their data, so the whole archive is
 * never held. A file `keep` declines is skipped without its body being kept.
 * A path that leaves the package throws, as soon as its header is read.
 */
export class TarReader {

	/** The part of a header not yet complete; bodies are consumed as they come. */
	private leftover: Buffer = Buffer.alloc(0);
	private entry: TarEntry | undefined;
	/** From a pax or GNU long-name entry, for the entry after it. */
	private longName: string | undefined;
	private ended = false;

	constructor(private readonly keep: (file: string) => boolean = () => true) { }

	read(chunk: Buffer): TarFile[] {
		const files: TarFile[] = [];
		if (this.ended) {
			return files;
		}
		const data = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
		let offset = 0;
		for (;;) {
			const entry = this.entry;
			if (entry) {
				const take = Math.min(entry.remaining, data.length - offset);
				if (take > 0 && entry.kind !== 'skip') {
					entry.chunks.push(data.subarray(offset, offset + take));
				}
				entry.remaining -= take;
				offset += take;
				if (entry.remaining > 0) {
					break;
				}
				const skip = Math.min(entry.padding, data.length - offset);
				entry.padding -= skip;
				offset += skip;
				if (entry.padding > 0) {
					break;
				}
				this.entry = undefined;
				const file = this.finish(entry);
				if (file) {
					files.push(file);
				}
				continue;
			}
			if (data.length - offset < 512) {
				break;
			}
			const header = data.subarray(offset, offset + 512);
			offset += 512;
			if (header.every(byte => byte === 0)) {
				this.ended = true;
				break;
			}
			this.entry = this.start(header);
		}
		this.leftover = offset < data.length && !this.ended ? Buffer.from(data.subarray(offset)) : Buffer.alloc(0);
		return files;
	}

	private start(header: Buffer): TarEntry {
		const size = parseOctal(header.subarray(124, 136));
		const type = String.fromCharCode(header[156] || 48);
		const entry = (kind: TarEntry['kind'], name = '', mode = 0): TarEntry => ({ kind, path: name, mode, remaining: size, padding: (512 - size % 512) % 512, chunks: [] });
		if (type === 'x') {
			return entry('pax');
		}
		if (type === 'L') {
			return entry('gnu-long');
		}
		const prefix = readString(header.subarray(345, 500));
		const name = this.longName ?? (prefix ? `${prefix}/${readString(header.subarray(0, 100))}` : readString(header.subarray(0, 100)));
		this.longName = undefined;
		if (type !== '0' && type !== '7') {
			return entry('skip');
		}
		const relative = name.replace(/^[^/]+\//, '');
		const normalized = path.posix.normalize(relative);
		if (!relative || path.posix.isAbsolute(relative) || normalized.startsWith('..') || normalized !== relative) {
			throw new Error(`The package contains an unsafe path: ${name}`);
		}
		return entry(this.keep(relative) ? 'file' : 'skip', relative, parseOctal(header.subarray(100, 108)));
	}

	private finish(entry: TarEntry): TarFile | undefined {
		switch (entry.kind) {
			case 'pax':
				this.longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(Buffer.concat(entry.chunks).toString('utf8'))?.[1] ?? this.longName;
				return undefined;
			case 'gnu-long':
				this.longName = Buffer.concat(entry.chunks).toString('utf8').replace(/\0.*$/s, '');
				return undefined;
			case 'file':
				return { path: entry.path, mode: entry.mode, data: Buffer.concat(entry.chunks) };
			case 'skip':
				return undefined;
		}
	}
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
