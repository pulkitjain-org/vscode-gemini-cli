/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { combineGlobs, indexPath, IndexedPath, rankPaths } from '../acp/fuzzy';

/** Cap on indexed files, so a huge workspace cannot stall the picker. */
const maxFiles = 50_000;

type IndexedFile = IndexedPath & { readonly path: string };

export interface FileMatch {
	readonly path: string;
	/** Workspace-relative, for display. */
	readonly relative: string;
}

/**
 * The file list behind the chat's @-mention picker. It is built once, on
 * the first search, honouring files.exclude and search.exclude, and is
 * rebuilt lazily after files are created or deleted. Ranking runs on the
 * cached list, so each keystroke costs no file system work.
 */
export class WorkspaceFileIndex implements vscode.Disposable {

	private files: Promise<IndexedFile[]> | undefined;
	private readonly watcher: vscode.FileSystemWatcher;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
		const invalidate = () => this.files = undefined;
		this.disposables.push(
			this.watcher,
			this.watcher.onDidCreate(invalidate),
			this.watcher.onDidDelete(invalidate),
			vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('files.exclude') || e.affectsConfiguration('search.exclude')) {
					invalidate();
				}
			}),
		);
	}

	/** Starts building the index ahead of the first search. */
	warm(): void {
		void this.load();
	}

	async search(query: string, limit: number): Promise<FileMatch[]> {
		const files = await this.load();
		let ranked: IndexedFile[];
		if (query) {
			ranked = rankPaths(query, files, limit);
		} else {
			// Nothing typed yet: open editors first, then the shortest paths.
			const open = openEditorPaths();
			ranked = [...files.filter(f => open.has(f.path)), ...rankPaths('', files.filter(f => !open.has(f.path)), limit)].slice(0, limit);
		}
		return ranked.map(f => ({ path: f.path, relative: f.relative }));
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private load(): Promise<IndexedFile[]> {
		if (!this.files) {
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
