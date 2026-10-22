/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Ripgrep for the Gemini CLI copies GeminiCode runs. The CLI's grep_search
// looks for `rg` beside its bundle (`bundle/vendor/ripgrep/rg-<platform>-<arch>`,
// where its own release layout puts it) or in a system folder such as
// /opt/homebrew/bin; the npm package ships neither, so on most Macs it falls
// back to `git grep`, three to four times slower on a large repository
// (FINDINGS.md). The app ships ripgrep already, so it is copied there: into
// the bundled copy when it is built (scripts/bundle-cli.mts) and into each
// copy GeminiCode installs when it starts. A CLI the user chose is left alone.
// No CLI file is changed; the binary is only added where the CLI looks.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type RipgrepResult = 'added' | 'present' | 'unavailable';

/** Where the CLI looks for its own ripgrep, relative to its `bundle` folder. */
export function cliRipgrepPath(bundleDir: string, platform: string = process.platform, arch: string = process.arch): string {
	return path.join(bundleDir, 'vendor', 'ripgrep', `rg-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`);
}

/**
 * Copies `source` (the app's ripgrep) to where the CLI whose `bundle` folder
 * is `bundleDir` looks for it, unless a copy of the same size is there.
 * Written beside the target and renamed, so a CLI starting meanwhile never
 * sees half a binary.
 */
export async function provideRipgrep(bundleDir: string, source: string | undefined, platform: string = process.platform, arch: string = process.arch): Promise<RipgrepResult> {
	if (!source) {
		return 'unavailable';
	}
	const sourceStat = await fs.stat(source).catch(() => undefined);
	if (!sourceStat?.isFile()) {
		return 'unavailable';
	}
	const target = cliRipgrepPath(bundleDir, platform, arch);
	const existing = await fs.stat(target).catch(() => undefined);
	if (existing?.size === sourceStat.size) {
		return 'present';
	}
	await fs.mkdir(path.dirname(target), { recursive: true });
	const staging = `${target}.${process.pid}.tmp`;
	try {
		await fs.copyFile(source, staging);
		await fs.chmod(staging, 0o755);
		await fs.rename(staging, target);
	} catch (err) {
		await fs.rm(staging, { force: true });
		throw err;
	}
	return 'added';
}
