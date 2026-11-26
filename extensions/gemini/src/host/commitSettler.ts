/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agents' changes leave the review list once they are committed, however the
// commit was made: from Source Control, the terminal, or by the agent itself.
// Only folders with changes to review are watched, and Git runs only after
// the repository's HEAD or a branch moved.

import * as vscode from 'vscode';
import type { AgentChanges } from '../acp/agentChanges';
import { errorMessage } from '../acp/errors';
import { filesMatchingHead, gitDirs } from '../acp/gitHead';

/** How long after HEAD or a branch moves the files are checked, so a commit's several writes count once. */
const settleDelayMs = 500;

export class CommitSettler implements vscode.Disposable {

	/** Watchers by folder, for folders whose agents have changes to review. */
	private readonly watched = new Map<string, vscode.Disposable>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		/** The change lists of the agents running in this window. */
		private readonly sources: () => Iterable<AgentChanges>,
		private readonly log: (message: string) => void,
	) { }

	/** Watches the folders that have changes to review now, and stops watching the others; cheap, so call it whenever a change list changes. */
	update(): void {
		const folders = new Set<string>();
		for (const changes of this.sources()) {
			if (changes.files.length) {
				folders.add(changes.folder);
			}
		}
		for (const [folder, watcher] of this.watched) {
			if (!folders.has(folder)) {
				watcher.dispose();
				this.watched.delete(folder);
				clearTimeout(this.timers.get(folder));
				this.timers.delete(folder);
			}
		}
		for (const folder of folders) {
			if (!this.watched.has(folder)) {
				this.watch(folder);
			}
		}
	}

	dispose(): void {
		for (const watcher of this.watched.values()) {
			watcher.dispose();
		}
		this.watched.clear();
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
	}

	private watch(folder: string): void {
		const disposables: vscode.Disposable[] = [];
		let disposed = false;
		this.watched.set(folder, new vscode.Disposable(() => {
			disposed = true;
			vscode.Disposable.from(...disposables).dispose();
		}));
		void gitDirs(folder).then(dirs => {
			if (!dirs || disposed) {
				return;
			}
			const moved = () => this.settleSoon(folder);
			for (const pattern of [new vscode.RelativePattern(vscode.Uri.file(dirs.gitDir), 'HEAD'), new vscode.RelativePattern(vscode.Uri.file(dirs.commonDir), '{packed-refs,refs/heads/**}')]) {
				const watcher = vscode.workspace.createFileSystemWatcher(pattern);
				disposables.push(watcher, watcher.onDidCreate(moved), watcher.onDidChange(moved), watcher.onDidDelete(moved));
			}
			// Changes restored from an earlier window may have been committed meanwhile.
			moved();
		});
	}

	private settleSoon(folder: string): void {
		clearTimeout(this.timers.get(folder));
		this.timers.set(folder, setTimeout(() => {
			this.timers.delete(folder);
			void this.settle(folder);
		}, settleDelayMs));
	}

	/** Keeps each agent's changes to files in `folder` that are now what HEAD has. */
	private async settle(folder: string): Promise<void> {
		for (const changes of this.sources()) {
			const files = changes.folder === folder ? changes.files.map(file => file.path) : [];
			if (!files.length) {
				continue;
			}
			try {
				const committed = await filesMatchingHead(folder, files);
				if (committed.length) {
					this.log(`Settled ${committed.length} committed file(s) in ${folder}`);
					changes.settle(committed);
				}
			} catch (err) {
				this.log(`Could not check committed files in ${folder}: ${errorMessage(err)}`);
			}
		}
	}
}
