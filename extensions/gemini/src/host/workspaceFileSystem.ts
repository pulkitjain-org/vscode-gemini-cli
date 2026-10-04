/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ClientFileSystem, FileAccessPolicyOptions } from '../acp/fileAccess';
import { minimalEdit } from '../acp/lineDiff';
import { memoizeAsync } from '../acp/memoize';

/**
 * The agent's view of workspace files: reads see unsaved editor changes, and
 * writes go through a WorkspaceEdit (so they show in the editor and can be
 * undone) and are then saved, because the agent's own shell and search tools
 * read the disk.
 */
export class WorkspaceFileSystem implements ClientFileSystem {

	async readTextFile(filePath: string): Promise<string | undefined> {
		const uri = vscode.Uri.file(filePath);
		const open = findOpenDocument(uri);
		if (open) {
			return open.getText();
		}
		try {
			return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
		} catch (err) {
			if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
				return undefined;
			}
			throw err;
		}
	}

	async writeTextFile(filePath: string, content: string): Promise<void> {
		const uri = vscode.Uri.file(filePath);
		const edit = new vscode.WorkspaceEdit();
		const metadata: vscode.WorkspaceEditEntryMetadata = { label: vscode.l10n.t("Gemini"), needsConfirmation: false };
		if (!findOpenDocument(uri) && !await exists(uri)) {
			edit.createFile(uri, { contents: new TextEncoder().encode(content) }, metadata);
			if (!await vscode.workspace.applyEdit(edit)) {
				throw new Error(`Could not create ${filePath}.`);
			}
			return;
		}
		const document = await vscode.workspace.openTextDocument(uri);
		const fullRange = document.validateRange(new vscode.Range(0, 0, document.lineCount, 0));
		edit.replace(uri, fullRange, content, metadata);
		if (!await vscode.workspace.applyEdit(edit)) {
			throw new Error(`Could not edit ${filePath}.`);
		}
		if (!await document.save()) {
			throw new Error(`Edited ${filePath} but could not save it.`);
		}
	}
}

/**
 * Puts `text` into a file with the smallest edit, so open editors keep their
 * cursor and one undo puts it back, then saves it unless `save` is false.
 * Creates the file if it is missing.
 */
export async function replaceFileText(filePath: string, text: string, save = true): Promise<void> {
	const uri = vscode.Uri.file(filePath);
	if (!findOpenDocument(uri) && !await exists(uri)) {
		return new WorkspaceFileSystem().writeTextFile(filePath, text);
	}
	const document = await vscode.workspace.openTextDocument(uri);
	const change = minimalEdit(document.getText(), text);
	if (change.start !== change.end || change.text) {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text, { label: vscode.l10n.t("Gemini"), needsConfirmation: false });
		if (!await vscode.workspace.applyEdit(edit)) {
			throw new Error(`Could not edit ${filePath}.`);
		}
	}
	if (save && document.isDirty && !await document.save()) {
		throw new Error(`Edited ${filePath} but could not save it.`);
	}
}

/** Deletes a file through a WorkspaceEdit, so it can be undone like an edit. */
export async function deleteFile(filePath: string): Promise<void> {
	const edit = new vscode.WorkspaceEdit();
	edit.deleteFile(vscode.Uri.file(filePath), { ignoreIfNotExists: true }, { label: vscode.l10n.t("Gemini"), needsConfirmation: false });
	if (!await vscode.workspace.applyEdit(edit)) {
		throw new Error(`Could not delete ${filePath}.`);
	}
}

/** The access policy for the current workspace (folders, plus git's ignore rules). */
export function getFileAccessPolicy(): FileAccessPolicyOptions {
	return {
		roots: (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath),
		isIgnored: isIgnoredByGitCached,
	};
}

function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
	return vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === uri.fsPath);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/**
 * Each check starts a git process, and the agent often reads the same files
 * several times in a turn, so answers are kept for a few seconds.
 */
export const isIgnoredByGitCached = memoizeAsync(isIgnoredByGit, { ttlMs: 5_000, maxEntries: 500 });

/** `git check-ignore`: exit 0 means ignored. No git, or not a repository, means not ignored. */
function isIgnoredByGit(filePath: string): Promise<boolean> {
	return new Promise(resolve => {
		execFile('git', ['check-ignore', '--quiet', '--', filePath], { cwd: path.dirname(filePath), timeout: 5_000 }, err => {
			resolve(!err);
		});
	});
}
