/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The "Add File to Chat" and "Add Selection to Chat" commands, and files
// picked or dropped in the chat. The chat view adds them to the composer.

import * as vscode from 'vscode';
import { Attachment, basename, classifyFile, maxImageBase64Length, supportedImageTypes } from '../acp/attachments';

/** Explorer and editor-title menus pass the clicked resource and the multi-selection. */
export async function filesToAttach(uri: unknown, uris: unknown): Promise<Attachment[]> {
	const candidates = Array.isArray(uris) && uris.length ? uris : uri ? [uri] : [];
	let resources = candidates.filter((u): u is vscode.Uri => u instanceof vscode.Uri && u.scheme === 'file');
	if (!candidates.length) {
		const active = vscode.window.activeTextEditor?.document.uri;
		resources = active?.scheme === 'file' ? [active] : [];
	}
	return attachmentsForFiles(resources);
}

/**
 * Attachments for files from anywhere. Files in the workspace are linked,
 * and the agent reads them itself. Others are sent with their contents when
 * that can be done (text up to 1 MB, images and PDFs), because the agent
 * would otherwise have to ask for access to each one; anything else is
 * linked, and the agent asks. Folders are left out; the agent can list
 * the ones in the workspace itself.
 */
export async function attachmentsForFiles(resources: readonly vscode.Uri[]): Promise<Attachment[]> {
	const attachments = await Promise.all(resources.map(async (resource): Promise<Attachment | undefined> => {
		try {
			const stat = await vscode.workspace.fs.stat(resource);
			if (!(stat.type & vscode.FileType.File)) {
				return undefined;
			}
			const link: Attachment = { kind: 'file', path: resource.fsPath };
			if (vscode.workspace.getWorkspaceFolder(resource) || stat.size > maxImageBase64Length) {
				return link;
			}
			const name = basename(resource.fsPath);
			const bytes = await vscode.workspace.fs.readFile(resource);
			const content = classifyFile(name, '', bytes);
			switch (content.kind) {
				case 'text':
					return { kind: 'document', name, path: resource.fsPath, mimeType: 'text/plain', text: content.text };
				case 'inline': {
					const data = Buffer.from(bytes).toString('base64');
					return supportedImageTypes.has(content.mimeType)
						? { kind: 'image', name, mimeType: content.mimeType, data }
						: { kind: 'document', name, path: resource.fsPath, mimeType: content.mimeType, data };
				}
				default:
					return link;
			}
		} catch {
			// Gone or unreadable since it was picked.
			return undefined;
		}
	}));
	return attachments.filter((a): a is Attachment => !!a);
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
