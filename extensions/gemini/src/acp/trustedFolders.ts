/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Folder trust (plan Phase 4, policy-enforcement follow-up). gemini-cli 0.62
// refuses Auto Edit and YOLO, and skips a folder's own .gemini settings and
// MCP servers, until the folder is in its trusted-folders list. Its terminal
// asks once per folder; GeminiCode asks the same question when the user picks
// such a mode, and records the answer in the same file the CLI writes.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Where the CLI keeps its trusted folders; mirrors `Storage.getTrustedFoldersPath` in gemini-cli. */
export function trustedFoldersPath(env: NodeJS.ProcessEnv, homedir: string = os.homedir()): string {
	return env.GEMINI_CLI_TRUSTED_FOLDERS_PATH || path.join(env.GEMINI_CLI_HOME || homedir, '.gemini', 'trustedFolders.json');
}

/**
 * Adds `folder` to the CLI's trusted folders, keeping every other entry.
 * Throws, and leaves the file alone, when it cannot be read as JSON.
 */
export function trustFolder(file: string, folder: string): void {
	let config: Record<string, unknown> = {};
	let text: string | undefined;
	try {
		text = fs.readFileSync(file, 'utf8');
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
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp.${process.pid}.${Date.now()}`;
	try {
		fs.writeFileSync(temp, JSON.stringify(config, undefined, 2), { encoding: 'utf8', mode: 0o600 });
		fs.renameSync(temp, file);
	} catch (err) {
		fs.rmSync(temp, { force: true });
		throw err;
	}
}
