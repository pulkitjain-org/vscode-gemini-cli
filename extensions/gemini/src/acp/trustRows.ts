/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent Setup's Trusted Folders section, apart from its words: the rows that
// the Gemini CLI's trust file reads as, in the order of the file. A trusted
// repository's worktrees rule is part of the repository's row, a TRUST_PARENT
// rule is shown as the parent folder it trusts, and GeminiCode's own rules
// can't be removed.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { samePath } from './fsUtil';
import type { TrustRule } from './trustedFolders';
import { worktreesHome } from './worktrees';

/**
 * How a row reads: a repository trusted, a folder and everything in it,
 * never trusted, an agents' branches folder of its own, or one of
 * GeminiCode's own rules.
 */
export type TrustRowKind = 'trusted' | 'subfolders' | 'never' | 'branches' | 'ownTrusted' | 'ownNever';

export interface TrustRow {
	/** The folder the rule covers: a TRUST_PARENT rule's parent folder. */
	readonly folder: string;
	readonly kind: TrustRowKind;
	/** The rule's key in the file, which Remove deletes; unset for GeminiCode's own rules. */
	readonly rule?: string;
	/** A trusted repository's worktrees folder, when the file trusts it too. */
	readonly worktrees?: string;
	/** For `subfolders`: the first few Git repositories directly in the folder, by name. */
	readonly repositories?: readonly string[];
	/** For `subfolders`: how many more repositories there are. */
	readonly more?: number;
}

/** How many repositories a with-subfolders row names. */
const named = 3;

/** Whether `folder` is a Git repository or worktree: it has a .git folder or file. */
function isRepository(folder: string): Promise<boolean> {
	return fs.stat(path.join(folder, '.git')).then(() => true, () => false);
}

/** The Git repositories directly in `folder`, by name, looking at its first few hundred folders. */
async function repositoriesIn(folder: string): Promise<string[]> {
	const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
	const folders = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).slice(0, 300);
	const found = await Promise.all(folders.map(async entry => await isRepository(path.join(folder, entry.name)) ? entry.name : undefined));
	return found.filter((name): name is string => !!name).sort((a, b) => a.localeCompare(b));
}

/**
 * The rows `rules` read as, in their order. `own` are GeminiCode's own rules
 * (`ownTrustRules`): a rule of the file that matches one, path and level, is
 * shown as GeminiCode's. `home` is where ~/.geminicode is.
 */
export async function trustRows(rules: readonly TrustRule[], own: readonly TrustRule[], home: string = os.homedir()): Promise<TrustRow[]> {
	const repositories = await Promise.all(rules.map(rule => rule.level === 'DO_NOT_TRUST' ? false : isRepository(rule.path)));
	const branchesHome = path.join(home, '.geminicode', 'worktrees');
	// A trusted repository's worktrees rule, which FolderTrust keeps in step with it, is part of its row.
	const worktreesOf = new Map<number, string>();
	const folded = new Set<number>();
	for (const [i, rule] of rules.entries()) {
		if (rule.level === 'TRUST_FOLDER' && repositories[i]) {
			const worktrees = worktreesHome(rule.path, home);
			const match = rules.findIndex(other => other.level === 'TRUST_FOLDER' && samePath(other.path, worktrees));
			if (match >= 0 && match !== i) {
				worktreesOf.set(i, rules[match].path);
				folded.add(match);
			}
		}
	}
	const rows = await Promise.all(rules.map(async (rule, i): Promise<TrustRow | undefined> => {
		if (folded.has(i)) {
			return undefined;
		}
		const mine = own.find(each => each.level === rule.level && samePath(each.path, rule.path));
		if (mine) {
			return { folder: rule.path, kind: rule.level === 'DO_NOT_TRUST' ? 'ownNever' : 'ownTrusted' };
		}
		if (rule.level === 'DO_NOT_TRUST') {
			return { folder: rule.path, kind: 'never', rule: rule.path };
		}
		if (rule.level === 'TRUST_FOLDER' && samePath(path.dirname(rule.path), branchesHome)) {
			return { folder: rule.path, kind: 'branches', rule: rule.path };
		}
		if (rule.level === 'TRUST_FOLDER' && repositories[i]) {
			const worktrees = worktreesOf.get(i);
			return { folder: rule.path, kind: 'trusted', rule: rule.path, ...worktrees ? { worktrees } : {} };
		}
		// TRUST_PARENT trusts the folder the rule names and everything beside it.
		const folder = rule.level === 'TRUST_PARENT' ? path.dirname(rule.path) : rule.path;
		const inside = await repositoriesIn(folder);
		return { folder, kind: 'subfolders', rule: rule.path, repositories: inside.slice(0, named), ...inside.length > named ? { more: inside.length - named } : {} };
	}));
	return rows.filter((row): row is TrustRow => !!row);
}
