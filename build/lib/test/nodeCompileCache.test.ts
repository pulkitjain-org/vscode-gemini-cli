/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, suite, test } from 'node:test';
import { validateNodeCompileCache } from '../nodeCompileCache.ts';

const kinds = ['main', 'extension-host', 'shared-process', 'pty-host', 'agent-host'];

suite('validateNodeCompileCache', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-compile-cache-test-'));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function writeCache(tag: string): void {
		for (const kind of kinds) {
			fs.mkdirSync(path.join(root, kind, tag), { recursive: true });
			fs.writeFileSync(path.join(root, kind, tag, '0123abcd'), '');
			fs.writeFileSync(path.join(root, kind, '.ready'), '');
		}
	}

	test('accepts a tag without a user id', async () => {
		writeCache('v24.22.0-arm64-60e4fe36');
		assert.equal(await validateNodeCompileCache(root, 'arm64'), kinds.length);
	});

	test('accepts a tag that ends with the user id', async () => {
		writeCache('v24.22.0-arm64-60e4fe36-501');
		assert.equal(await validateNodeCompileCache(root, 'arm64'), kinds.length);
	});

	test('removes an entry whose write was interrupted', async () => {
		writeCache('v24.22.0-arm64-60e4fe36-501');
		const interrupted = path.join(root, 'pty-host', 'v24.22.0-arm64-60e4fe36-501', '71f3f0c1.3EEf8I');
		fs.writeFileSync(interrupted, '');
		assert.equal(await validateNodeCompileCache(root, 'arm64'), kinds.length);
		assert.equal(fs.existsSync(interrupted), false);
	});

	test('rejects an unknown cache entry', async () => {
		writeCache('v24.22.0-arm64-60e4fe36-501');
		fs.writeFileSync(path.join(root, 'pty-host', 'v24.22.0-arm64-60e4fe36-501', 'stray'), '');
		await assert.rejects(validateNodeCompileCache(root, 'arm64'), /unexpected pty-host cache entries in .*: stray\./);
	});

	test('rejects a tag for another architecture', async () => {
		writeCache('v24.22.0-x64-60e4fe36-501');
		await assert.rejects(validateNodeCompileCache(root, 'arm64'), /produced 0 arm64 version-tag directories/);
	});
});
