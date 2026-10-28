/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import type { CodeCall, CodeDiagnostic, CodeLocation, CodeTarget, EditorBackend } from '../acp/editorTools';
import { changedSince, gitHead } from '../acp/index/gitChanges';

/** How long a read waits for a language server; a cold one loading a large project answers later, and the index answers meanwhile. */
const answerMs = 8_000;
/** How long a file just opened waits for its first diagnostics. */
const diagnosticsSettleMs = 1_500;
const maxFiles = 50;
const maxLocations = 50;

/**
 * The agents' way into the editor's language servers (src/acp/editorTools.ts),
 * through VS Code's `vscode.execute…` commands, on files inside the agent's
 * folder that are neither secret nor git-ignored. In dist/onDemand.js, loaded
 * the first time an agent calls one of these tools; what it needs of the
 * extension bundle (which files an agent may read) comes in its constructor.
 */
export class EditorToolsHost implements EditorBackend {

	/** `mayRead` says whether an agent in `folder` may read `file`: inside it, not secret, not ignored by git. */
	constructor(private readonly mayRead: (folder: string, file: string) => Promise<boolean>) { }

	async references(target: CodeTarget): Promise<readonly CodeLocation[] | undefined> {
		const position = await this.position(target);
		if (!position) {
			return undefined;
		}
		const found = await within(vscode.commands.executeCommand<vscode.Location[] | undefined>('vscode.executeReferenceProvider', position.uri, position.position));
		// No provider, or one still loading, answers with nothing: the index answers instead.
		if (!found?.length) {
			return undefined;
		}
		const locations: CodeLocation[] = [];
		const lines = new Map<string, Promise<readonly string[] | undefined>>();
		for (const location of found) {
			const file = location.uri.fsPath;
			if (locations.length < maxLocations && location.uri.scheme === 'file' && await this.allowed(target.folder, file)) {
				const line = location.range.start.line + 1;
				lines.set(file, lines.get(file) ?? linesOf(file));
				locations.push({ file, line, text: (await lines.get(file))?.[line - 1] });
			}
		}
		return locations;
	}

	async hover(target: CodeTarget): Promise<string | undefined> {
		const position = await this.position(target);
		if (!position) {
			return undefined;
		}
		const hovers = await within(vscode.commands.executeCommand<vscode.Hover[] | undefined>('vscode.executeHoverProvider', position.uri, position.position));
		if (!hovers) {
			return undefined;
		}
		return hovers.flatMap(hover => hover.contents.map(content => typeof content === 'string' ? content : content.value)).filter(text => text.trim()).join('\n\n');
	}

	async calls(target: CodeTarget, direction: 'incoming' | 'outgoing'): Promise<readonly CodeCall[] | undefined> {
		const position = await this.position(target);
		if (!position) {
			return undefined;
		}
		const items = await within(vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>('vscode.prepareCallHierarchy', position.uri, position.position));
		const item = items?.[0];
		if (!item) {
			return undefined;
		}
		const of = (node: vscode.CallHierarchyItem) => ({ name: node.detail ? `${node.name} (${node.detail})` : node.name, file: node.uri.fsPath, line: node.selectionRange.start.line + 1 });
		if (direction === 'incoming') {
			const calls = await within(vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[] | undefined>('vscode.provideIncomingCalls', item));
			return calls?.map(call => of(call.from));
		}
		const calls = await within(vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[] | undefined>('vscode.provideOutgoingCalls', item));
		return calls?.map(call => of(call.to));
	}

	async diagnostics(folder: string, files: readonly string[] | undefined): Promise<{ readonly checked: number; readonly diagnostics: readonly CodeDiagnostic[] }> {
		const wanted = files ?? (await changedSince(folder, await gitHead(folder)))?.paths ?? [];
		const allowed: string[] = [];
		for (const file of wanted) {
			if (allowed.length < maxFiles && await this.allowed(folder, file) && await fs.stat(file).then(stat => stat.isFile(), () => false)) {
				allowed.push(file);
			}
		}
		const uris = allowed.map(file => vscode.Uri.file(file));
		// Opening a file, without showing it, is what makes its language server check it.
		await Promise.all(uris.map(uri => Promise.resolve(vscode.workspace.openTextDocument(uri)).catch(() => undefined)));
		await settled(uris);
		const diagnostics: CodeDiagnostic[] = [];
		for (const uri of uris) {
			for (const diagnostic of vscode.languages.getDiagnostics(uri)) {
				if (diagnostic.severity === vscode.DiagnosticSeverity.Error || diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
					diagnostics.push({
						file: uri.fsPath,
						line: diagnostic.range.start.line + 1,
						severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
						message: diagnostic.message,
						...diagnostic.source ? { source: diagnostic.source } : {},
					});
				}
			}
		}
		return { checked: uris.length, diagnostics };
	}

	private allowed(folder: string, file: string): Promise<boolean> {
		return this.mayRead(folder, file).catch(() => false);
	}

	/** Where the target's name is on its line, as a language server wants it; undefined when the file can't be opened. */
	private async position(target: CodeTarget): Promise<{ readonly uri: vscode.Uri; readonly position: vscode.Position } | undefined> {
		const uri = vscode.Uri.file(target.file);
		if (!await this.allowed(target.folder, target.file)) {
			return undefined;
		}
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			if (target.line < 1 || target.line > document.lineCount) {
				return undefined;
			}
			const text = document.lineAt(target.line - 1).text;
			const escaped = target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const at = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).exec(text)?.index ?? Math.max(0, text.search(/\S/));
			return { uri, position: new vscode.Position(target.line - 1, at) };
		} catch {
			return undefined;
		}
	}
}

/** `work`'s answer, or undefined when it takes longer than {@link answerMs} or fails. */
async function within<T>(work: Thenable<T>): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<undefined>(resolve => timer = setTimeout(() => resolve(undefined), answerMs));
	try {
		return await Promise.race([Promise.resolve(work).catch(() => undefined), late]);
	} finally {
		clearTimeout(timer);
	}
}

/** Waits until each of `uris` has had its diagnostics reported once, or {@link diagnosticsSettleMs} has passed. */
function settled(uris: readonly vscode.Uri[]): Promise<void> {
	const waiting = new Set(uris.filter(uri => !vscode.languages.getDiagnostics(uri).length).map(uri => uri.toString()));
	if (!waiting.size) {
		return Promise.resolve();
	}
	return new Promise(resolve => {
		const done = () => {
			clearTimeout(timer);
			listener.dispose();
			resolve();
		};
		const timer = setTimeout(done, diagnosticsSettleMs);
		const listener = vscode.languages.onDidChangeDiagnostics(event => {
			for (const uri of event.uris) {
				waiting.delete(uri.toString());
			}
			if (!waiting.size) {
				done();
			}
		});
	});
}

/** A file's lines, from its open document when there is one (it may not be saved), else from the file. */
async function linesOf(file: string): Promise<readonly string[] | undefined> {
	const open = vscode.workspace.textDocuments.find(document => document.uri.scheme === 'file' && document.uri.fsPath === file);
	if (open) {
		return open.getText().split(/\r?\n/);
	}
	return fs.readFile(file, 'utf8').then(text => text.split(/\r?\n/), () => undefined);
}
