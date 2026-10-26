/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the composer attaches: files picked or dropped, context from the Add
// to Chat commands (held until the view is ready), the @-mention picker's
// groups (files, the folders they are in, symbols from the workspace index,
// and the Workspace rows: the Problems list, the uncommitted changes and the
// last terminal command with its output), and chips for the Jira tickets,
// GitLab items and Figma frames it names.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Attachment } from '../../acp/attachments';
import { diffAgainstHead } from '../../acp/commitMessage';
import { changedFileCount, countProblems, foldersOf, type Problem, problemsReport, symbolLines } from '../../acp/mentions';
import { commandAttachment } from '../../acp/runCommands';
import { git } from '../../acp/worktrees';
import { attachmentsForFiles } from '../addToChat';
import type { FromWebview, ToWebview, ViewMention } from '../chatProtocol';
import type { ChatControllerOptions, FileSearch } from './chatOptions';

export type AttachmentMessage = Extract<FromWebview, { readonly type: 'pickFiles' | 'attachUris' | 'searchFiles' | 'resolveToolRef' | 'openToolRef' | 'pickToolItem' | 'attachMention' }>;

/** Rows of each @ picker group: files, the folders they are in, and symbols. */
const shownFiles = 20;
const shownFolders = 5;
const shownSymbols = 5;
/** How long the picker waits for the index's symbols before showing the rest without them. */
const symbolsWaitMs = 300;
/** How long the count of uncommitted files is reused while the user types. */
const changesFreshMs = 10_000;

export class ChatAttachments implements vscode.Disposable {

	/** Attachments from the Add to Chat commands that arrived before the view was ready. */
	private pending: Attachment[] = [];
	private readonly disposables: vscode.Disposable[] = [];
	private changes: { readonly folder: string; readonly at: number; readonly count: Promise<number> } | undefined;

	constructor(
		private readonly fileIndex: FileSearch,
		private readonly options: Pick<ChatControllerOptions, 'toolChips' | 'workspace' | 'reveal' | 'symbols' | 'terminal'>,
		/** The folder the agent works in, whose problems, changes and folders the picker offers. */
		private readonly folder: () => string,
		/** Whether a webview shows the chat. */
		private readonly isAttached: () => boolean,
		/** Whether the view's script has said it is ready. */
		isViewReady: () => boolean,
		private readonly post: (message: ToWebview) => void,
	) {
		const toolChips = options.toolChips?.();
		if (toolChips) {
			this.disposables.push(toolChips.onDidChange(() => isViewReady() && void this.postToolRefs()));
		}
	}

	/** Adds context to the composer (Add File / Add Selection to Chat), showing the chat first. */
	async add(attachments: readonly Attachment[]): Promise<void> {
		if (!attachments.length) {
			return;
		}
		if (this.isAttached()) {
			this.post({ type: 'attach', attachments });
		} else {
			this.pending.push(...attachments);
		}
		// Focus the chat, so the user can type about what they just added.
		await this.options.reveal(false);
	}

	/** The view loaded: gives it what was added meanwhile. */
	postPending(): void {
		if (this.pending.length) {
			this.post({ type: 'attach', attachments: this.pending });
			this.pending = [];
		}
	}

	/** Tells the view which tools are connected, so it can turn tickets and links into chips. */
	async postToolRefs(): Promise<void> {
		const chips = this.options.toolChips?.();
		const context = chips ? await chips.context(this.options.workspace?.()?.cwd).catch(() => undefined) : undefined;
		this.post({ type: 'toolRefs', context: context ?? { connected: [] } });
	}

	onMessage(message: AttachmentMessage): void {
		switch (message.type) {
			case 'pickFiles':
				void this.pickFiles();
				break;
			case 'resolveToolRef': {
				const chips = this.options.toolChips?.();
				void chips?.resolve(message.ref).then(attachment => this.post({ type: 'toolRefResolved', attachment }));
				break;
			}
			case 'openToolRef':
				void this.options.toolChips?.()?.open(message.ref);
				break;
			case 'pickToolItem': {
				const chips = this.options.toolChips?.();
				void chips?.pick(message.tool).then(ref => {
					if (ref) {
						this.post({ type: 'attachToolRef', ref });
					}
				});
				break;
			}
			case 'attachUris': {
				const uris = message.uris.map(uri => vscode.Uri.parse(uri)).filter(uri => uri.scheme === 'file');
				void attachmentsForFiles(uris).then(attachments => this.add(attachments));
				break;
			}
			case 'searchFiles':
				void this.search(message.requestId, typeof message.query === 'string' ? message.query : '');
				break;
			case 'attachMention':
				void this.attachMention(message.mention);
				break;
		}
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** The @ picker's rows for `query`: files, then the folders, symbols and Workspace rows. */
	private async search(requestId: number, query: string): Promise<void> {
		const files = await this.fileIndex.search(query, shownFiles * 3).catch(() => []);
		const symbols = query.trim().length >= 2 && this.options.symbols ? await this.symbolRows(query.trim()) : [];
		const mentions: ViewMention[] = [
			...foldersOf(files, query, shownFolders).map(folder => ({ kind: 'folder' as const, ...folder })),
			...symbols,
			...await this.workspaceRows(),
		];
		this.post({ type: 'files', requestId, files: files.slice(0, shownFiles), mentions });
	}

	/** Definitions from the folder's index; none when it is off, not built, or slower than the picker waits. */
	private async symbolRows(query: string): Promise<ViewMention[]> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<undefined>(resolve => timer = setTimeout(() => resolve(undefined), symbolsWaitMs));
		const found = await Promise.race([this.options.symbols!(query).catch(() => undefined), late]).finally(() => clearTimeout(timer));
		const folder = this.folder();
		return (found ?? []).slice(0, shownSymbols).map(symbol => ({
			kind: 'symbol', name: symbol.name, symbolKind: symbol.kind, path: symbol.path, line: symbol.line, endLine: symbol.endLine,
			relative: path.relative(folder, symbol.path).split(path.sep).join('/') || path.basename(symbol.path),
		}));
	}

	/** The Workspace rows that have something to send: the folder's problems, its uncommitted changes, the last terminal command. */
	private async workspaceRows(): Promise<ViewMention[]> {
		const { errors, warnings } = countProblems(this.problems());
		const changes = await this.changedFiles();
		const last = this.options.terminal?.lastCommand?.();
		return [
			...errors || warnings ? [{ kind: 'problems' as const, errors, warnings }] : [],
			...changes ? [{ kind: 'changes' as const, files: changes }] : [],
			...last ? [{ kind: 'terminal' as const, command: last.commandLine.split('\n')[0], failed: last.exitCode !== undefined && last.exitCode !== 0 }] : [],
		];
	}

	/** The Problems list's entries for files in the agent's folder. */
	private problems(): Problem[] {
		const folder = this.folder();
		return vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) => {
			const relative = path.relative(folder, uri.fsPath);
			if (uri.scheme !== 'file' || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
				return [];
			}
			return diagnostics.map(diagnostic => problemOf(uri.fsPath, diagnostic));
		});
	}

	/** How many files `git status` lists in the folder, reused for a few seconds while the user types. */
	private changedFiles(): Promise<number> {
		const folder = this.folder();
		if (this.changes?.folder !== folder || Date.now() - this.changes.at > changesFreshMs) {
			this.changes = { folder, at: Date.now(), count: git(folder, ['status', '--porcelain', '--untracked-files=all', '--', '.']).then(changedFileCount, () => 0) };
		}
		return this.changes.count;
	}

	/** A Folders, Symbols or Workspace row was picked: what it stands for goes to the composer as a chip. */
	private async attachMention(mention: ViewMention): Promise<void> {
		const folder = this.folder();
		let attachments: Attachment[] = [];
		switch (mention?.kind) {
			case 'folder':
				attachments = [{ kind: 'file', path: mention.path }];
				break;
			case 'symbol': {
				const text = await fs.readFile(mention.path, 'utf8').catch(() => undefined);
				attachments = text === undefined ? [] : [symbolLines(mention.path, text, mention.line, mention.endLine)];
				break;
			}
			case 'problems':
				attachments = [{ kind: 'document', name: vscode.l10n.t("Problems"), mimeType: 'text/plain', text: problemsReport(this.problems(), folder) }];
				break;
			case 'changes': {
				const diff = await diffAgainstHead(folder).catch(() => '');
				attachments = diff.trim() ? [{ kind: 'document', name: vscode.l10n.t("Uncommitted changes"), mimeType: 'text/plain', text: diff }] : [];
				break;
			}
			case 'terminal': {
				const last = this.options.terminal?.lastCommand?.();
				attachments = last ? [commandAttachment(last)] : [];
				break;
			}
		}
		await this.add(attachments);
	}

	/** Lets the user pick files from anywhere to attach. */
	private async pickFiles(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			canSelectFiles: true,
			canSelectFolders: false,
			openLabel: vscode.l10n.t("Attach"),
			title: vscode.l10n.t("Attach Files to Chat"),
		});
		if (uris?.length) {
			await this.add(await attachmentsForFiles(uris));
		}
	}
}

/** A diagnostic as the Problems list shows it, 1-based. */
export function problemOf(file: string, diagnostic: vscode.Diagnostic): Problem {
	const severities: readonly Problem['severity'][] = ['error', 'warning', 'info', 'hint'];
	const code = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
	return {
		file,
		severity: severities[diagnostic.severity] ?? 'error',
		line: diagnostic.range.start.line + 1,
		column: diagnostic.range.start.character + 1,
		message: diagnostic.message,
		...diagnostic.source ? { source: diagnostic.source } : {},
		...code !== undefined ? { code: String(code) } : {},
	};
}
