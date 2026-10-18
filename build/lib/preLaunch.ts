/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const rootDir = path.resolve(import.meta.dirname, '..', '..');

function runProcess(command: string, args: ReadonlyArray<string> = []) {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { cwd: rootDir, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
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
		await runProcess(npm, ['ci']);
	}
}

async function getElectron() {
	const { shouldDownloadElectron } = await import('./electronVersion.ts');
	// GEMINI-FORK: the dev app also keeps the icons it was built with, so a rebrand needs a fresh copy too.
	const branding = await brandingStamp();
	const rebranded = process.env['VSCODE_SKIP_PRELAUNCH'] !== '1' && await readBrandingStamp() !== branding;
	if (shouldDownloadElectron(rootDir) || rebranded) {
		await runProcess(npm, ['run', 'electron']);
		await fs.writeFile(path.join(rootDir, '.build', 'electron', brandingStampFile), branding);
	}
}

// GEMINI-FORK: what `npm run electron` copies into the dev app: names from product.json and the app icons.
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
		await runProcess(npm, ['run', 'compile']);
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
