/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A session's own folder in the Gemini CLI's files, beside its chats:
//
//   ~/.gemini/tmp/<project id>/<session id>/   plans/, tracker/, tasks/
//
// gemini-cli 0.64 deletes that folder each time `session/load` reopens the
// session: the load starts a throwaway session under the same id, and when
// the saved one replaces it, the CLI cleans up the throwaway one's files,
// which are the saved session's (`resumeChat`,
// `deleteCurrentSessionIfNotResumableAsync`). So every plan an agent wrote
// was gone once GeminiCode reopened it. `keepSessionFolder` copies the
// folder aside around a load and puts back what the load removed;
// `rebuildSessionFile` (sessionReplay.ts) brings back a plan lost before
// that, from the write and replace calls the session saved.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chatsFolder, cliHome } from './cliSessions';

/** Session `id`'s folder for `cwd`; undefined when the CLI keeps no files for the folder, or `id` can't name one. */
export async function sessionFolder(cwd: string, id: string, home = cliHome()): Promise<string | undefined> {
	// Not one of the folders the CLI keeps beside sessions' folders.
	if (!/^[\w-]+$/.test(id) || /^(chats|logs|tool-outputs)$/i.test(id)) {
		return undefined;
	}
	const chats = await chatsFolder(cwd, home);
	return chats && path.join(path.dirname(chats), id);
}

/** What copies of sessions' folders are named, in the system's temporary folder. */
const keptPrefix = 'geminicode-session-';

/**
 * Copies session `id`'s folder aside, to put back with the function this
 * resolves with once `session/load` has answered: it adds the files the load
 * removed and leaves alone any the CLI wrote since. A file that can't be
 * copied doesn't cost the rest.
 */
export async function keepSessionFolder(cwd: string, id: string, home = cliHome()): Promise<() => Promise<void>> {
	const folder = await sessionFolder(cwd, id, home).catch(() => undefined);
	if (!folder || !await fs.stat(folder).then(stat => stat.isDirectory(), () => false)) {
		// No folder yet: nothing to keep.
		return async () => undefined;
	}
	const kept = await fs.mkdtemp(path.join(os.tmpdir(), keptPrefix));
	await copyWhatCan(folder, kept);
	return async () => {
		await fs.cp(kept, folder, { recursive: true, force: false }).catch(() => undefined);
		await fs.rm(kept, { recursive: true, force: true }).catch(() => undefined);
	};
}

/** Copies `from` into `to`, carrying on past what can't be copied. */
async function copyWhatCan(from: string, to: string): Promise<void> {
	const entries = await fs.readdir(from, { withFileTypes: true }).catch(() => []);
	await fs.mkdir(to, { recursive: true });
	for (const entry of entries) {
		const source = path.join(from, entry.name);
		const target = path.join(to, entry.name);
		await (entry.isDirectory() ? copyWhatCan(source, target) : fs.copyFile(source, target).catch(() => undefined));
	}
}

/**
 * Removes copies `keepSessionFolder` left in `tmp` more than `maxAgeMs` ago,
 * as when the extension host died during a load; resolves with how many went.
 */
export async function removeKeptSessionFolders(tmp = os.tmpdir(), now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
	const names = (await fs.readdir(tmp).catch(() => [] as string[])).filter(name => name.startsWith(keptPrefix));
	let removed = 0;
	for (const name of names) {
		const folder = path.join(tmp, name);
		const stat = await fs.stat(folder).catch(() => undefined);
		if (stat?.isDirectory() && now - stat.mtimeMs > maxAgeMs) {
			await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
			removed++;
		}
	}
	return removed;
}
