/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Gemini CLI the real-CLI tests (test/acp/real*.test.ts) run against.

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'vitest';

const extensionDir = path.join(import.meta.dirname, '..');

/** The copy `npm run bundle-cli` placed in `cli/<bundledCli.version>/`, if it is there. */
function bundledCliPath(): string | undefined {
	const { version } = JSON.parse(readFileSync(path.join(extensionDir, 'package.json'), 'utf8')).bundledCli as { version: string };
	const entry = path.join(extensionDir, 'cli', version, 'bundle', 'gemini.js');
	return existsSync(entry) ? entry : undefined;
}

/** `GEMINI_CLI_PATH` (the CLI's executable or its `bundle/gemini.js`), else the bundled copy. */
export const realCliPath: string | undefined = process.env.GEMINI_CLI_PATH || bundledCliPath();

/**
 * `describe` for tests that run a real CLI. Without one they are skipped,
 * except in CI, where a missing CLI fails, so a green run always ran them.
 */
export function describeRealCli(name: string, body: () => void): void {
	if (realCliPath) {
		describe(name, body);
	} else if (process.env.CI) {
		describe(name, () => {
			it('has a Gemini CLI to run', () => {
				throw new Error('No Gemini CLI: run `npm run bundle-cli` in extensions/gemini, or set GEMINI_CLI_PATH.');
			});
		});
	} else {
		describe.skip(name, body);
	}
}
