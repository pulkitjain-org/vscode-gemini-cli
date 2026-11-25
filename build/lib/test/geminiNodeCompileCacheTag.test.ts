/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, suite, test } from 'node:test';
import { validateNodeCompileCache } from '../nodeCompileCache.ts';

// The fork's edit to nodeCompileCache.ts: Node on macOS and Linux ends the
// cache's version tag with the user's id, which upstream's pattern rejects.
const kinds = ['main', 'extension-host', 'shared-process', 'pty-host', 'agent-host'];

suite('validateNodeCompileCache, version tags', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-compile-cache-tag-test-'));
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

	test('rejects a tag for another architecture', async () => {
		writeCache('v24.22.0-x64-60e4fe36-501');
		await assert.rejects(validateNodeCompileCache(root, 'arm64'), /produced 0 arm64 version-tag directories/);
	});
});
