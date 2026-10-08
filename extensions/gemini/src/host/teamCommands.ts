/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Team commands (.gemini/commands/*.toml) for each agent folder, read once and
// read again only when a file in those folders changes, so the "/" menu opens
// without touching the disk.

import * as vscode from 'vscode';
import { loadTeamCommands, TeamCommand, teamCommandFolders } from '../acp/slashCommands';

class TeamCommandStore implements vscode.Disposable {

	private readonly cache = new Map<string, Promise<readonly TeamCommand[]>>();
	private readonly watchers = new Map<string, vscode.Disposable>();

	constructor(private readonly log: vscode.LogOutputChannel) { }

	/** The team commands for an agent working in `cwd`. */
	get(cwd: string): Promise<readonly TeamCommand[]> {
		let commands = this.cache.get(cwd);
		if (!commands) {
			const folders = teamCommandFolders(cwd);
			folders.forEach(folder => this.watch(folder));
			commands = loadTeamCommands(folders).then(result => {
				for (const { file, reason } of result.skipped) {
					this.log.warn(`Team command ${file} not offered: ${reason}`);
				}
				return result.commands;
			}, () => []);
			this.cache.set(cwd, commands);
		}
		return commands;
	}

	dispose(): void {
		this.watchers.forEach(watcher => watcher.dispose());
		this.watchers.clear();
		this.cache.clear();
	}

	private watch(folder: string): void {
		if (this.watchers.has(folder)) {
			return;
		}
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), '**/*.toml'));
		// A change anywhere is rare; forgetting every folder's list keeps this simple.
		const forget = () => this.cache.clear();
		this.watchers.set(folder, vscode.Disposable.from(watcher, watcher.onDidCreate(forget), watcher.onDidChange(forget), watcher.onDidDelete(forget)));
	}
}

let store: TeamCommandStore | undefined;

/** Sets up the team command store for the extension's lifetime. */
export function initTeamCommands(log: vscode.LogOutputChannel): vscode.Disposable {
	store = new TeamCommandStore(log);
	return store;
}

/** The team commands for `cwd`; none before `initTeamCommands`, as in tests. */
export function teamCommands(cwd: string): Promise<readonly TeamCommand[]> {
	return store?.get(cwd) ?? Promise.resolve([]);
}
