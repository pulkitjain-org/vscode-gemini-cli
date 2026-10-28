/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Folder trust. gemini-cli refuses Auto Edit and YOLO, asks before every git
// command, and skips a folder's own .gemini settings, GEMINI.md and MCP
// servers (GeminiCode's own among them) until the folder is in its
// trusted-folders list. Its terminal asks once per folder; GeminiCode asks the
// same question the first time a folder is chosen for agents (folderTrust.ts
// in the host), and records the answer in the same file the CLI writes, with
// the CLI's own three levels.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { comparablePath, isRecord, samePath, writeJsonAtomic } from './fsUtil';
import { stripJsonComments } from './projectSettings';
import { allReviewsHome, projectsHome, worktreesHome } from './worktrees';

/** gemini-cli's levels: a folder and everything in it, its parent folder and everything in that, or never. */
export type TrustLevel = 'TRUST_FOLDER' | 'TRUST_PARENT' | 'DO_NOT_TRUST';

/** One entry of the trusted-folders file: the path as written, and its level. */
export interface TrustRule {
	readonly path: string;
	readonly level: TrustLevel;
}

function isTrustLevel(value: unknown): value is TrustLevel {
	return value === 'TRUST_FOLDER' || value === 'TRUST_PARENT' || value === 'DO_NOT_TRUST';
}

/** Where the CLI keeps its trusted folders; mirrors `Storage.getTrustedFoldersPath` in gemini-cli. */
export function trustedFoldersPath(env: NodeJS.ProcessEnv, homedir: string = os.homedir()): string {
	return env.GEMINI_CLI_TRUSTED_FOLDERS_PATH || path.join(env.GEMINI_CLI_HOME || homedir, '.gemini', 'trustedFolders.json');
}

/** The file's entries as an object; empty when there is no file. Throws when it cannot be read as a JSON object. */
async function readConfig(file: string): Promise<Record<string, unknown>> {
	let text: string | undefined;
	try {
		text = await fs.readFile(file, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
	}
	if (!text?.trim()) {
		return {};
	}
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed)) {
		throw new Error(`${file} is not a JSON object.`);
	}
	return parsed;
}

/** Writes the entries the way the CLI writes them: owner-only, replaced in one rename. */
function writeConfig(file: string, config: Record<string, unknown>): Promise<void> {
	return writeJsonAtomic(file, config, { indent: 2, newline: false, mode: 0o600 });
}

/**
 * Sets `folder`'s entry in the CLI's trusted folders to `level`, or removes it
 * when `level` is undefined, keeping every other entry. Throws, and leaves the
 * file alone, when it cannot be read as JSON.
 */
export async function setFolderTrust(file: string, folder: string, level: TrustLevel | undefined): Promise<void> {
	const config = await readConfig(file);
	const key = path.resolve(folder);
	if (level) {
		config[key] = level;
	} else {
		delete config[key];
	}
	await writeConfig(file, config);
}

/** Adds `folder` to the CLI's trusted folders, keeping every other entry (`setFolderTrust`). */
export function trustFolder(file: string, folder: string): Promise<void> {
	return setFolderTrust(file, folder, 'TRUST_FOLDER');
}

/** Every entry of the trusted-folders file, in its order; entries with a value the CLI doesn't know are left out. Throws as `setFolderTrust` does. */
export async function readTrustRules(file: string): Promise<TrustRule[]> {
	return Object.entries(await readConfig(file)).flatMap(([rule, level]) => isTrustLevel(level) ? [{ path: rule, level }] : []);
}

/**
 * GeminiCode's own entries: its project coordinators' folders, which hold no
 * repository's code, are trusted so the project tools load there; its review
 * checkouts, other people's code, are never trusted.
 */
export function ownTrustRules(home: string = os.homedir()): readonly TrustRule[] {
	return [{ path: projectsHome(home), level: 'TRUST_FOLDER' }, { path: allReviewsHome(home), level: 'DO_NOT_TRUST' }];
}

/** Writes GeminiCode's own entries where the file lacks them or has them at another level; resolves whether it wrote. */
export async function ensureOwnTrustRules(file: string, home: string = os.homedir()): Promise<boolean> {
	const config = await readConfig(file);
	const missing = ownTrustRules(home).filter(rule => config[rule.path] !== rule.level);
	if (!missing.length) {
		return false;
	}
	for (const rule of missing) {
		config[rule.path] = rule.level;
	}
	await writeConfig(file, config);
	return true;
}

/** Removes the entries keyed `rules`, as written in the file, in one write; resolves whether any was there. */
export async function removeTrustRules(file: string, rules: readonly string[]): Promise<boolean> {
	const config = await readConfig(file);
	const present = rules.filter(rule => Object.hasOwn(config, rule));
	if (!present.length) {
		return false;
	}
	for (const rule of present) {
		delete config[rule];
	}
	await writeConfig(file, config);
	return true;
}

export interface StaleTrustOptions {
	/** Where ~/.geminicode is. */
	readonly home?: string;
	readonly temporary?: readonly string[];
	readonly exists?: (folder: string) => Promise<boolean>;
}

/**
 * The rules that trust a folder that is gone, which the file need not keep:
 * test runs and scripts leave one for every temporary folder they trust, and
 * a deleted repository leaves its own. A rule goes when its folder (a
 * TRUST_PARENT rule's parent) is missing and was in a temporary folder or
 * in ~/.geminicode, whose folders GeminiCode makes and deletes, or the folder
 * that held it is still there: a rule on an unplugged drive or an unmounted
 * share stays. Never-trust rules and GeminiCode's own stay, and so
 * does a trusted repository's worktrees folder, which is trusted before any
 * agent makes it.
 */
export async function staleTrustRules(rules: readonly TrustRule[], options: StaleTrustOptions = {}): Promise<TrustRule[]> {
	const home = options.home ?? os.homedir();
	// Where the system keeps temporary folders, which tests and scripts make and delete; /tmp is /private/tmp on macOS.
	const temporary = options.temporary ?? [os.tmpdir(), '/tmp', '/private/tmp', '/private/var/folders'];
	const exists = options.exists ?? (folder => fs.stat(folder).then(() => true, () => false));
	const own = ownTrustRules(home);
	const managed = [...temporary, path.join(home, '.geminicode')];
	const gone = await Promise.all(rules.map(async rule => {
		if (rule.level === 'DO_NOT_TRUST' || own.some(each => samePath(each.path, rule.path))) {
			return false;
		}
		const folder = rule.level === 'TRUST_PARENT' ? path.dirname(rule.path) : rule.path;
		return !await exists(folder) && (managed.some(each => comparablePath(folder).startsWith(comparablePath(each) + path.sep)) || await exists(path.dirname(folder)));
	}));
	const kept = rules.filter((_, i) => !gone[i]);
	return rules.filter((rule, i) => gone[i] && !kept.some(other => other.level !== 'DO_NOT_TRUST' && samePath(worktreesHome(other.path, home), rule.path)));
}

/** What decides a folder's trust: the entry that covers it, if any. */
export interface FolderTrustState {
	/** Undefined when no entry covers the folder, which the CLI treats as untrusted. */
	readonly trusted: boolean | undefined;
	readonly rule?: TrustRule;
}

/**
 * What the CLI makes of `folder` by `file`, decided as gemini-cli's
 * `isPathTrusted` does: the longest rule that covers the folder wins, where
 * TRUST_FOLDER covers its folder and TRUST_PARENT the folder's parent.
 */
export async function folderTrustState(file: string, folder: string): Promise<FolderTrustState> {
	let rules: TrustRule[];
	try {
		rules = await readTrustRules(file);
	} catch {
		return { trusted: undefined };
	}
	const location = await comparable(folder);
	let found: TrustRule | undefined;
	const covers = await Promise.all(rules.map(rule => comparable(rule.level === 'TRUST_PARENT' ? path.dirname(rule.path) : rule.path)));
	for (const [i, rule] of rules.entries()) {
		const covered = covers[i];
		if ((location === covered || location.startsWith(covered.endsWith(path.sep) ? covered : covered + path.sep)) && rule.path.length > (found?.path.length ?? -1)) {
			found = rule;
		}
	}
	return found ? { trusted: found.level !== 'DO_NOT_TRUST', rule: found } : { trusted: undefined };
}

/** Whether the CLI trusts `folder` by `file` (`folderTrustState`); undefined when no rule covers it. */
export async function isFolderTrusted(file: string, folder: string): Promise<boolean | undefined> {
	return (await folderTrustState(file, folder)).trusted;
}

/**
 * Whether the CLI checks folder trust at all: not when the environment
 * decides it for every folder, or when the user's settings turn it off.
 */
export async function folderTrustApplies(env: NodeJS.ProcessEnv, homedir: string = os.homedir()): Promise<boolean> {
	if (env.GEMINI_CLI_TRUST_WORKSPACE === 'true') {
		return false;
	}
	try {
		const settings = JSON.parse(stripJsonComments(await fs.readFile(path.join(env.GEMINI_CLI_HOME || homedir, '.gemini', 'settings.json'), 'utf8'))) as { security?: { folderTrust?: { enabled?: unknown } } };
		return settings.security?.folderTrust?.enabled !== false;
	} catch {
		return true;
	}
}

/** `folder` resolved through links, in the case the file system compares in. */
async function comparable(folder: string): Promise<string> {
	let resolved = path.resolve(folder);
	try {
		resolved = await fs.realpath(resolved);
	} catch {
		// Not there yet, such as a worktrees folder no thread has made: compare as written.
	}
	return comparablePath(resolved);
}

/** Whether the Gemini CLI trusts all of `folders`, or checks no folder's trust. */
export async function foldersTrusted(folders: readonly string[], env: NodeJS.ProcessEnv, homedir: string = os.homedir()): Promise<boolean> {
	const file = trustedFoldersPath(env, homedir);
	return !await folderTrustApplies(env, homedir) || (await Promise.all(folders.map(each => isFolderTrusted(file, each)))).every(trusted => trusted === true);
}
