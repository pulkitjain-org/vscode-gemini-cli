/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownTrustRules, type TrustRule } from '../../src/acp/trustedFolders';
import { trustRows } from '../../src/acp/trustRows';

describe('trustRows', () => {
	let home: string;
	beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-trust-rows-'))); });
	afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

	/** Makes `name` under the temp home, a repository when `repository`. */
	function folder(name: string, repository = false): string {
		const dir = path.join(home, name);
		fs.mkdirSync(repository ? path.join(dir, '.git') : dir, { recursive: true });
		return dir;
	}

	it('reads every rule in plain words, folding a repository\'s worktrees into its row', async () => {
		const work = folder('work');
		for (const name of ['delta', 'alpha', 'charlie', 'bravo']) {
			folder(path.join('work', name), true);
		}
		folder(path.join('work', 'notes'));
		const shop = folder('shop-api', true);
		const lone = folder('lone-worktrees', true);
		const parentOf = folder('codebase/vca', true);
		folder('codebase/cms', true);
		const rules: TrustRule[] = [
			{ path: work, level: 'TRUST_FOLDER' },
			{ path: shop, level: 'TRUST_FOLDER' },
			{ path: path.join(home, '.geminicode', 'worktrees', 'shop-api'), level: 'TRUST_FOLDER' },
			...ownTrustRules(home),
			{ path: parentOf, level: 'TRUST_PARENT' },
			{ path: path.join(home, '.geminicode', 'worktrees', 'other-repo'), level: 'TRUST_FOLDER' },
			{ path: path.join(home, 'Downloads', 'sample'), level: 'DO_NOT_TRUST' },
			{ path: lone, level: 'TRUST_FOLDER' },
		];
		expect(await trustRows(rules, ownTrustRules(home), home)).toEqual([
			{ folder: work, kind: 'subfolders', rule: work, repositories: ['alpha', 'bravo', 'charlie'], more: 1 },
			{ folder: shop, kind: 'trusted', rule: shop, worktrees: path.join(home, '.geminicode', 'worktrees', 'shop-api') },
			{ folder: path.join(home, '.geminicode', 'projects'), kind: 'ownTrusted' },
			{ folder: path.join(home, '.geminicode', 'reviews'), kind: 'ownNever' },
			{ folder: path.join(home, 'codebase'), kind: 'subfolders', rule: parentOf, repositories: ['cms', 'vca'] },
			{ folder: path.join(home, '.geminicode', 'worktrees', 'other-repo'), kind: 'branches', rule: path.join(home, '.geminicode', 'worktrees', 'other-repo') },
			{ folder: path.join(home, 'Downloads', 'sample'), kind: 'never', rule: path.join(home, 'Downloads', 'sample') },
			{ folder: lone, kind: 'trusted', rule: lone },
		]);
	});

	it('shows one of GeminiCode\'s folders at another level as the user\'s own rule, and a missing folder as a folder', async () => {
		const projects = path.join(home, '.geminicode', 'projects');
		const gone = path.join(home, 'gone');
		expect(await trustRows([{ path: projects, level: 'DO_NOT_TRUST' }, { path: gone, level: 'TRUST_FOLDER' }], ownTrustRules(home), home)).toEqual([
			{ folder: projects, kind: 'never', rule: projects },
			{ folder: gone, kind: 'subfolders', rule: gone, repositories: [] },
		]);
	});
});
