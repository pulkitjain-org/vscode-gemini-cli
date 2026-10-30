/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// An agent's Files page, opened from the Files link of its chat's side
// column, in the agent's side group: a search, New File and the files
// recently opened here, beside the agent's folder as a tree. A file opens as
// an editor in the side group, and the page moves beside it in a narrow
// group of its own, showing only its tree (the workbench's
// geminiAgentGroups.ts); closing the file brings the page back whole. In
// dist/pages.js, loaded the first time a Files page opens: what it needs of
// the agents comes through `AgentFilesHost`.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { fileIcon, sortEntries, withRecent, type TreeEntry } from '../acp/agentFiles';
import { git } from '../acp/worktrees';
import type { FileRow, FilesStrings, FromFiles, ToFiles } from './agentFilesProtocol';
import { PagePanel, PageShell } from './pagePanel';

/** What an agent's Files page needs of the agents. */
export interface AgentFilesHost {
	readonly extensionUri: vscode.Uri;
	/** Where each agent's recent files are kept. */
	readonly state: vscode.Memento;
	/** The folder the agent works in; undefined once it is gone. */
	folder(agentId: string): string | undefined;
	/** The agent's side column, where its files open. */
	column(agentId: string): Promise<vscode.ViewColumn>;
	/** Files named like `query` in the agent's folder, best first. */
	search(agentId: string, query: string, limit: number): Promise<readonly { readonly path: string }[]>;
}

/** The most search results the page lists. */
const shownMatches = 30;
/** A folder with more entries than this is listed without asking git which are ignored. */
const maxIgnoreCheck = 400;

export class AgentFilesPages implements vscode.Disposable {

	/** Each agent's page, so the Files link shows the same one again. */
	private readonly pages = new Map<string, AgentFilesPage>();

	constructor(private readonly host: AgentFilesHost) { }

	/** Opens `agentId`'s Files page in its side group, or shows it again. */
	async open(agentId: string): Promise<void> {
		const folder = this.host.folder(agentId);
		if (!folder) {
			return;
		}
		const open = this.pages.get(agentId);
		if (open) {
			open.reveal();
			return;
		}
		const page = new AgentFilesPage(this.host, agentId, folder, await this.host.column(agentId));
		this.pages.set(agentId, page);
		page.onDidDispose(() => this.pages.delete(agentId));
	}

	/** Closes `agentId`'s page, when the agent goes. */
	close(agentId: string): void {
		this.pages.get(agentId)?.dispose();
	}

	dispose(): void {
		for (const page of [...this.pages.values()]) {
			page.dispose();
		}
		this.pages.clear();
	}
}

class AgentFilesPage implements vscode.Disposable {

	private readonly page: PagePanel<ToFiles, FromFiles>;
	private readonly disposables: vscode.Disposable[] = [];
	readonly onDidDispose: vscode.Event<void>;
	private readonly recentsKey: string;
	/** Folders whose entries changed since the page was last told, sent together. */
	private readonly changed = new Set<string>();
	private changedTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly host: AgentFilesHost, private readonly agentId: string, private readonly folder: string, column: vscode.ViewColumn) {
		this.recentsKey = `gemini.agentFiles.recents.${agentId}`;
		this.page = new PagePanel<ToFiles, FromFiles>(host.extensionUri, { viewType: 'gemini.agentFiles', title: vscode.l10n.t("Files"), icon: new vscode.ThemeIcon('files'), column: { viewColumn: column, preserveFocus: false }, retainContextWhenHidden: true }, this.shell(), message => this.onMessage(message));
		this.onDidDispose = this.page.onDidDispose;
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), '**/*'), false, true, false);
		this.disposables.push(
			watcher,
			watcher.onDidCreate(uri => this.folderChanged(uri)),
			watcher.onDidDelete(uri => this.folderChanged(uri)),
			this.page.onDidDispose(() => {
				clearTimeout(this.changedTimer);
				vscode.Disposable.from(...this.disposables).dispose();
			}),
		);
	}

	reveal(): void {
		this.page.reveal();
	}

	dispose(): void {
		this.page.dispose();
	}

	private post(message: ToFiles): void {
		this.page.post(message);
	}

	private async onMessage(message: FromFiles): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.postView();
				this.post({ type: 'entries', folder: this.folder, entries: await this.entries(this.folder, false) });
				break;
			case 'list':
				if (this.inside(message.folder)) {
					this.post({ type: 'entries', folder: message.folder, entries: await this.entries(message.folder, message.ignored === true) });
				}
				break;
			case 'open':
				if (this.inside(message.path)) {
					await this.openFile(message.path);
				}
				break;
			case 'search': {
				const found = message.query.trim() ? await this.host.search(this.agentId, message.query, shownMatches).catch(() => []) : [];
				this.post({ type: 'found', requestId: message.requestId, files: found.filter(file => this.inside(file.path)).map(file => this.row(file.path)) });
				break;
			}
			case 'newFile':
				await this.newFile();
				break;
			case 'close':
				this.dispose();
				break;
		}
	}

	private postView(): void {
		const recents = this.host.state.get<string[]>(this.recentsKey, []).filter(file => this.inside(file));
		this.post({ type: 'view', view: { root: { name: path.basename(this.folder), path: this.folder }, recents: recents.map(file => this.row(file)) } });
	}

	/** Whether `target` is the agent's folder or inside it: the page lists and opens nothing else. */
	private inside(target: string): boolean {
		const relative = path.relative(this.folder, target);
		return !relative.startsWith('..') && !path.isAbsolute(relative);
	}

	private row(file: string): FileRow {
		const folder = path.relative(this.folder, path.dirname(file)).split(path.sep).join('/');
		return { path: file, name: path.basename(file), folder, icon: fileIcon(path.basename(file)) };
	}

	/** `folder`'s entries, folders first; everything in an ignored folder is ignored too. */
	private async entries(folder: string, ignored: boolean): Promise<TreeEntry[]> {
		const listed = await vscode.workspace.fs.readDirectory(vscode.Uri.file(folder)).then(undefined, () => [] as [string, vscode.FileType][]);
		const entries = listed.filter(([name]) => name !== '.git').map(([name, type]) => ({ name, path: path.join(folder, name), folder: (type & vscode.FileType.Directory) !== 0 }));
		const ignoredPaths = ignored ? new Set(entries.map(entry => entry.path)) : await this.ignoredOf(folder, entries.map(entry => entry.name));
		return sortEntries(entries.map(entry => ({ ...entry, ignored: ignoredPaths.has(entry.path) })));
	}

	/** Which of `names` in `folder` git ignores; none outside a repository or in a very large folder. */
	private async ignoredOf(folder: string, names: readonly string[]): Promise<Set<string>> {
		if (!names.length || names.length > maxIgnoreCheck) {
			return new Set();
		}
		// Exit status 1 means none is ignored, which git() reports as an error.
		const out = await git(folder, ['check-ignore', '--', ...names]).catch(() => '');
		return new Set(out.split('\n').filter(Boolean).map(name => path.join(folder, name)));
	}

	private async openFile(file: string): Promise<void> {
		const column = await this.host.column(this.agentId);
		await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { viewColumn: column, preview: false });
		// The page moves beside the file, its tree alone; outside GeminiCode it stays a tab behind it.
		await vscode.commands.executeCommand('_gemini.agentFilesBeside', this.agentId).then(undefined, () => undefined);
		await this.host.state.update(this.recentsKey, withRecent(this.host.state.get<string[]>(this.recentsKey, []), file));
		this.postView();
	}

	private async newFile(): Promise<void> {
		const name = await vscode.window.showInputBox({
			title: vscode.l10n.t("New File"),
			prompt: vscode.l10n.t("A path in {0}", path.basename(this.folder)),
			validateInput: value => {
				const target = path.resolve(this.folder, value.trim());
				return !value.trim() ? undefined : this.inside(target) && target !== this.folder ? undefined : vscode.l10n.t("The file must be inside {0}.", path.basename(this.folder));
			},
		});
		if (!name?.trim()) {
			return;
		}
		const file = vscode.Uri.file(path.resolve(this.folder, name.trim()));
		const exists = await vscode.workspace.fs.stat(file).then(() => true, () => false);
		if (!exists) {
			await vscode.workspace.fs.writeFile(file, new Uint8Array());
		}
		await this.openFile(file.fsPath);
	}

	private folderChanged(uri: vscode.Uri): void {
		this.changed.add(path.dirname(uri.fsPath));
		this.changedTimer ??= setTimeout(() => {
			this.changedTimer = undefined;
			const folders = [...this.changed];
			this.changed.clear();
			this.post({ type: 'changed', folders });
		}, 300);
	}

	private shell(): PageShell {
		return { script: 'agentFiles.js', styles: ['agentFiles.css'], title: vscode.l10n.t("Files"), bodyClass: 'files-page', strings: filesStrings() };
	}
}

function filesStrings(): FilesStrings {
	return {
		search: vscode.l10n.t("Files, folders..."),
		newFile: vscode.l10n.t("New File"),
		recents: vscode.l10n.t("Recents"),
		noRecents: vscode.l10n.t("Files you open here show up here."),
		noMatches: vscode.l10n.t("No matching files"),
		hideTree: vscode.l10n.t("Hide the folder tree"),
		showTree: vscode.l10n.t("Show the folder tree"),
		closeTree: vscode.l10n.t("Close the folder tree"),
		tree: vscode.l10n.t("Folder tree"),
		emptyFolder: vscode.l10n.t("Empty folder"),
	};
}
