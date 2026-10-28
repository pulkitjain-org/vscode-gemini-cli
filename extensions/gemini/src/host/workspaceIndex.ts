/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DocsSearchResult } from '../acp/docs/docsProtocol';
import { contextPack, contextPackFiles } from '../acp/contextPack';
import type { EditorBackend } from '../acp/editorTools';
import { isInside, secretPathReason } from '../acp/fileAccess';
import { appRipgrep } from '../acp/index/ripgrepPath';
import { IndexClient } from '../acp/index/indexClient';
import type { IndexerMethod, IndexerParams, IndexerResult, IndexSettings, IndexStatus } from '../acp/index/indexerProtocol';
import { AttachedDocs, IndexMcpServer } from '../acp/indexMcp';
import { hasIndex } from '../acp/index/indexPaths';
import { configSection, indexBuildOn } from './configuration';
import { IndexWatchers } from './indexWatchers';
import { extensionChunk } from './lazyFeature';
import { isIgnoredByGitCached } from './workspaceFileSystem';

/** Where the documentation attached to folders comes from (docsSources.ts). */
export interface DocsProvider {
	attachedTo(folder: string): readonly AttachedDocs[];
	search(ids: readonly string[], query: string): Promise<DocsSearchResult>;
}

/** When an index is first built. */

/**
 * Sent with an agent's first prompt in a folder whose index is built. On a
 * large repository it took the median answer from 60 s to 36 s with Flash
 * (FINDINGS.md): without it the model goes to grep_search first.
 */
export const indexHint = 'This workspace has a code index: use the geminicode-index tools (code_search, find_symbol, related_files, repo_map) before grep_search, glob or reading whole files. Their results are complete: read only the lines they point to, and don\'t search again for what they found.';

/** An outline older than this is fetched again when the next session starts. */
const orientationMaxAgeMs = 10 * 60 * 1000;
const orientationChars = 4_000;

/**
 * The workspace index for agents: the indexer process (IndexClient), and the
 * `geminicode-index` MCP server every agent session gets while
 * `gemini.index.enabled` is on. A folder's index is built the first time an
 * agent starts there (or when the window opens, or only on request, per
 * `gemini.index.buildOn`); an agent's worktree starts from a copy of its
 * workspace's index. Nothing here reads or parses files: the process does.
 */
export class WorkspaceIndex implements vscode.Disposable {

	private readonly onDidChangeStatusEmitter = new vscode.EventEmitter<IndexStatus>();
	/** A folder's index changed state: building, built, removed. */
	readonly onDidChangeStatus = this.onDidChangeStatusEmitter.event;
	private readonly onDidChangeEnabledEmitter = new vscode.EventEmitter<boolean>();
	readonly onDidChangeEnabled = this.onDidChangeEnabledEmitter.event;

	private client: IndexClient | undefined;
	private server: IndexMcpServer | undefined;
	/** The language servers' adapter for agents' index tools, loaded the first time an agent needs it. */
	private editor: EditorBackend | undefined;
	/** Folders asked for in this window, so a restarted process picks them up again. */
	private readonly folders = new Map<string, { readonly seedFrom?: string }>();
	private readonly statuses = new Map<string, IndexStatus>();
	private readonly orientations = new Map<string, { readonly text: string; readonly at: number }>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly watchers = new IndexWatchers(this);
	docs: DocsProvider | undefined;

	constructor(private readonly options: { readonly script: string; readonly version: string; readonly log: vscode.LogOutputChannel; readonly baseDir?: string }) {
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${configSection}.index.enabled`)) {
				this.applyEnabled();
			} else if (e.affectsConfiguration(`${configSection}.index`)) {
				for (const folder of this.folders.keys()) {
					this.client?.notify('ensure', { root: folder, settings: indexSettings(folder), build: false });
				}
			}
		}));
		this.applyEnabled();
	}

	/** Whether the index is on (`gemini.index.enabled`) and served. */
	get enabled(): boolean {
		return indexEnabled() && !!this.server;
	}

	/**
	 * Whether new sessions get the index tools and the hint: on, and the
	 * indexer process hasn't given up after crashing (until its cooldown
	 * ends), so no agent is told to rely on tools that only fail.
	 */
	get available(): boolean {
		return this.enabled && !this.client?.failed;
	}

	/** The indexes' home: ~/.geminicode/index. */
	get baseDir(): string {
		return this.options.baseDir ?? path.join(os.homedir(), '.geminicode', 'index');
	}

	/** The last state heard for `folder`'s index. */
	status(folder: string): IndexStatus | undefined {
		return this.statuses.get(folder);
	}

	/**
	 * `folder`'s index as Home shows it: from what this window heard, else
	 * whether an index file exists, so nothing starts the indexer.
	 */
	async summary(folder: string): Promise<'ready' | 'building' | 'paused' | 'failed' | 'none'> {
		const state = this.statuses.get(folder)?.state;
		if (state && state.kind !== 'none') {
			return state.kind;
		}
		return !state && await hasIndex(this.baseDir, folder) ? 'ready' : 'none';
	}

	/** Asks the process for these folders' states, building none. */
	async refreshStatus(folders: readonly string[]): Promise<IndexStatus[]> {
		if (!this.client || !folders.length) {
			return folders.map(root => this.statuses.get(root) ?? { root, state: { kind: 'none' }, readOnly: false });
		}
		const statuses = await this.client.request('status', { roots: folders });
		for (const status of statuses) {
			const before = this.statuses.get(status.root);
			this.statuses.set(status.root, status);
			// Home's pill learns a folder's index from here after a restart, before any agent starts.
			if (before?.state.kind !== status.state.kind) {
				this.onDidChangeStatusEmitter.fire(status);
			}
		}
		return statuses;
	}

	/**
	 * The `mcpServers` for an agent working in `folder`, and the folder's index
	 * opened (and built, per `gemini.index.buildOn`). `seedFrom` is the
	 * workspace folder an agent's worktree was made from.
	 */
	mcpServersFor(agent: string, folder: string, seedFrom?: string): acp.McpServer[] {
		if (!this.available) {
			return [];
		}
		this.prepare(folder, seedFrom);
		const config = this.server!.configFor(agent, folder);
		return config ? [config] : [];
	}

	/** The `mcpServers` for a spare session in `folder`, which no agent has yet. */
	spareServers(folder: string): acp.McpServer[] {
		if (!this.available) {
			return [];
		}
		this.prepare(folder);
		const config = this.server!.configForSlot(folder);
		return config ? [config] : [];
	}

	/** Gives `agent` the index slot of a spare session it took. */
	bindSession(agent: string, folder: string, servers: readonly acp.McpServer[]): void {
		for (const server of servers) {
			const url = (server as { readonly url?: unknown }).url;
			if (typeof url === 'string') {
				this.server?.bind(url, agent, folder);
			}
		}
	}

	forgetAgent(agent: string): void {
		this.server?.forget(agent);
	}

	/** Whether a new session gets the index: part of a spare session's key. */
	get serving(): boolean {
		return this.available && !!this.server?.listening;
	}

	/** Opens `folder`'s index and builds it when that is due. */
	prepare(folder: string, seedFrom?: string): void {
		if (!this.client) {
			return;
		}
		const known = this.folders.has(folder);
		this.folders.set(folder, { seedFrom: seedFrom && seedFrom !== folder ? seedFrom : undefined });
		const build = indexBuildOn() !== 'manual';
		if (seedFrom && seedFrom !== folder && build && !known) {
			this.client.notify('seed', { from: seedFrom, to: folder, settings: indexSettings(folder) });
		} else {
			this.client.notify('ensure', { root: folder, settings: indexSettings(folder), build });
		}
		void this.refreshOrientation(folder);
	}

	/** Builds `folder`'s index now, whatever `gemini.index.buildOn` says. */
	build(folder: string): Promise<IndexStatus | undefined> {
		this.folders.set(folder, this.folders.get(folder) ?? {});
		return this.client?.request('ensure', { root: folder, settings: indexSettings(folder), build: true }) ?? Promise.resolve(undefined);
	}

	rebuild(folder: string): Promise<IndexStatus | undefined> {
		this.folders.set(folder, this.folders.get(folder) ?? {});
		this.orientations.delete(folder);
		return this.client?.request('rebuild', { root: folder, settings: indexSettings(folder) }) ?? Promise.resolve(undefined);
	}

	pause(folder: string): Promise<IndexStatus | undefined> {
		return this.client?.request('pause', { root: folder }) ?? Promise.resolve(undefined);
	}

	resume(folder: string): Promise<IndexStatus | undefined> {
		return this.client?.request('resume', { root: folder }) ?? Promise.resolve(undefined);
	}

	async remove(folder: string): Promise<void> {
		this.folders.delete(folder);
		this.watchers.unwatch(folder);
		this.orientations.delete(folder);
		await this.client?.request('remove', { root: folder });
	}

	skipped(folder: string): Promise<{ readonly path: string; readonly reason: string; readonly includable: boolean }[]> {
		return this.client?.request('skipped', { root: folder }) ?? Promise.resolve([]);
	}

	/**
	 * What the index knows around `files` of `folder` (their tests, users and
	 * usual companions), for the prompt of an agent that can't call the index
	 * tools, such as a merge request's reviewer; undefined without a built index.
	 */
	async contextPack(folder: string, files: readonly string[]): Promise<string | undefined> {
		const client = this.client;
		if (!client || this.statuses.get(folder)?.state.kind !== 'ready') {
			return undefined;
		}
		const shown = files.slice(0, contextPackFiles);
		const related = await Promise.all(shown.map(file => client.request('related', { root: folder, path: file }).then(answer => answer.result, () => undefined)));
		return contextPack(shown.map((file, i) => ({ file, ...related[i] ? { related: related[i] } : {} })), files.length);
	}

	/** The outline of `folder` that sessions start with, fetched now if it isn't cached; undefined without a built index. */
	async outlineOf(folder: string): Promise<string | undefined> {
		if (this.statuses.get(folder)?.state.kind !== 'ready') {
			return undefined;
		}
		await this.refreshOrientation(folder);
		return this.orientations.get(folder)?.text;
	}

	/** Every indexed file of `folder`, once its index is built; for @-mentions outside the window. */
	files(folder: string): Promise<string[] | undefined> {
		if (!this.client || !this.folders.has(folder)) {
			return Promise.resolve(undefined);
		}
		return this.client.request('files', { root: folder }).catch(() => undefined);
	}

	/** Files changed in `folder` (absolute or folder-relative paths). */
	changed(folder: string, paths: readonly string[]): void {
		if (this.client?.running && this.folders.has(folder) && paths.length) {
			this.client.notify('update', { root: folder, paths });
		}
	}

	/** `folder`'s git history moved (a checkout, a pull): compare everything again. */
	moved(folder: string): void {
		if (this.client?.running && this.folders.has(folder)) {
			this.client.notify('reconcile', { root: folder });
		}
	}

	/** An agent edited files in `folder`; only folders outside the window need telling, watchers see the rest. */
	agentEdited(folder: string, paths: readonly string[]): void {
		if (!IndexWatchers.inWindow(folder)) {
			this.changed(folder, paths);
		}
	}

	/**
	 * An agent's turn ended in `folder`: outside the window, where no watcher
	 * runs, the indexer applies what git says its commands changed.
	 */
	agentTurnEnded(folder: string): void {
		if (!IndexWatchers.inWindow(folder) && this.client?.running && this.folders.has(folder)) {
			this.client.notify('turnEnded', { root: folder });
		}
	}

	/** A request to the indexer process, such as the docs store's; undefined while the index is off. */
	async request<M extends IndexerMethod>(method: M, params: IndexerParams<M>): Promise<Awaited<IndexerResult<M>> | undefined> {
		return this.client?.request(method, params);
	}

	/** The docs attached to `folder`, or to the workspace folder its worktree came from. */
	private attachedDocs(folder: string): readonly AttachedDocs[] {
		const docs = this.docs;
		if (!docs) {
			return [];
		}
		const own = docs.attachedTo(folder);
		const from = this.folders.get(folder)?.seedFrom;
		if (!from) {
			return own;
		}
		const ids = new Set(own.map(d => d.id));
		return [...own, ...docs.attachedTo(from).filter(d => !ids.has(d.id))];
	}

	/** The note for an agent's prompt in `folder` while its index is built and agents get the tools. */
	hint(folder: string): string | undefined {
		return this.available && this.statuses.get(folder)?.state.kind === 'ready' ? indexHint : undefined;
	}

	/** Folders whose indexes this window keeps current. */
	get openFolders(): string[] {
		return [...this.folders.keys()];
	}

	/** The repo map and best chunks for a draft prompt, for the prompt enhancer; undefined without a built index. */
	async contextFor(folder: string, draft: string): Promise<string | undefined> {
		if (!this.client || !this.folders.has(folder) || this.statuses.get(folder)?.state.kind !== 'ready') {
			return undefined;
		}
		try {
			const answer = await this.client.request('search', { root: folder, query: { query: draft, limit: 3 } });
			const outline = this.orientations.get(folder)?.text;
			const hits = answer.result.hits.map(hit => `${hit.path}:${hit.startLine}-${hit.endLine}${hit.symbol ? ` (${hit.symbol})` : ''}`);
			return [outline ? `Outline:\n${outline.slice(0, 1_500)}` : '', hits.length ? `Code that may be relevant:\n${hits.join('\n')}` : ''].filter(Boolean).join('\n\n') || undefined;
		} catch {
			return undefined;
		}
	}

	dispose(): void {
		this.stop();
		this.watchers.dispose();
		this.onDidChangeStatusEmitter.dispose();
		this.onDidChangeEnabledEmitter.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private applyEnabled(): void {
		if (indexEnabled()) {
			this.startServing();
		} else {
			this.stop();
		}
		this.onDidChangeEnabledEmitter.fire(this.enabled);
	}

	private startServing(): void {
		if (this.client) {
			return;
		}
		const client = this.client = new IndexClient({
			script: this.options.script,
			execPath: process.execPath,
			baseDir: this.baseDir,
			ripgrep: appRipgrep(vscode.env.appRoot),
			log: message => this.options.log.info(message),
		});
		client.onDidChangeStatus(status => {
			this.statuses.set(status.root, status);
			if (status.state.kind === 'ready') {
				void this.refreshOrientation(status.root, true);
			}
			if (status.state.kind === 'none') {
				this.watchers.unwatch(status.root);
			} else if (this.folders.has(status.root)) {
				this.watchers.watch(status.root);
			}
			this.onDidChangeStatusEmitter.fire(status);
		});
		// Sessions started from now on go with or without the index; spare ones are opened again to match.
		client.onDidChangeFailed(() => this.onDidChangeEnabledEmitter.fire(this.enabled));
		client.onDidStart(() => {
			// A new process knows no folders; the ones this window keeps current are opened again.
			for (const folder of this.folders.keys()) {
				client.notify('ensure', { root: folder, settings: indexSettings(folder), build: false });
			}
		});
		const server = this.server = new IndexMcpServer({
			search: (folder, query) => client.request('search', { root: folder, query }),
			findSymbol: (folder, name, kind, references) => client.request('findSymbol', { root: folder, name, kind, references }),
			related: (folder, file) => client.request('related', { root: folder, path: file }),
			repoMap: (folder, subfolder, depth) => client.request('repoMap', { root: folder, path: subfolder, depth }),
			docs: folder => this.attachedDocs(folder),
			searchDocs: (_folder, ids, query) => this.docs?.search(ids, query) ?? Promise.resolve({ hits: [], total: 0, terms: [] }),
			orientation: folder => this.orientations.get(folder)?.text,
			languageServers: languageServersOn,
			// The language servers' adapter loads the first time an agent needs one (dist/onDemand.js).
			editor: async () => languageServersOn() ? this.editor ??= new (extensionChunk<typeof import('../onDemand')>('onDemand')().EditorToolsHost)(
				async (folder, file) => isInside(folder, file) && !secretPathReason(file) && !await isIgnoredByGitCached(file)) : undefined,
		}, this.options.version);
		server.start().catch(err => this.options.log.error(`The index server failed to start: ${err instanceof Error ? err.message : String(err)}`));
		if (indexBuildOn() === 'workspaceOpen') {
			for (const folder of vscode.workspace.workspaceFolders ?? []) {
				if (folder.uri.scheme === 'file') {
					this.prepare(folder.uri.fsPath);
				}
			}
		}
	}

	private stop(): void {
		for (const folder of this.folders.keys()) {
			this.watchers.unwatch(folder);
		}
		this.server?.dispose();
		this.server = undefined;
		this.client?.dispose();
		this.client = undefined;
	}

	/** Fetches the outline sessions get with the server's instructions, unless a recent one is cached. */
	private async refreshOrientation(folder: string, force = false): Promise<void> {
		const cached = this.orientations.get(folder);
		if (!this.client || (!force && cached && Date.now() - cached.at < orientationMaxAgeMs)) {
			return;
		}
		try {
			const answer = await this.client.request('repoMap', { root: folder, maxChars: orientationChars });
			if (!answer.fallback) {
				this.orientations.set(folder, { text: answer.result, at: Date.now() });
			}
		} catch {
			// Sessions start without an outline.
		}
	}
}

/** Whether agents' index tools also ask the editor's language servers (`gemini.index.languageServers`). */
function languageServersOn(): boolean {
	return vscode.workspace.getConfiguration(configSection).get<boolean>('index.languageServers', true);
}

export function indexEnabled(): boolean {
	return vscode.workspace.getConfiguration(configSection).get<boolean>('index.enabled', true);
}


/** The index settings for `folder`: `exclude` and `include` can differ per workspace folder. */
export function indexSettings(folder: string): IndexSettings {
	const config = vscode.workspace.getConfiguration(configSection, vscode.Uri.file(folder));
	const patterns = (key: string) => {
		const value = config.get<unknown>(key, []);
		return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string' && !!p.trim()) : [];
	};
	const maxKb = config.get<number>('index.maxFileSizeKb', 1024);
	return {
		exclude: patterns('index.exclude'),
		include: patterns('index.include'),
		maxFileBytes: Math.max(16, Math.min(Number.isFinite(maxKb) ? maxKb : 1024, 16 * 1024)) * 1024,
	};
}
