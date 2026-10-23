/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Folder trust. gemini-cli 0.62 refuses Auto Edit and YOLO, and skips a
// folder's own .gemini settings and MCP servers, until the folder is in its
// trusted-folders list. Its terminal asks once per folder; GeminiCode asks the
// same question when the user picks such a mode, and records the answer in the
// same file the CLI writes.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripJsonComments } from './projectSettings';

/** Where the CLI keeps its trusted folders; mirrors `Storage.getTrustedFoldersPath` in gemini-cli. */
export function trustedFoldersPath(env: NodeJS.ProcessEnv, homedir: string = os.homedir()): string {
	return env.GEMINI_CLI_TRUSTED_FOLDERS_PATH || path.join(env.GEMINI_CLI_HOME || homedir, '.gemini', 'trustedFolders.json');
}

/**
 * Adds `folder` to the CLI's trusted folders, keeping every other entry.
 * Throws, and leaves the file alone, when it cannot be read as JSON.
 */
export async function trustFolder(file: string, folder: string): Promise<void> {
	let config: Record<string, unknown> = {};
	let text: string | undefined;
	try {
		text = await fs.readFile(file, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
	}
	if (text?.trim()) {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new Error(`${file} is not a JSON object.`);
		}
		config = parsed as Record<string, unknown>;
	}
	config[path.resolve(folder)] = 'TRUST_FOLDER';
	// Written the way the CLI writes it: owner-only, replaced in one rename.
	await fs.mkdir(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp.${process.pid}.${Date.now()}`;
	try {
		await fs.writeFile(temp, JSON.stringify(config, undefined, 2), { encoding: 'utf8', mode: 0o600 });
		await fs.rename(temp, file);
	} catch (err) {
		await fs.rm(temp, { force: true });
		throw err;
	}
}

/**
 * Whether the CLI trusts `folder` by `file`, decided as gemini-cli's
 * `isPathTrusted` does: the longest rule that covers the folder wins, where
 * TRUST_FOLDER covers its folder and TRUST_PARENT the folder's parent.
 * Undefined when no rule covers it, which the CLI treats as untrusted.
 */
export async function isFolderTrusted(file: string, folder: string): Promise<boolean | undefined> {
	let config: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		config = parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const location = await comparable(folder);
	let longest = -1;
	let level: unknown;
	const rules = Object.entries(config);
	const covers = await Promise.all(rules.map(([rule, value]) => comparable(value === 'TRUST_PARENT' ? path.dirname(rule) : rule)));
	for (const [i, [rule, value]] of rules.entries()) {
		const covered = covers[i];
		if ((location === covered || location.startsWith(covered.endsWith(path.sep) ? covered : covered + path.sep)) && rule.length > longest) {
			longest = rule.length;
			level = value;
		}
	}
	return level === 'DO_NOT_TRUST' ? false : level === 'TRUST_FOLDER' || level === 'TRUST_PARENT' ? true : undefined;
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
	return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** Whether the Gemini CLI trusts all of `folders`, or checks no folder's trust. */
export async function foldersTrusted(folders: readonly string[], env: NodeJS.ProcessEnv, homedir: string = os.homedir()): Promise<boolean> {
	const file = trustedFoldersPath(env, homedir);
	return !await folderTrustApplies(env, homedir) || (await Promise.all(folders.map(each => isFolderTrusted(file, each)))).every(trusted => trusted === true);
}
