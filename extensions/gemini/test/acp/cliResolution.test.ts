/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareVersions, isOlderThan, listManagedVersions, managedEntryPoint, resolveCli } from '../../src/acp/cliResolution';

const managedDir = '/data/gemini-cli';

describe('resolveCli', () => {
	it('uses the cliPath setting first', () => {
		expect(resolveCli({ cliPath: ' /opt/gemini ', version: '0.62.0', managedDir, listVersions: () => ['0.62.0'] }))
			.toEqual({ cliPath: '/opt/gemini', source: 'setting' });
	});

	it('uses the newest managed copy when no version is set', () => {
		expect(resolveCli({ cliPath: '', version: '', managedDir, listVersions: () => ['0.9.0', '0.62.0', '0.62.0-preview.1', '0.10.1'] }))
			.toEqual({ cliPath: managedEntryPoint(managedDir, '0.62.0'), source: 'managed', version: '0.62.0' });
	});

	it('uses the managed copy of the version set', () => {
		expect(resolveCli({ cliPath: undefined, version: '0.61.0', managedDir, listVersions: () => ['0.61.0', '0.62.0'] }))
			.toEqual({ cliPath: managedEntryPoint(managedDir, '0.61.0'), source: 'managed', version: '0.61.0' });
	});

	it('falls back to PATH and reports a version set but not installed', () => {
		expect(resolveCli({ cliPath: undefined, version: '0.63.0', managedDir, listVersions: () => ['0.62.0'] }))
			.toEqual({ cliPath: undefined, source: 'path', missingVersion: '0.63.0' });
	});

	it('falls back to PATH when nothing is installed', () => {
		expect(resolveCli({ cliPath: undefined, version: undefined, managedDir, listVersions: () => [] }))
			.toEqual({ cliPath: undefined, source: 'path' });
	});
});

describe('listManagedVersions', () => {
	let dir: string | undefined;
	afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

	it('lists version folders that hold an entry point', () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-'));
		for (const name of ['0.61.0', '0.62.0', 'notes']) {
			fs.mkdirSync(path.join(dir, name, 'bundle'), { recursive: true });
			fs.writeFileSync(path.join(dir, name, 'bundle', 'gemini.js'), '');
		}
		// A half-copied version has no entry point yet.
		fs.mkdirSync(path.join(dir, '0.63.0'));
		expect(listManagedVersions(dir).sort()).toEqual(['0.61.0', '0.62.0']);
	});

	it('returns nothing for a missing folder', () => {
		expect(listManagedVersions(path.join(os.tmpdir(), 'gemini-cli-missing-folder'))).toEqual([]);
	});
});

describe('compareVersions', () => {
	it('orders by number, with a prerelease before its release', () => {
		const sorted = ['0.62.0', '0.10.0', '0.62.0-preview.10', '0.62.0-preview.2', '1.0.0', '0.9.9'].sort(compareVersions);
		expect(sorted).toEqual(['0.9.9', '0.10.0', '0.62.0-preview.2', '0.62.0-preview.10', '0.62.0', '1.0.0']);
	});

	it('tells whether a version is older than a minimum', () => {
		expect(isOlderThan('0.60.3', '0.61.0')).toBe(true);
		expect(isOlderThan('0.61.0', '0.61.0')).toBe(false);
		expect(isOlderThan('0.61.0-nightly.1', '0.61.0')).toBe(true);
		expect(isOlderThan('dev', '0.61.0')).toBe(false);
	});
});
