/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CodeCall, CodeDiagnostic, CodeLocation, CodeTarget, EditorBackend } from '../acp/editorTools';
import { changedSince, gitHead } from '../acp/index/gitChanges';

/** How long a read waits for a language server; a cold one loading a large project answers later, and the index answers meanwhile. */
const answerMs = 8_000;
/** How long a hover that came back empty waits before it is asked once more. */
const retryMs = 2_500;
/** How long a file just opened waits for its first diagnostics. */
const diagnosticsSettleMs = 6_000;
/** How long the reports must go quiet before a file's diagnostics count as complete. */
const diagnosticsQuietMs = 1_500;
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
		const ask = async () => (await within(vscode.commands.executeCommand<vscode.Hover[] | undefined>('vscode.executeHoverProvider', position.uri, position.position)) ?? [])
			.flatMap(hover => hover.contents.map(content => typeof content === 'string' ? content : content.value)).filter(text => text.trim()).join('\n\n');
		// A language server still starting answers with nothing: ask once more after a moment, then let the index answer.
		const text = await ask() || await new Promise(resolve => setTimeout(resolve, retryMs)).then(ask);
		return text || undefined;
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
		const wanted = files ?? await changedFiles(folder);
		const allowed: string[] = [];
		for (const file of wanted) {
			if (allowed.length < maxFiles && await this.allowed(folder, file) && await fs.stat(file).then(stat => stat.isFile(), () => false)) {
				allowed.push(file);
			}
		}
		const uris = allowed.map(file => vscode.Uri.file(file));
		// Opening a file, without showing it, is what makes most language servers check it.
		await Promise.all(uris.map(uri => Promise.resolve(vscode.workspace.openTextDocument(uri)).catch(() => undefined)));
		// TypeScript checks only files shown in a tab, so it is asked for a file's diagnostics outright.
		const typescript = await Promise.all(uris.map(uri => typescriptFile.test(uri.fsPath) ? typescriptDiagnostics(uri) : Promise.resolve(undefined)));
		await settled(uris.filter((_, i) => !typescript[i]));
		const diagnostics: CodeDiagnostic[] = [];
		uris.forEach((uri, i) => {
			const found = typescript[i] ?? vscode.languages.getDiagnostics(uri).flatMap(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Error || diagnostic.severity === vscode.DiagnosticSeverity.Warning ? [{
				file: uri.fsPath,
				line: diagnostic.range.start.line + 1,
				severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error' as const : 'warning' as const,
				message: diagnostic.message,
				...diagnostic.source ? { source: diagnostic.source } : {},
			}] : []);
			diagnostics.push(...found);
		});
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

/**
 * The folder's files with uncommitted changes, under `folder` as it was given:
 * git names them from the repository's real path, which differs when the
 * folder was opened through a link (such as /tmp, which is /private/tmp).
 */
async function changedFiles(folder: string): Promise<string[]> {
	const changed = (await changedSince(folder, await gitHead(folder)))?.paths ?? [];
	const real = await fs.realpath(folder).catch(() => folder);
	return changed.flatMap(file => {
		const relative = path.relative(real, file);
		return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? [path.join(folder, relative)] : [];
	});
}

/** The files TypeScript's language server checks. */
const typescriptFile = /\.(?:[cm]?[jt]sx?)$/i;

/** One diagnostic as TypeScript's server reports it. */
interface TsDiagnostic {
	readonly start?: { readonly line: number };
	readonly text?: string;
	readonly category?: string;
	readonly code?: number;
}

/**
 * A TypeScript or JavaScript file's errors and warnings, straight from
 * TypeScript's server through its extension's read-only request command;
 * undefined when the extension isn't there or doesn't answer in time, and the
 * editor's diagnostics are used instead.
 */
async function typescriptDiagnostics(uri: vscode.Uri): Promise<CodeDiagnostic[] | undefined> {
	const ask = (command: string) => within(vscode.commands.executeCommand<{ readonly body?: readonly TsDiagnostic[] } | undefined>('typescript.tsserverRequest', command, { file: uri }));
	const [syntax, semantic] = await Promise.all([ask('syntacticDiagnosticsSync'), ask('semanticDiagnosticsSync')]);
	if (!Array.isArray(syntax?.body) || !Array.isArray(semantic?.body)) {
		return undefined;
	}
	return [...syntax.body, ...semantic.body].flatMap(diagnostic => diagnostic.category === 'error' || diagnostic.category === 'warning' ? [{
		file: uri.fsPath,
		line: diagnostic.start?.line ?? 1,
		severity: diagnostic.category,
		message: diagnostic.text ?? '',
		source: diagnostic.code ? `ts(${diagnostic.code})` : 'ts',
	}] : []);
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

/**
 * Waits until each of `uris` has had its diagnostics reported and the reports
 * have gone quiet for {@link diagnosticsQuietMs}, or {@link diagnosticsSettleMs}
 * has passed. A language server reports in passes (TypeScript sends its
 * syntax pass, often empty, before its type check), so the first report is
 * not the last.
 */
function settled(uris: readonly vscode.Uri[]): Promise<void> {
	const waiting = new Set(uris.filter(uri => !vscode.languages.getDiagnostics(uri).length).map(uri => uri.toString()));
	const watched = new Set(uris.map(uri => uri.toString()));
	return new Promise(resolve => {
		let quiet: ReturnType<typeof setTimeout> | undefined;
		const done = () => {
			clearTimeout(limit);
			clearTimeout(quiet);
			listener.dispose();
			resolve();
		};
		const limit = setTimeout(done, diagnosticsSettleMs);
		const rest = () => {
			clearTimeout(quiet);
			quiet = setTimeout(() => !waiting.size && done(), diagnosticsQuietMs);
		};
		const listener = vscode.languages.onDidChangeDiagnostics(event => {
			const ours = event.uris.filter(uri => watched.has(uri.toString()));
			for (const uri of ours) {
				waiting.delete(uri.toString());
			}
			if (ours.length) {
				rest();
			}
		});
		rest();
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
