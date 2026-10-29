/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isInside } from '../acp/fileAccess';
import { changedBetween, findGitDir, headPosition, HeadPosition } from '../acp/gitHead';
import { ChangeBatch } from '../acp/index/changeBatch';

/** File events are passed on in batches, this long after the last one. */
const filesDebounceMs = 1_000;
/** A checkout writes HEAD and refs in a burst; one look at where HEAD went follows it. */
const headDebounceMs = 2_000;

export interface IndexChanges {
	/** Files changed in `folder`. */
	changed(folder: string, paths: readonly string[]): void;
	/** `folder`'s history moved: compare all of it again. */
	moved(folder: string): void;
}

/**
 * Keeps the indexes of folders open in this window current: one file
 * watcher per indexed folder, its events batched, and a watch on the
 * repository's HEAD and branch refs for checkouts and pulls. When they
 * change, the files the two commits differ in go to the indexer as an
 * ordinary change batch; only a branch switch, a move git cannot explain or
 * a change of more than a batch's worth compares everything again. A commit
 * on another branch (an agent's worktree, which shares the refs) moves
 * nothing here and costs one `git rev-parse`. Folders outside the window
 * (agents' worktrees) are kept current by the agents' own edits and, when
 * each turn ends, what git says changed, which costs no watcher.
 */
export class IndexWatchers implements vscode.Disposable {

	private readonly watched = new Map<string, vscode.Disposable>();
	private readonly pending = new Map<string, ChangeBatch>();
	private filesTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly headTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Where each watched checkout's HEAD was last seen, to tell a commit here from one on another branch. */
	private readonly heads = new Map<string, HeadPosition | undefined>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly target: IndexChanges) {
		this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
			for (const folder of [...this.watched.keys()]) {
				if (!IndexWatchers.inWindow(folder)) {
					this.unwatch(folder);
				}
			}
		}));
	}

	/** Whether `folder` is in one of the window's folders, where watchers see its changes. */
	static inWindow(folder: string): boolean {
		return (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.scheme === 'file' && isInside(f.uri.fsPath, folder));
	}

	/** Starts watching `folder`, when it is in the window and not watched yet. */
	watch(folder: string): void {
		if (this.watched.has(folder) || !IndexWatchers.inWindow(folder)) {
			return;
		}
		const store: vscode.Disposable[] = [];
		this.watched.set(folder, { dispose: () => vscode.Disposable.from(...store).dispose() });
		const files = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), '**/*'));
		const queue = (uri: vscode.Uri) => this.queue(folder, uri);
		store.push(files, files.onDidCreate(queue), files.onDidChange(queue), files.onDidDelete(queue));
		void this.watchHead(folder, store);
	}

	unwatch(folder: string): void {
		this.watched.get(folder)?.dispose();
		this.watched.delete(folder);
		this.pending.delete(folder);
		this.heads.delete(folder);
		clearTimeout(this.headTimers.get(folder));
		this.headTimers.delete(folder);
	}

	dispose(): void {
		clearTimeout(this.filesTimer);
		for (const timer of this.headTimers.values()) {
			clearTimeout(timer);
		}
		for (const folder of [...this.watched.keys()]) {
			this.unwatch(folder);
		}
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private queue(folder: string, uri: vscode.Uri): void {
		if (uri.scheme !== 'file' || uri.fsPath.split(path.sep).includes('.git')) {
			return;
		}
		let batch = this.pending.get(folder);
		if (!batch) {
			batch = new ChangeBatch();
			this.pending.set(folder, batch);
		}
		batch.add(uri.fsPath);
		clearTimeout(this.filesTimer);
		this.filesTimer = setTimeout(() => this.flush(), filesDebounceMs);
	}

	private flush(): void {
		const batches = [...this.pending];
		this.pending.clear();
		for (const [folder, batch] of batches) {
			const changed = batch.changed;
			if (changed) {
				this.target.changed(folder, changed);
			} else {
				// More than the indexer applies one by one: it compares everything instead.
				this.target.moved(folder);
			}
		}
	}

	/** Watches the repository's HEAD (a checkout) and branch refs (a pull, a commit). */
	private async watchHead(folder: string, store: vscode.Disposable[]): Promise<void> {
		const gitDir = await findGitDir(folder);
		if (!gitDir || !this.watched.has(folder)) {
			return;
		}
		const common = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
		const commonDir = common ? path.resolve(gitDir, common) : gitDir;
		this.heads.set(folder, await headPosition(folder));
		const moved = () => {
			clearTimeout(this.headTimers.get(folder));
			this.headTimers.set(folder, setTimeout(() => {
				this.headTimers.delete(folder);
				void this.headMoved(folder);
			}, headDebounceMs));
		};
		for (const pattern of [new vscode.RelativePattern(vscode.Uri.file(gitDir), 'HEAD'), new vscode.RelativePattern(vscode.Uri.file(commonDir), '{packed-refs,refs/heads/**}')]) {
			const watcher = vscode.workspace.createFileSystemWatcher(pattern);
			store.push(watcher, watcher.onDidCreate(moved), watcher.onDidChange(moved), watcher.onDidDelete(moved));
		}
	}

	/**
	 * HEAD or a ref changed: the files the old and new commits differ in go
	 * as a change batch, and the whole folder is compared again only on a
	 * branch switch, when git cannot say what changed, or when that is more
	 * than a batch holds. HEAD still at the same commit (a commit on another
	 * branch, packed refs rewritten) changes nothing.
	 */
	private async headMoved(folder: string): Promise<void> {
		if (!this.watched.has(folder)) {
			return;
		}
		const before = this.heads.get(folder);
		const now = await headPosition(folder);
		if (!this.watched.has(folder)) {
			return;
		}
		this.heads.set(folder, now);
		if (!before || !now) {
			if (before || now) {
				this.target.moved(folder);
			}
			return;
		}
		if (before.branch !== now.branch) {
			this.target.moved(folder);
			return;
		}
		if (before.commit === now.commit) {
			return;
		}
		const changed = await changedBetween(folder, before.commit, now.commit);
		if (!changed) {
			this.target.moved(folder);
			return;
		}
		const batch = new ChangeBatch();
		for (const file of changed) {
			batch.add(file);
		}
		const paths = batch.changed;
		if (!paths) {
			this.target.moved(folder);
		} else if (paths.length) {
			this.target.changed(folder, paths);
		}
	}
}
