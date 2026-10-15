/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { folderTrustApplies, isFolderTrusted, trustedFoldersPath, trustFolder } from '../../src/acp/trustedFolders';

describe('trustedFoldersPath', () => {
	it('follows the CLI: its own variable, then GEMINI_CLI_HOME, then the home folder', () => {
		expect(trustedFoldersPath({ GEMINI_CLI_TRUSTED_FOLDERS_PATH: '/x/t.json', GEMINI_CLI_HOME: '/h' }, '/home/u')).toBe('/x/t.json');
		expect(trustedFoldersPath({ GEMINI_CLI_HOME: '/h' }, '/home/u')).toBe(path.join('/h', '.gemini', 'trustedFolders.json'));
		expect(trustedFoldersPath({}, '/home/u')).toBe(path.join('/home/u', '.gemini', 'trustedFolders.json'));
	});
});

describe('trustFolder', () => {
	let dir: string;
	beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-trust-')); });
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('creates the list, owner-only', () => {
		const file = path.join(dir, '.gemini', 'trustedFolders.json');
		trustFolder(file, '/work/app');
		expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ [path.resolve('/work/app')]: 'TRUST_FOLDER' });
		if (process.platform !== 'win32') {
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		}
	});

	it('keeps the other entries, including a folder marked not to trust', () => {
		const file = path.join(dir, 'trustedFolders.json');
		fs.writeFileSync(file, JSON.stringify({ '/other': 'DO_NOT_TRUST', '/work': 'TRUST_PARENT' }));
		trustFolder(file, '/work/app');
		expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ '/other': 'DO_NOT_TRUST', '/work': 'TRUST_PARENT', [path.resolve('/work/app')]: 'TRUST_FOLDER' });
	});

	it('leaves a file it cannot read as JSON alone', () => {
		const file = path.join(dir, 'trustedFolders.json');
		fs.writeFileSync(file, '{ // a comment\n "/x": "TRUST_FOLDER" }');
		expect(() => trustFolder(file, '/work/app')).toThrow();
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

	it('is undefined, as the CLI treats untrusted, with no list or no covering rule', () => {
		expect(isFolderTrusted(file, path.join(dir, 'repo'))).toBeUndefined();
		fs.writeFileSync(file, JSON.stringify({ [path.join(dir, 'other')]: 'TRUST_FOLDER' }));
		expect(isFolderTrusted(file, path.join(dir, 'repo'))).toBeUndefined();
		expect(isFolderTrusted(file, path.join(dir, 'other-repo'))).toBeUndefined();
	});

	it('covers a trusted folder, its subfolders, and a TRUST_PARENT rule\'s siblings', () => {
		fs.writeFileSync(file, JSON.stringify({ [path.join(dir, 'repo')]: 'TRUST_FOLDER', [path.join(dir, 'work', 'a')]: 'TRUST_PARENT' }));
		expect(isFolderTrusted(file, path.join(dir, 'repo'))).toBe(true);
		expect(isFolderTrusted(file, path.join(dir, 'repo', 'src'))).toBe(true);
		expect(isFolderTrusted(file, path.join(dir, 'work', 'b'))).toBe(true);
	});

	it('lets the longest rule win, so DO_NOT_TRUST inside a trusted folder holds', () => {
		fs.writeFileSync(file, JSON.stringify({ [path.join(dir, 'repo')]: 'TRUST_FOLDER', [path.join(dir, 'repo', 'secret')]: 'DO_NOT_TRUST' }));
		expect(isFolderTrusted(file, path.join(dir, 'repo', 'secret', 'x'))).toBe(false);
		expect(isFolderTrusted(file, path.join(dir, 'repo', 'open'))).toBe(true);
	});
});

describe('folderTrustApplies', () => {
	let home: string;
	beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-home-')); });
	afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

	it('applies unless the environment trusts every folder or the settings turn it off', () => {
		expect(folderTrustApplies({}, home)).toBe(true);
		expect(folderTrustApplies({ GEMINI_CLI_TRUST_WORKSPACE: 'true' }, home)).toBe(false);
		fs.mkdirSync(path.join(home, '.gemini'));
		fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), '{\n\t// off\n\t"security": { "folderTrust": { "enabled": false } }\n}');
		expect(folderTrustApplies({}, home)).toBe(false);
	});
});
