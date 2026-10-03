/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Puts the Gemini CLI that ships inside GeminiCode in `cli/<version>/`, the
// same layout as the copies installed from the app. The version and its
// SHA-512 are pinned in package.json (`bundledCli`); a download that does not
// match is refused. Run before packaging the app:
//
//   node extensions/gemini/scripts/bundle-cli.mts
//
// Nothing runs if the pinned version is already in place.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const extensionDir = path.dirname(import.meta.dirname);
const cliDir = path.join(extensionDir, 'cli');
const { version, integrity } = JSON.parse(fs.readFileSync(path.join(extensionDir, 'package.json'), 'utf8')).bundledCli as { version: string; integrity: string };
const target = path.join(cliDir, version);
const marker = path.join(target, '.integrity');

if (fs.existsSync(path.join(target, 'bundle', 'gemini.js')) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === integrity) {
	console.log(`Gemini CLI ${version} is already bundled.`);
	process.exit(0);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-bundle-'));
try {
	// npm pack uses the user's registry, proxy and cache settings.
	const tarballName = execFileSync(npm, ['pack', `@google/gemini-cli@${version}`, '--pack-destination', work, '--silent'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim().split('\n').at(-1)!;
	const tarball = path.join(work, tarballName);
	const actual = `sha512-${createHash('sha512').update(fs.readFileSync(tarball)).digest('base64')}`;
	if (actual !== integrity) {
		throw new Error(`@google/gemini-cli ${version} does not match the pinned checksum.\n  expected ${integrity}\n  got      ${actual}`);
	}

	// Keep what an install from the app keeps, plus the licence.
	execFileSync('tar', ['-xzf', tarball, '-C', work, 'package/bundle', 'package/package.json', 'package/LICENSE']);
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
