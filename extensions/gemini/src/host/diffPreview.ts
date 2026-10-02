/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';

export interface ProposedChange {
	readonly path: string;
	readonly oldText?: string | null;
	readonly newText: string;
}

const scheme = 'gemini-proposed';
/** How many proposed changes stay readable after they were shown. */
const maxEntries = 50;

/**
 * Shows the agent's proposed edits in the diff editor: the file as the agent
 * read it on the left, the proposed text on the right, both read-only.
 */
export class DiffPreview implements vscode.TextDocumentContentProvider, vscode.Disposable {

	private readonly contents = new Map<string, string>();
	private readonly registration: vscode.Disposable;
	private nextId = 0;

	constructor() {
		this.registration = vscode.workspace.registerTextDocumentContentProvider(scheme, this);
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) ?? '';
	}

	async show(change: ProposedChange, options: { preserveFocus?: boolean } = {}): Promise<void> {
		const id = this.nextId++;
		const name = path.basename(change.path);
		// The file name stays last so the editor picks the right language.
		const left = vscode.Uri.from({ scheme, path: `/${id}/original/${name}` });
		const right = vscode.Uri.from({ scheme, path: `/${id}/proposed/${name}` });
		this.set(left, change.oldText ?? '');
		this.set(right, change.newText);
		const title = change.oldText ? vscode.l10n.t("{0} (proposed by Gemini)", name) : vscode.l10n.t("{0} (new file proposed by Gemini)", name);
		await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, preserveFocus: options.preserveFocus });
	}

	dispose(): void {
		this.registration.dispose();
		this.contents.clear();
	}

	private set(uri: vscode.Uri, text: string): void {
		this.contents.set(uri.toString(), text);
		while (this.contents.size > maxEntries) {
			this.contents.delete(this.contents.keys().next().value!);
		}
	}
}
