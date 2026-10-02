/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The "Add File to Chat" and "Add Selection to Chat" commands. They only
// collect paths and text; the chat view adds them to the composer.

import * as vscode from 'vscode';
import { Attachment } from '../acp/attachments';

/** Explorer and editor-title menus pass the clicked resource and the multi-selection. */
export async function filesToAttach(uri: unknown, uris: unknown): Promise<Attachment[]> {
	const candidates = Array.isArray(uris) && uris.length ? uris : uri ? [uri] : [];
	let resources = candidates.filter((u): u is vscode.Uri => u instanceof vscode.Uri && u.scheme === 'file');
	if (!candidates.length) {
		const active = vscode.window.activeTextEditor?.document.uri;
		resources = active?.scheme === 'file' ? [active] : [];
	}
	const files: Attachment[] = [];
	for (const resource of resources) {
		try {
			// Folders are left out; the agent can list them itself.
			if ((await vscode.workspace.fs.stat(resource)).type & vscode.FileType.File) {
				files.push({ kind: 'file', path: resource.fsPath });
			}
		} catch {
			// Gone since the menu opened.
		}
	}
	return files;
}

/** The active editor's selections, or the whole file when nothing is selected. */
export function selectionsToAttach(): Attachment[] {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.uri.scheme !== 'file') {
		return [];
	}
	const { document } = editor;
	const selections = editor.selections.filter(s => !s.isEmpty);
	if (!selections.length) {
		return [{ kind: 'file', path: document.uri.fsPath }];
	}
	return selections.map(selection => {
		// A selection ending at column 0 of a line does not include that line.
		const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line - 1 : selection.end.line;
		return {
			kind: 'selection',
			path: document.uri.fsPath,
			text: document.getText(selection),
			startLine: selection.start.line + 1,
			endLine: endLine + 1,
			languageId: document.languageId,
		};
	});
}
