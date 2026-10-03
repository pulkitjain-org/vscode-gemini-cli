/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which Gemini CLI to run. The first of these that has one wins: the
// `gemini.cliPath` setting, the copies installed from GeminiCode (one folder
// per version), the copy bundled with the app, then `gemini` on PATH. Without
// a version set, a bundled copy newer than every installed one wins, so an app
// update is not held back by an older install. An admin pins a path or a
// version by locking those settings through policy, which the workbench
// applies before the extension reads them.

import * as fs from 'node:fs';
import * as path from 'node:path';

export type CliSource = 'setting' | 'managed' | 'bundled' | 'path';

export interface CliResolution {
	/** A path for `resolveAgentCommand`; unset means look up `gemini` on PATH. */
	readonly cliPath: string | undefined;
	readonly source: CliSource;
	/** The version of a managed or bundled copy; other sources report theirs in `initialize`. */
	readonly version?: string;
	/** A version asked for in `gemini.cli.version` that is neither installed nor bundled. */
	readonly missingVersion?: string;
}

export interface ResolveCliOptions {
	/** The `gemini.cliPath` setting. */
	readonly cliPath: string | undefined;
	/** The `gemini.cli.version` setting; empty means the newest managed copy. */
	readonly version: string | undefined;
	/** The folder holding managed copies, `<version>/bundle/gemini.js` each. */
	readonly managedDir: string;
	/** The folder holding the copy shipped with the app, laid out like `managedDir`. */
	readonly bundledDir?: string;
	/** Defaults to the file system; tests pass a fake. */
	readonly listVersions?: (managedDir: string) => readonly string[];
}

export function resolveCli(options: ResolveCliOptions): CliResolution {
	const cliPath = options.cliPath?.trim();
	if (cliPath) {
		return { cliPath, source: 'setting' };
	}
	const wanted = options.version?.trim() || undefined;
	const list = options.listVersions ?? listManagedVersions;
	const installed = list(options.managedDir);
	const bundled = options.bundledDir ? list(options.bundledDir) : [];
	const managed = wanted ? installed.find(v => v === wanted) : newest(installed);
	const shipped = wanted ? bundled.find(v => v === wanted) : newest(bundled);
	const bundledIsNewer = !wanted && !!managed && !!shipped && compareVersions(shipped, managed) > 0;
	if (managed && !bundledIsNewer) {
		return { cliPath: managedEntryPoint(options.managedDir, managed), source: 'managed', version: managed };
	}
	const missing = wanted && !shipped ? { missingVersion: wanted } : {};
	// A pinned version that is missing still runs the bundled copy rather than whatever PATH has.
	const fallback = shipped ?? newest(bundled);
	if (options.bundledDir && fallback) {
		return { cliPath: managedEntryPoint(options.bundledDir, fallback), source: 'bundled', version: fallback, ...missing };
	}
	return { cliPath: undefined, source: 'path', ...missing };
}

export function managedEntryPoint(managedDir: string, version: string): string {
	return path.join(managedDir, version, 'bundle', 'gemini.js');
}

/** Installed versions: folders named like a version that hold an entry point. One directory read, plus a stat per folder. */
export function listManagedVersions(managedDir: string): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(managedDir);
	} catch {
		return [];
	}
	return names.filter(name => parseVersion(name) && fs.existsSync(managedEntryPoint(managedDir, name)));
}

function newest(versions: readonly string[]): string | undefined {
	return [...versions].sort(compareVersions).at(-1);
}

const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function isVersion(value: string): boolean {
	return !!parseVersion(value);
}

function parseVersion(value: string): { readonly parts: readonly number[]; readonly prerelease?: string } | undefined {
	const match = versionPattern.exec(value.trim());
	return match ? { parts: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] } : undefined;
}

/** Orders versions like semver: by number, and a prerelease before its release. Unparseable versions sort first. */
export function compareVersions(a: string, b: string): number {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) {
		return (x ? 1 : 0) - (y ? 1 : 0);
	}
	for (let i = 0; i < 3; i++) {
		if (x.parts[i] !== y.parts[i]) {
			return x.parts[i] - y.parts[i];
		}
	}
	if (x.prerelease === y.prerelease) {
		return 0;
	}
	return x.prerelease === undefined ? 1 : y.prerelease === undefined ? -1 : x.prerelease.localeCompare(y.prerelease, 'en', { numeric: true });
}

/** Whether `version` is known to be older than `minimum`; an unparseable version is not. */
export function isOlderThan(version: string, minimum: string): boolean {
	return isVersion(version) && compareVersions(version, minimum) < 0;
}
