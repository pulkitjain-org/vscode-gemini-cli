/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { git } from '../acp/worktrees';

export const reviewScheme = 'gemini-review';

/** File versions kept in memory, at most. */
const maxCached = 120;

/**
 * The files of a merge request under review, at the commits GitLab diffs
 * (`git show <sha>:<path>` in the clone): read-only documents for the diff
 * editor. Nothing is checked out, so the user's checkout and the reviewer's
 * worktree are never read or changed.
 */
export class ReviewDiffs implements vscode.TextDocumentContentProvider, vscode.Disposable {

	private readonly cache = new Map<string, Promise<string>>();
	private readonly registration: vscode.Disposable;

	constructor() {
		this.registration = vscode.workspace.registerTextDocumentContentProvider(reviewScheme, this);
	}

	/** The document for `file` at `sha` in `repository`; empty when there is no commit (a new or deleted file's missing side). */
	uri(repository: string, sha: string, file: string): vscode.Uri {
		// The file's path stays the URI's path, so the editor picks the language.
		return vscode.Uri.from({ scheme: reviewScheme, path: `/${file}`, query: new URLSearchParams({ repo: repository, sha }).toString() });
	}

	/** The repository, commit and file a document of this scheme shows. */
	parse(uri: vscode.Uri): { readonly repository: string; readonly sha: string; readonly file: string } | undefined {
		if (uri.scheme !== reviewScheme) {
			return undefined;
		}
		const query = new URLSearchParams(uri.query);
		const repository = query.get('repo');
		return repository ? { repository, sha: query.get('sha') ?? '', file: uri.path.replace(/^\//, '') } : undefined;
	}

	provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const at = this.parse(uri);
		return at ? this.text(at.repository, at.sha, at.file) : Promise.resolve('');
	}

	/** `file`'s text at `sha`; empty when it isn't there. */
	text(repository: string, sha: string, file: string): Promise<string> {
		if (!sha) {
			return Promise.resolve('');
		}
		const key = `${repository}\0${sha}\0${file}`;
		let text = this.cache.get(key);
		if (!text) {
			// A commit not fetched yet reads as empty, and is read again next time.
			text = git(repository, ['show', `${sha}:${file}`]).catch(() => {
				this.cache.delete(key);
				return '';
			});
			this.cache.set(key, text);
			while (this.cache.size > maxCached) {
				this.cache.delete(this.cache.keys().next().value!);
			}
		}
		return text;
	}

	async lines(repository: string, sha: string, file: string): Promise<string[]> {
		return (await this.text(repository, sha, file)).split(/\r?\n/);
	}

	/** Fetches each commit the clone doesn't have yet; one that can't be fetched is left out quietly. */
	async ensure(repository: string, remote: string, shas: readonly string[]): Promise<void> {
		const missing: string[] = [];
		for (const sha of shas.filter(Boolean)) {
			if (!await git(repository, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false)) {
				missing.push(sha);
			}
		}
		if (missing.length) {
			await git(repository, ['fetch', '--quiet', remote, ...missing]).catch(() => undefined);
		}
	}

	/** Opens a file's diff, `base` on the left and `head` on the right, at `line` of the new version when given. */
	async open(options: {
		readonly repository: string;
		readonly base: string;
		readonly head: string;
		readonly oldPath: string;
		readonly newPath: string;
		readonly newFile?: boolean;
		readonly deletedFile?: boolean;
		readonly line?: number;
		readonly title: string;
		readonly viewColumn: vscode.ViewColumn;
	}): Promise<void> {
		const left = this.uri(options.repository, options.newFile ? '' : options.base, options.oldPath);
		const right = this.uri(options.repository, options.deletedFile ? '' : options.head, options.newPath);
		const line = Math.max(0, (options.line ?? 1) - 1);
		await vscode.commands.executeCommand('vscode.diff', left, right, options.title, {
			preview: true,
			viewColumn: options.viewColumn,
			...options.line ? { selection: new vscode.Range(line, 0, line, 0) } : {},
		});
	}

	dispose(): void {
		this.registration.dispose();
		this.cache.clear();
	}
}

/** The diff's title: the file's name and the merge request's branches. */
export function reviewDiffTitle(file: string, iid: number, target: string, source: string): string {
	return vscode.l10n.t("{0} (!{1}: {2} ↔ {3})", path.basename(file), iid, target, source);
}
