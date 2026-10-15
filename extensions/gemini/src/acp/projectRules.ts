/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A project's rules where its agents run. The Gemini CLI reads a folder's own
// rules from where its session runs: context files such as GEMINI.md, and the
// .gemini folder (settings, commands, skills, agents) and .agents/skills. A
// coordinator runs in an empty folder of its own, and a thread in a worktree,
// which lacks whatever the repository ignores, such as a local .gemini folder.
// A thread gets links to everything the repository has there; a coordinator,
// which only routes work, gets its context files alone. Links, not copies, so
// an edit to a rule reaches every agent.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { stripJsonComments } from './projectSettings';
import { git } from './worktrees';

/** What the CLI reads from a session's folder, besides context files: settings (and their MCP servers), commands, skills. */
export const ruleFolders = ['.gemini', '.agents'];

/** Context files the CLI reads by default, and the one other agents use. */
const defaultContextFiles = ['GEMINI.md', 'AGENTS.md'];

/** The context file names `settings` (a .gemini/settings.json) adds, as the CLI's `context.fileName` names them. */
export function contextFileNamesIn(text: string): string[] {
	try {
		const names = (JSON.parse(stripJsonComments(text)) as { context?: { fileName?: unknown } }).context?.fileName;
		const list = Array.isArray(names) ? names : [names];
		return list.filter((name): name is string => typeof name === 'string' && !!name && path.basename(name) === name);
	} catch {
		return [];
	}
}

/** Every rule entry to look for in `folder`: the rule folders and the context files, including those the user's or the folder's settings name. */
export async function ruleEntries(folder: string, userSettings: string): Promise<string[]> {
	const named = await Promise.all([userSettings, path.join(folder, '.gemini', 'settings.json')].map(file => fs.readFile(file, 'utf8').then(contextFileNamesIn, () => [])));
	return [...new Set([...ruleFolders, ...defaultContextFiles, ...named.flat()])];
}

/**
 * Links the rule entries `from` has into `to`, a coordinator's own folder,
 * leaving out `skip`: the links are remade each time, so a rule added since
 * shows up, and one removed or now skipped goes. Only links are touched;
 * anything else in `to` stays. Returns the entries linked.
 */
export async function linkCoordinatorRules(from: string, to: string, entries: readonly string[], skip: readonly string[] = []): Promise<string[]> {
	await fs.mkdir(to, { recursive: true });
	const linked: string[] = [];
	for (const name of [...entries, ...skip]) {
		const target = path.join(to, name);
		const existing = await fs.lstat(target).catch(() => undefined);
		if (existing && !existing.isSymbolicLink() && !existing.isFile()) {
			continue;
		}
		if (existing) {
			// Unlink, not rm: a junction's removal must never reach the folder it points to.
			await fs.unlink(target).catch(() => undefined);
		}
		if (!skip.includes(name) && await link(path.join(from, name), target)) {
			linked.push(name);
		}
	}
	return linked;
}

/**
 * Links into a thread's worktree folder `to` the rule entries `from` has that
 * the worktree lacks because the repository ignores them; ignored there too,
 * they never show as the thread's changes or reach its merge. Returns the
 * entries linked.
 */
export async function linkThreadRules(from: string, to: string, entries: readonly string[]): Promise<string[]> {
	const linked: string[] = [];
	for (const name of entries) {
		const target = path.join(to, name);
		if (await fs.lstat(target).then(() => true, () => false) || !await isIgnored(from, name)) {
			continue;
		}
		if (await link(path.join(from, name), target)) {
			linked.push(name);
		}
	}
	return linked;
}

async function isIgnored(folder: string, name: string): Promise<boolean> {
	try {
		await git(folder, ['check-ignore', '-q', '--', name]);
		return true;
	} catch {
		return false;
	}
}

/** Links `target` to `source` when `source` exists: a folder as a junction on Windows, which needs no rights, and a file copied there, where a file link would. */
async function link(source: string, target: string): Promise<boolean> {
	const stat = await fs.stat(source).catch(() => undefined);
	if (!stat) {
		return false;
	}
	try {
		if (process.platform === 'win32') {
			if (stat.isDirectory()) {
				await fs.symlink(source, target, 'junction');
			} else {
				await fs.copyFile(source, target);
			}
		} else {
			await fs.symlink(source, target, stat.isDirectory() ? 'dir' : 'file');
		}
		return true;
	} catch {
		return false;
	}
}
