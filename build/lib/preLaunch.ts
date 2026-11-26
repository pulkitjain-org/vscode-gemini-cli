/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { getPnpmCommand } from './pnpm.ts';
import { createHash } from 'crypto';

const rootDir = path.resolve(import.meta.dirname, '..', '..');

function runPnpm(args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env) {
	const pnpm = getPnpmCommand();
	return new Promise<void>((resolve, reject) => {
		const child = spawn(pnpm.command, [...pnpm.args, ...args], { cwd: rootDir, stdio: 'inherit', env, shell: pnpm.shell });
		child.on('exit', err => !err ? resolve() : process.exit(err ?? 1));
		child.on('error', reject);
	});
}

async function exists(subdir: string) {
	try {
		await fs.stat(path.join(rootDir, subdir));
		return true;
	} catch {
		return false;
	}
}

async function ensureNodeModules() {
	if (!(await exists('node_modules'))) {
		// pnpm doesn't pass --frozen-lockfile on to the installs of the separate install roots that
		// the postinstall runs; the environment variable reaches them.
		await runPnpm(['install', '--frozen-lockfile'], { ...process.env, PNPM_CONFIG_FROZEN_LOCKFILE: 'true' });
	}
}

async function getElectron() {
	const { shouldDownloadElectron } = await import('./electronVersion.ts');
	// GEMINI-FORK: the dev app also keeps the icons it was built with, so a rebrand needs a fresh copy too.
	const branding = await brandingStamp();
	const rebranded = process.env['VSCODE_SKIP_PRELAUNCH'] !== '1' && await readBrandingStamp() !== branding;
	if (shouldDownloadElectron(rootDir) || rebranded) {
		await runPnpm(['run', 'electron']);
		await fs.writeFile(path.join(rootDir, '.build', 'electron', brandingStampFile), branding);
	}
}

// GEMINI-FORK: what `pnpm run electron` copies into the dev app: names from product.json and the app icons.
const brandingStampFile = 'branding';
const brandingFiles = ['product.json', 'resources/darwin/code.icns', 'resources/win32/code.ico'];

async function brandingStamp(): Promise<string> {
	const hash = createHash('sha256');
	for (const file of brandingFiles) {
		hash.update(await fs.readFile(path.join(rootDir, file)));
	}
	return hash.digest('hex');
}

async function readBrandingStamp(): Promise<string | undefined> {
	try {
		return (await fs.readFile(path.join(rootDir, '.build', 'electron', brandingStampFile), 'utf8')).trim();
	} catch {
		return undefined;
	}
}

async function ensureCompiled() {
	if (!(await exists('out'))) {
		await runPnpm(['run', 'compile']);
	}
}

async function main() {
	await ensureNodeModules();
	await getElectron();
	await ensureCompiled();

	// Can't require this until after dependencies are installed
	const { getBuiltInExtensions } = await import('./builtInExtensions.ts');
	await getBuiltInExtensions();
}

if (import.meta.main) {
	main().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
