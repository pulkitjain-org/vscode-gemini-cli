/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cliRipgrepPath, provideRipgrep } from '../../src/acp/cliRipgrep';

describe('provideRipgrep', () => {
	const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'cli-rg-')));
	const bundle = path.join(base, 'gemini-cli', '0.64.0', 'bundle');
	const source = path.join(base, 'app', 'rg');
	mkdirSync(bundle, { recursive: true });
	mkdirSync(path.dirname(source));
	writeFileSync(source, 'ripgrep binary');
	afterAll(() => rmSync(base, { recursive: true, force: true }));

	it('puts the app\'s ripgrep where the CLI looks for its own, executable, once', async () => {
		expect(cliRipgrepPath(bundle, 'darwin', 'arm64')).toBe(path.join(bundle, 'vendor', 'ripgrep', 'rg-darwin-arm64'));
		expect(await provideRipgrep(bundle, source, 'darwin', 'arm64')).toBe('added');
		const target = cliRipgrepPath(bundle, 'darwin', 'arm64');
		expect(readFileSync(target, 'utf8')).toBe('ripgrep binary');
		expect(statSync(target).mode & 0o111).toBeTruthy();
		expect(await provideRipgrep(bundle, source, 'darwin', 'arm64')).toBe('present');
	});

	it('replaces a different copy, and does nothing without the app\'s ripgrep', async () => {
		writeFileSync(source, 'a newer ripgrep binary');
		expect(await provideRipgrep(bundle, source, 'darwin', 'arm64')).toBe('added');
		expect(await provideRipgrep(bundle, undefined)).toBe('unavailable');
		expect(await provideRipgrep(bundle, path.join(base, 'missing'))).toBe('unavailable');
	});
});
