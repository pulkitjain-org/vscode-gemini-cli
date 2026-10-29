/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureOwnTrustRules, foldersTrusted, folderTrustApplies, folderTrustState, isFolderTrusted, readTrustRules, removeTrustRules, setFolderTrust, staleTrustRules, trustedFoldersPath, trustFolder, type TrustRule } from '../../src/acp/trustedFolders';

describe('trustedFoldersPath', () => {
	it('follows the CLI: its own variable, then GEMINI_CLI_HOME, then the home folder', async () => {
		expect(trustedFoldersPath({ GEMINI_CLI_TRUSTED_FOLDERS_PATH: '/x/t.json', GEMINI_CLI_HOME: '/h' }, '/home/u')).toBe('/x/t.json');
		expect(trustedFoldersPath({ GEMINI_CLI_HOME: '/h' }, '/home/u')).toBe(path.join('/h', '.gemini', 'trustedFolders.json'));
		expect(trustedFoldersPath({}, '/home/u')).toBe(path.join('/home/u', '.gemini', 'trustedFolders.json'));
	});
});

describe('trustFolder', () => {
	let dir: string;
	beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-trust-')); });
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('creates the list, owner-only', async () => {
		const file = path.join(dir, '.gemini', 'trustedFolders.json');
		await trustFolder(file, '/work/app');
		expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ [path.resolve('/work/app')]: 'TRUST_FOLDER' });
		if (process.platform !== 'win32') {
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		}
	});

	it('keeps the other entries, including a folder marked not to trust', async () => {
		const file = path.join(dir, 'trustedFolders.json');
		fs.writeFileSync(file, JSON.stringify({ '/other': 'DO_NOT_TRUST', '/work': 'TRUST_PARENT' }));
		await trustFolder(file, '/work/app');
		expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ '/other': 'DO_NOT_TRUST', '/work': 'TRUST_PARENT', [path.resolve('/work/app')]: 'TRUST_FOLDER' });
	});

	it('leaves a file it cannot read as JSON alone', async () => {
		const file = path.join(dir, 'trustedFolders.json');
		fs.writeFileSync(file, '{ // a comment\n "/x": "TRUST_FOLDER" }');
		await expect(trustFolder(file, '/work/app')).rejects.toThrow();
		expect(fs.readFileSync(file, 'utf8')).toContain('a comment');
		expect(fs.readdirSync(dir)).toEqual(['trustedFolders.json']);
	});
});

describe('isFolderTrusted', () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-trust-')));
		file = path.join(dir, 'trustedFolders.json');
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('is undefined, as the CLI treats untrusted, with no list or no covering rule', async () => {
		expect(await isFolderTrusted(file, path.join(dir, 'repo'))).toBeUndefined();
		fs.writeFileSync(file, JSON.stringify({ [path.join(dir, 'other')]: 'TRUST_FOLDER' }));
		expect(await isFolderTrusted(file, path.join(dir, 'repo'))).toBeUndefined();
		expect(await isFolderTrusted(file, path.join(dir, 'other-repo'))).toBeUndefined();
	});

	it('covers a trusted folder, its subfolders, and a TRUST_PARENT rule\'s siblings', async () => {
		fs.writeFileSync(file, JSON.stringify({ [path.join(dir, 'repo')]: 'TRUST_FOLDER', [path.join(dir, 'work', 'a')]: 'TRUST_PARENT' }));
		expect(await isFolderTrusted(file, path.join(dir, 'repo'))).toBe(true);
		expect(await isFolderTrusted(file, path.join(dir, 'repo', 'src'))).toBe(true);
		expect(await isFolderTrusted(file, path.join(dir, 'work', 'b'))).toBe(true);
	});

	it('lets the longest rule win, so DO_NOT_TRUST inside a trusted folder holds', async () => {
		fs.writeFileSync(file, JSON.stringify({ [path.join(dir, 'repo')]: 'TRUST_FOLDER', [path.join(dir, 'repo', 'secret')]: 'DO_NOT_TRUST' }));
		expect(await isFolderTrusted(file, path.join(dir, 'repo', 'secret', 'x'))).toBe(false);
		expect(await isFolderTrusted(file, path.join(dir, 'repo', 'open'))).toBe(true);
	});
});

describe('folderTrustApplies', () => {
	let home: string;
	beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-home-')); });
	afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

	it('applies unless the environment trusts every folder or the settings turn it off', async () => {
		expect(await folderTrustApplies({}, home)).toBe(true);
		expect(await folderTrustApplies({ GEMINI_CLI_TRUST_WORKSPACE: 'true' }, home)).toBe(false);
		fs.mkdirSync(path.join(home, '.gemini'));
		fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), '{\n\t// off\n\t"security": { "folderTrust": { "enabled": false } }\n}');
		expect(await folderTrustApplies({}, home)).toBe(false);
	});
});

describe('foldersTrusted', () => {
	let home: string;
	beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-home-')); });
	afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

	it('is true when every folder is trusted, or when the CLI checks no folder\'s trust', async () => {
		const file = trustedFoldersPath({}, home);
		await trustFolder(file, path.join(home, 'a'));
		expect([
			await foldersTrusted([path.join(home, 'a')], {}, home),
			await foldersTrusted([path.join(home, 'a'), path.join(home, 'b')], {}, home),
			await foldersTrusted([path.join(home, 'b')], { GEMINI_CLI_TRUST_WORKSPACE: 'true' }, home),
		]).toEqual([true, false, true]);
	});
});

describe('setFolderTrust, readTrustRules and GeminiCode\'s own rules', () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-trust-')));
		file = path.join(dir, 'trustedFolders.json');
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('sets each of the CLI\'s levels, removes a rule, and lists the rules the CLI knows in order', async () => {
		fs.writeFileSync(file, JSON.stringify({ '/old': 'TRUST_FOLDER', '/odd': 'MAYBE' }));
		await setFolderTrust(file, '/work/app', 'TRUST_PARENT');
		await setFolderTrust(file, '/work/bad', 'DO_NOT_TRUST');
		await setFolderTrust(file, '/old', undefined);
		expect(await readTrustRules(file)).toEqual([
			{ path: path.resolve('/work/app'), level: 'TRUST_PARENT' },
			{ path: path.resolve('/work/bad'), level: 'DO_NOT_TRUST' },
		]);
	});

	it('says which rule decides: the longest that covers the folder', async () => {
		const repo = path.join(dir, 'work', 'app');
		fs.mkdirSync(repo, { recursive: true });
		await setFolderTrust(file, path.join(dir, 'work'), 'TRUST_FOLDER');
		await setFolderTrust(file, path.join(repo, 'vendor'), 'DO_NOT_TRUST');
		expect([await folderTrustState(file, repo), await folderTrustState(file, path.join(repo, 'vendor', 'x'))]).toEqual([
			{ trusted: true, rule: { path: path.join(dir, 'work'), level: 'TRUST_FOLDER' } },
			{ trusted: false, rule: { path: path.join(repo, 'vendor'), level: 'DO_NOT_TRUST' } },
		]);
	});

	it('trusts the project coordinators\' folder and never the review checkouts, writing only when either is missing', async () => {
		const home = path.join(dir, 'home');
		await setFolderTrust(file, path.join(home, '.geminicode', 'reviews'), 'TRUST_FOLDER');
		const first = await ensureOwnTrustRules(file, home);
		const again = await ensureOwnTrustRules(file, home);
		expect({ first, again, review: await isFolderTrusted(file, path.join(home, '.geminicode', 'reviews', 'shop', 'review-12')), project: await isFolderTrusted(file, path.join(home, '.geminicode', 'projects', 'p1')) })
			.toEqual({ first: true, again: false, review: false, project: true });
	});
});

describe('staleTrustRules and removeTrustRules', () => {
	it('removes the rules of folders that are gone, but not of a drive that is unplugged, a never-trust rule, GeminiCode\'s own, or a trusted repository\'s worktrees', async () => {
		const home = path.resolve('/home/u');
		// ~/.geminicode/worktrees is gone too: GeminiCode's own folders go with the rules for them.
		const there = new Set(['/work', '/work/app', '/work/kept-parent', '/tmp', path.join(home, '.geminicode')].map(each => path.resolve(each)));
		const rules: TrustRule[] = [
			// Gone, in a temporary folder whose own folder is gone too, as a test run leaves it.
			{ path: '/tmp/test-home-1/workspace-2', level: 'TRUST_FOLDER' },
			// Gone, from a folder that is still there.
			{ path: '/work/deleted', level: 'TRUST_FOLDER' },
			{ path: path.join(home, '.geminicode', 'worktrees', 'deleted'), level: 'TRUST_FOLDER' },
			// A TRUST_PARENT rule covers its parent, still there.
			{ path: '/work/kept-parent/gone-child', level: 'TRUST_PARENT' },
			// On a drive that isn't mounted.
			{ path: '/Volumes/Backup/repo', level: 'TRUST_FOLDER' },
			{ path: '/work/gone-never', level: 'DO_NOT_TRUST' },
			{ path: path.join(home, '.geminicode', 'projects'), level: 'TRUST_FOLDER' },
			// A trusted repository and its worktrees folder, which no agent has made yet.
			{ path: '/work/app', level: 'TRUST_FOLDER' },
			{ path: path.join(home, '.geminicode', 'worktrees', 'app'), level: 'TRUST_FOLDER' },
		];
		const stale = await staleTrustRules(rules, { home, temporary: [path.resolve('/tmp')], exists: async folder => there.has(path.resolve(folder)) });
		expect(stale.map(rule => rule.path)).toEqual(['/tmp/test-home-1/workspace-2', '/work/deleted', path.join(home, '.geminicode', 'worktrees', 'deleted')]);

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-trust-'));
		try {
			const file = path.join(dir, 'trustedFolders.json');
			fs.writeFileSync(file, JSON.stringify(Object.fromEntries(rules.map(rule => [rule.path, rule.level]))));
			expect(await removeTrustRules(file, stale.map(rule => rule.path))).toBe(true);
			expect(await removeTrustRules(file, stale.map(rule => rule.path))).toBe(false);
			expect((await readTrustRules(file)).map(rule => rule.path)).toEqual(rules.slice(3).map(rule => rule.path));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
