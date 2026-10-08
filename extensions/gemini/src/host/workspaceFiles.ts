/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { FileMatch } from '../acp/folderFiles';
import { combineGlobs, indexPath, IndexedPath, rankPaths } from '../acp/fuzzy';

export type { FileMatch };

/** Cap on indexed files, so a huge workspace cannot stall the picker. */
const maxFiles = 50_000;
/** Deleted paths kept to filter results until the next rebuild; past this the list is built again. */
const maxTrackedDeletes = 500;

type IndexedFile = IndexedPath & { readonly path: string };

/**
 * The file list behind the chat's @-mention picker. It is built once, on
 * the first search, honouring files.exclude and search.exclude. After files
 * are created or deleted it is rebuilt in the background on the next search,
 * which meanwhile uses the list it has (minus deleted files), so the picker
 * never waits on a rebuild. Ranking runs on the cached list, so each
 * keystroke costs no file system work.
 */
export class WorkspaceFileIndex implements vscode.Disposable {

	private files: Promise<IndexedFile[]> | undefined;
	/** Files were created or deleted since the list was built. */
	private stale = false;
	private rebuilding: Promise<unknown> | undefined;
	/** Paths deleted since the list was built. */
	private deleted = new Set<string>();
	/** Bumped when the list must be rebuilt from scratch, so an older rebuild does not replace it. */
	private generation = 0;
	/** Made with the first list, so a window whose chat never searches files watches nothing. */
	private watcher: vscode.FileSystemWatcher | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('files.exclude') || e.affectsConfiguration('search.exclude')) {
					this.invalidate();
				}
			}),
		);
	}

	/** Starts building the index ahead of the first search. */
	warm(): void {
		void this.load();
	}

	private invalidate(): void {
		this.files = undefined;
		this.generation++;
	}

	private watch(): void {
		if (this.watcher) {
			return;
		}
		const watcher = this.watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
		const markStale = () => this.stale = true;
		this.disposables.push(
			watcher,
			watcher.onDidCreate(markStale),
			watcher.onDidDelete(uri => {
				markStale();
				if (this.deleted.size >= maxTrackedDeletes) {
					// A branch switch or a clean build: build the list again rather than filter every search by each path.
					this.invalidate();
					return;
				}
				// Until the rebuild, results under it are left out, so the picker does not offer a file that is gone.
				this.deleted.add(uri.fsPath);
			}),
		);
	}

	async search(query: string, limit: number): Promise<FileMatch[]> {
		const files = await this.load();
		const deleted = this.deleted;
		const wanted = limit + deleted.size;
		let ranked: IndexedFile[];
		if (query) {
			ranked = rankPaths(query, files, wanted);
		} else {
			// Nothing typed yet: open editors first, then the shortest paths.
			const open = openEditorPaths();
			ranked = [...files.filter(f => open.has(f.path)), ...rankPaths('', files.filter(f => !open.has(f.path)), wanted)];
		}
		if (deleted.size) {
			ranked = ranked.filter(f => !isUnder(f.path, deleted));
		}
		return ranked.slice(0, limit).map(f => ({ path: f.path, relative: f.relative }));
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private load(): Promise<IndexedFile[]> {
		this.watch();
		if (this.files && this.stale && !this.rebuilding) {
			this.stale = false;
			const generation = this.generation;
			const deleted = new Set(this.deleted);
			this.rebuilding = findWorkspaceFiles().then(result => {
				if (result.length && generation === this.generation) {
					this.files = Promise.resolve(result);
					// Deleted while it was being built: still left out until the next rebuild.
					const later = [...this.deleted].filter(path => !deleted.has(path));
					this.deleted = new Set(later);
					if (later.length) {
						this.stale = true;
					}
				}
			}, () => undefined).finally(() => this.rebuilding = undefined);
		}
		if (!this.files) {
			this.deleted.clear();
			this.stale = false;
			const files = this.files = findWorkspaceFiles().catch(() => []);
			// A failed or superseded build is retried on the next search.
			void files.then(result => {
				if (!result.length && this.files === files) {
					this.files = undefined;
				}
			});
		}
		return this.files;
	}
}

async function findWorkspaceFiles(): Promise<IndexedFile[]> {
	const uris = await vscode.workspace.findFiles('**/*', excludeGlob(), maxFiles);
	return uris
		.filter(uri => uri.scheme === 'file')
		.map(uri => ({ ...indexPath(vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1)), path: uri.fsPath }));
}

/** files.exclude and search.exclude together (an explicit exclude turns off findFiles' default excludes). */
function excludeGlob(): string | undefined {
	const patterns = new Set<string>();
	for (const section of ['files.exclude', 'search.exclude']) {
		const settings = vscode.workspace.getConfiguration().get<Record<string, unknown>>(section) ?? {};
		for (const [pattern, enabled] of Object.entries(settings)) {
			// A when-clause object means "sometimes"; keeping the file is the safe choice.
			if (enabled === true) {
				patterns.add(pattern);
			}
		}
	}
	return combineGlobs(patterns);
}

/** Whether `path` is one of `roots` or inside one. */
function isUnder(path: string, roots: ReadonlySet<string>): boolean {
	if (roots.has(path)) {
		return true;
	}
	for (const root of roots) {
		if (path.startsWith(root) && (path[root.length] === '/' || path[root.length] === '\\')) {
			return true;
		}
	}
	return false;
}

function openEditorPaths(): Set<string> {
	const paths = new Set<string>();
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file') {
				paths.add(tab.input.uri.fsPath);
			}
		}
	}
	return paths;
}
