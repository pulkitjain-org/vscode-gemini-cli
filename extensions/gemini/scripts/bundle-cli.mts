/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Puts the Gemini CLI that ships inside GeminiCode in `cli/<version>/`, the
// same layout as the copies installed from the app. The version and its
// SHA-512 are pinned in package.json (`bundledCli`); a download that does not
// match is refused. The checked copy then gets GeminiCode's patch
// (src/acp/cliPatches.ts), which caps tool output in ACP mode; a CLI the patch
// doesn't recognize stops the script, so the app never ships it uncapped. So
// does a CLI that no longer has what GeminiCode reads from it outside ACP
// (src/acp/cli/contract.ts), and, in CI, a missing ripgrep. Run before
// packaging the app:
//
//   node extensions/gemini/scripts/bundle-cli.mts
//
// Nothing is downloaded if the pinned version is already in place.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import './sourceImports.mts';
import { patchCliBundle } from '../src/acp/cliPatches.ts';
import { provideRipgrep } from '../src/acp/cliRipgrep.ts';

// Imported once sourceImports.mts resolves the sources' extensionless imports.
const { checkCliContract } = await import('../src/acp/cli/contract.ts');

const extensionDir = path.dirname(import.meta.dirname);
const cliDir = path.join(extensionDir, 'cli');
const { version, integrity } = JSON.parse(fs.readFileSync(path.join(extensionDir, 'package.json'), 'utf8')).bundledCli as { version: string; integrity: string };
const target = path.join(cliDir, version);
const marker = path.join(target, '.integrity');

/** Patches the bundled copy, and stops the build when the patch no longer fits the CLI. */
async function patch(): Promise<void> {
	const result = await patchCliBundle(path.join(target, 'bundle'));
	if (result === 'unrecognized') {
		throw new Error(`Gemini CLI ${version} no longer has the code src/acp/cliPatches.ts patches: update the patch before bundling this version.`);
	}
	console.log(result === 'patched' ? `Capped tool output in ACP mode for Gemini CLI ${version}.` : `Gemini CLI ${version} is already patched.`);
	// The app's ripgrep, where the CLI looks for its own (src/acp/cliRipgrep.ts); both Mac architectures, since the app is universal.
	const arches = process.platform === 'darwin' ? ['arm64', 'x64'] : [process.arch];
	for (const arch of arches) {
		const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
		const source = path.join(extensionDir, '..', '..', 'node_modules', '@vscode', 'ripgrep-universal', 'bin', `${process.platform}-${arch}`, binary);
		const placed = await provideRipgrep(path.join(target, 'bundle'), source, process.platform, arch);
		if (placed === 'unavailable' && process.env.CI) {
			// A release without it searches three to four times slower; CI installs the root packages, which carry it.
			throw new Error(`No ripgrep for ${process.platform}-${arch} at ${path.relative(process.cwd(), source)}: install the root packages (npm ci) first.`);
		}
		console.log(placed === 'unavailable' ? `No ripgrep for ${process.platform}-${arch} in node_modules; the bundled CLI falls back to git grep there.` : `Ripgrep for ${process.platform}-${arch}: ${placed}.`);
	}
	const mismatches = await checkCliContract(path.join(target, 'bundle', 'gemini.js'));
	if (mismatches.length) {
		throw new Error(`Gemini CLI ${version} no longer has what GeminiCode reads from it (src/acp/cli/formats.ts):\n${mismatches.map(m => `  ${m.check} (${m.area}): ${m.detail}`).join('\n')}\nUpdate src/acp/cli/ for this version before bundling it.`);
	}
	console.log(`Gemini CLI ${version} has everything GeminiCode reads from it outside ACP.`);
}

if (fs.existsSync(path.join(target, 'bundle', 'gemini.js')) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === integrity) {
	console.log(`Gemini CLI ${version} is already bundled.`);
	await patch();
	process.exit(0);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-bundle-'));
try {
	// npm pack uses the user's registry, proxy and cache settings. The pinned
	// checksum, not a release-age rule such as this package's `min-release-age`,
	// decides whether the download is trusted, so a CLI released this week can
	// be pinned. npm's errors go to the console.
	const packed = execFileSync(npm, ['pack', `@google/gemini-cli@${version}`, '--pack-destination', work, '--json', '--min-release-age=0'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
		shell: process.platform === 'win32',
	});
	const tarball = path.join(work, (JSON.parse(packed) as { filename: string }[])[0].filename);
	const actual = `sha512-${createHash('sha512').update(fs.readFileSync(tarball)).digest('base64')}`;
	if (actual !== integrity) {
		throw new Error(`@google/gemini-cli ${version} does not match the pinned checksum.\n  expected ${integrity}\n  got      ${actual}`);
	}

	// Keep what an install from the app keeps, plus the licence and, when the package has one, its NOTICE.
	const listed = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
	const notice = listed.includes('package/NOTICE') ? ['package/NOTICE'] : [];
	execFileSync('tar', ['-xzf', tarball, '-C', work, 'package/bundle', 'package/package.json', 'package/LICENSE', ...notice]);
	const unpacked = path.join(work, 'package');
	if (!fs.existsSync(path.join(unpacked, 'bundle', 'gemini.js'))) {
		throw new Error(`@google/gemini-cli ${version} has no bundle/gemini.js.`);
	}
	fs.writeFileSync(path.join(unpacked, '.integrity'), integrity);

	// Only one bundled version at a time.
	fs.rmSync(cliDir, { recursive: true, force: true });
	fs.mkdirSync(cliDir, { recursive: true });
	fs.renameSync(unpacked, target);
	console.log(`Bundled Gemini CLI ${version} in ${path.relative(process.cwd(), target) || target}.`);
} finally {
	fs.rmSync(work, { recursive: true, force: true });
}
await patch();
