/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The indexer: what runs in the indexer process (src/indexer.ts), one
// instance serving every folder this window indexes. Each folder's index is
// its own SQLite file under <base>/code/<id of the folder's real path>, so
// folders, worktrees and windows never share or overwrite one another's.
//
// Work runs one folder job at a time, in short slices with a yield between
// them, so queries are answered while a build runs. A build reads each
// file, and skips the parse when its hash is unchanged: reconciling after a
// branch switch or seeding a worktree from its repository's index costs a
// read per file, not a rebuild.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isInside } from '../fileAccess';
import { GitIgnoreChecker } from '../gitIgnore';
import { cochangePairs } from './cochange';
import { fallbackRepoMap, PathFilter, ripgrepDefinitions, ripgrepSearch } from './fallbackSearch';
import { changedSince, gitHead } from './gitChanges';
import { IndexLock } from './indexLock';
import { workspaceId } from './indexPaths';
import { IndexStore, isCorruption, moveAside } from './indexStore';
import type { Answer, IndexSettings, IndexState, IndexStatus } from './indexerProtocol';
import { canInclude, InventoryFile, SkipRules, statInFolder, takeInventory } from './inventory';
import { languageName } from './languages';
import { parseFile } from './parse';
import { filesNamed, findSymbol, hasFile, relatedFiles, RelatedResult, search, SearchQuery, SearchResult, SymbolResult } from './query';
import { repoMap } from './repoMap';
import { KnownFiles, resolveImport } from './resolve';

export interface IndexerOptions {
	/** Where indexes live: ~/.geminicode/index. */
	readonly baseDir: string;
	readonly ripgrep?: string;
	readonly onStatus?: (status: IndexStatus) => void;
	readonly onIdle?: (idle: boolean) => void;
	readonly log?: (message: string) => void;
	readonly now?: () => number;
}

/** A slice of work runs this long before yielding to queries. */
const sliceMs = 40;
/** Files read at once. */
const readBatch = 48;
/** Status events during a build, at most this often. */
const statusEveryMs = 500;
/** An index no window used for this long is deleted. */
const unusedMs = 30 * 24 * 60 * 60 * 1000;
/** Skipped files kept for the Index page. */
const maxSkippedKept = 2_000;
/** More changed paths than this at once are handled by reconciling the whole folder. */
const maxPathsPerUpdate = 300;
/** The most paths the @-mention list gets from an index. */
const maxListedFiles = 50_000;
/** A folder's index nobody asked anything of for this long is closed, until it is needed again. */
const idleCloseMs = 10 * 60 * 1000;
/** After an index failed to open (busy, disk full), it is tried again this long after. */
const reopenAfterMs = 30_000;
const defaultSettings: IndexSettings = { exclude: [], maxFileBytes: 1024 * 1024 };

interface Workspace {
	readonly root: string;
	readonly dir: string;
	readonly file: string;
	settings: IndexSettings;
	store: IndexStore | undefined;
	lock: IndexLock | undefined;
	state: IndexState;
	/** Paths to look at again, folder-relative. */
	readonly pending: Set<string>;
	needsReconcile: boolean;
	paused: boolean;
	running: Promise<void> | undefined;
	opening: Promise<void> | undefined;
	known: Known | undefined;
	rules: SkipRules | undefined;
	lastStatusAt: number;
	skipped: { path: string; reason: string }[];
	/** The folder's real path, for telling where links lead. */
	realRoot: string | undefined;
	/** The window wants this index kept current: it was opened to build or read. */
	wanted: boolean;
	/** Closed for being idle, not for a failure: nothing was missed meanwhile, since changes reopen it. */
	evicted: boolean;
	/** When a request last touched it, for closing idle ones. */
	usedAt: number;
	/** The commit the last turn-end update looked from. */
	turnHead: string | undefined;
	reopenTimer: ReturnType<typeof setTimeout> | undefined;
}

/** The folder's files for import resolution: a set, and paths by file name. */
class Known implements KnownFiles {
	private readonly paths = new Set<string>();
	private readonly byName = new Map<string, string[]>();

	constructor(paths: Iterable<string>) {
		for (const p of paths) {
			this.add(p);
		}
	}

	has(relative: string): boolean {
		return this.paths.has(relative);
	}

	named(base: string): readonly string[] {
		return this.byName.get(base) ?? [];
	}

	/** Adds a file; whether it is new. */
	add(relative: string): boolean {
		if (this.paths.has(relative)) {
			return false;
		}
		this.paths.add(relative);
		const base = relative.slice(relative.lastIndexOf('/') + 1);
		const list = this.byName.get(base);
		if (list) {
			list.push(relative);
		} else {
			this.byName.set(base, [relative]);
		}
		return true;
	}

	delete(relative: string): void {
		if (this.paths.delete(relative)) {
			const base = relative.slice(relative.lastIndexOf('/') + 1);
			this.byName.set(base, (this.byName.get(base) ?? []).filter(p => p !== relative));
		}
	}
}

export { workspaceId };

async function exists(file: string): Promise<boolean> {
	return fs.access(file).then(() => true, () => false);
}

export class Indexer {

	private readonly workspaces = new Map<string, Promise<Workspace>>();
	private readonly ignored = new GitIgnoreChecker();
	private readonly now: () => number;
	private busy = 0;
	private readonly idleTimer: ReturnType<typeof setInterval>;

	constructor(private readonly options: IndexerOptions) {
		this.now = options.now ?? Date.now;
		this.idleTimer = setInterval(() => void this.closeIdle(), 60_000);
		this.idleTimer.unref?.();
	}

	// --- Folder lifecycle

	/** Opens `root`'s index when it has one (reconciling it), or starts building one when `build`. */
	async ensure({ root, settings, build }: { root: string; settings: IndexSettings; build: boolean }): Promise<IndexStatus> {
		const workspace = await this.workspace(root, settings);
		if (!workspace.store) {
			if (build || workspace.wanted || await exists(workspace.file)) {
				workspace.wanted = true;
				await this.open(workspace);
				workspace.needsReconcile = true;
			}
		} else if (workspace.state.kind === 'failed') {
			workspace.needsReconcile = true;
		}
		await this.touchUsed(workspace);
		this.schedule(workspace);
		return this.statusOf(workspace);
	}

	async update({ root, paths }: { root: string; paths: readonly string[] }): Promise<void> {
		const workspace = await this.reopened(root);
		if (!workspace) {
			return;
		}
		for (const absoluteOrRelative of paths) {
			const relative = relativeTo(workspace.root, absoluteOrRelative);
			if (relative === undefined) {
				continue;
			}
			if (relative === '.geminiignore' || relative === '.gitignore' || relative.endsWith('/.gitignore')) {
				workspace.rules = undefined;
				workspace.needsReconcile = true;
			}
			workspace.pending.add(relative);
		}
		this.schedule(workspace);
	}

	async reconcile({ root }: { root: string }): Promise<void> {
		const workspace = await this.reopened(root);
		if (workspace) {
			workspace.needsReconcile = true;
			this.schedule(workspace);
		}
	}

	/**
	 * An agent's turn ended in `root`, a folder no watcher sees: applies what
	 * git says changed (the worktree's changes and the commits since the last
	 * look), or reconciles when that is many files or git can't tell.
	 */
	async turnEnded({ root }: { root: string }): Promise<void> {
		const workspace = await this.reopened(root);
		if (!workspace) {
			return;
		}
		const since = workspace.turnHead ?? workspace.store?.meta('head');
		const changes = await changedSince(root, since);
		if (!changes || changes.paths.length > maxPathsPerUpdate) {
			workspace.needsReconcile = true;
		} else {
			for (const file of changes.paths) {
				const relative = relativeTo(workspace.root, file);
				if (relative !== undefined) {
					workspace.pending.add(relative);
				}
			}
		}
		workspace.turnHead = changes?.head;
		this.schedule(workspace);
	}

	async rebuild({ root, settings }: { root: string; settings: IndexSettings }): Promise<IndexStatus> {
		const workspace = await this.workspace(root, settings);
		await this.closeStore(workspace);
		await fs.rm(workspace.dir, { recursive: true, force: true });
		workspace.state = { kind: 'none' };
		workspace.paused = false;
		return this.ensure({ root, settings, build: true });
	}

	async pause({ root }: { root: string }): Promise<IndexStatus> {
		const workspace = await this.workspaces.get(root);
		if (!workspace) {
			return { root, state: { kind: 'none' }, readOnly: false };
		}
		workspace.paused = true;
		if (workspace.state.kind === 'building') {
			this.setState(workspace, { kind: 'paused', done: workspace.state.done, total: workspace.state.total }, true);
		}
		return this.statusOf(workspace);
	}

	async resume({ root }: { root: string }): Promise<IndexStatus> {
		const workspace = await this.workspaces.get(root);
		if (!workspace) {
			return { root, state: { kind: 'none' }, readOnly: false };
		}
		workspace.paused = false;
		workspace.needsReconcile = true;
		this.schedule(workspace);
		return this.statusOf(workspace);
	}

	async remove({ root }: { root: string }): Promise<void> {
		const workspace = await this.workspaces.get(root);
		const dir = workspace?.dir ?? path.join(this.options.baseDir, 'code', await workspaceId(root));
		if (workspace) {
			workspace.paused = true;
			workspace.wanted = false;
			clearTimeout(workspace.reopenTimer);
			await this.closeStore(workspace);
			this.workspaces.delete(root);
		}
		await fs.rm(dir, { recursive: true, force: true });
		this.options.onStatus?.({ root, state: { kind: 'none' }, readOnly: false });
	}

	/**
	 * Starts `to`'s index (a new worktree) as a copy of `from`'s (its
	 * repository's folder), then reconciles it: only files that differ are
	 * parsed again.
	 */
	async seed({ from, to, settings }: { from: string; to: string; settings: IndexSettings }): Promise<IndexStatus> {
		const target = await this.workspace(to, settings);
		if (!target.store && !await exists(target.file)) {
			const source = (await this.workspaces.get(from))?.store;
			const sourceFile = path.join(this.options.baseDir, 'code', await workspaceId(from), 'index.db');
			try {
				await fs.mkdir(target.dir, { recursive: true });
				if (source) {
					await source.copyTo(target.file);
				} else if (await exists(sourceFile)) {
					const copy = await IndexStore.open(sourceFile, { readOnly: true });
					try {
						await copy.copyTo(target.file);
					} finally {
						copy.close();
					}
				}
			} catch (err) {
				this.options.log?.(`Could not copy the index of ${from}: ${err instanceof Error ? err.message : String(err)}`);
				await fs.rm(target.file, { force: true });
			}
		}
		return this.ensure({ root: to, settings, build: true });
	}

	async status({ roots }: { roots: readonly string[] }): Promise<IndexStatus[]> {
		return Promise.all(roots.map(async root => {
			const workspace = await this.workspaces.get(root);
			if (workspace) {
				return this.statusOf(workspace);
			}
			const file = path.join(this.options.baseDir, 'code', await workspaceId(root), 'index.db');
			if (!await exists(file)) {
				return { root, state: { kind: 'none' }, readOnly: false } satisfies IndexStatus;
			}
			try {
				const store = await IndexStore.open(file, { readOnly: true });
				try {
					return { root, state: await readyState(store), readOnly: false } satisfies IndexStatus;
				} finally {
					store.close();
				}
			} catch {
				return { root, state: { kind: 'none' }, readOnly: false } satisfies IndexStatus;
			}
		}));
	}

	async skipped({ root }: { root: string }): Promise<{ path: string; reason: string; includable: boolean }[]> {
		const workspace = await this.workspaces.get(root);
		if (!workspace?.store) {
			return [];
		}
		const fromContent = workspace.store.statement('SELECT path, skipped AS reason FROM files WHERE skipped IS NOT NULL ORDER BY path LIMIT 1000').all() as { path: string; reason: string }[];
		return [...workspace.skipped, ...fromContent].sort((a, b) => a.path < b.path ? -1 : 1).map(file => ({ ...file, includable: canInclude(file.path, file.reason) }));
	}

	/** Every indexed file, for the @-mention list of a folder outside the window. */
	async files({ root }: { root: string }): Promise<string[] | undefined> {
		const workspace = await this.workspaces.get(root);
		if (!workspace?.store || !built(workspace)) {
			return undefined;
		}
		workspace.usedAt = this.now();
		return (workspace.store.statement('SELECT path FROM files ORDER BY path LIMIT ?').all(maxListedFiles) as { path: string }[]).map(row => row.path);
	}

	// --- Queries

	search({ root, query }: { root: string; query: SearchQuery }): Promise<Answer<SearchResult>> {
		return this.answer(root, store => search(store, query), async () => ripgrepSearch(this.options.ripgrep, root, query.query, Math.min(query.limit ?? 8, 20), query.path, await this.shown(root)));
	}

	findSymbol({ root, name, kind, references }: { root: string; name: string; kind?: string; references?: boolean }): Promise<Answer<SymbolResult>> {
		return this.answer<SymbolResult>(root, store => findSymbol(store, name, { kind, references }), async () => {
			const found = await ripgrepDefinitions(this.options.ripgrep, root, name.slice(name.lastIndexOf('.') + 1), await this.shown(root));
			return { definitions: found.map(f => ({ name, kind: 'definition', path: f.path, line: f.line, endLine: f.line, exported: true, signature: f.text })), similar: [], references: [], referenceTotal: 0 };
		});
	}

	related({ root, path: file }: { root: string; path: string }): Promise<Answer<RelatedResult & { known: boolean; suggestions: readonly string[] }>> {
		const relative = relativeTo(root, file) ?? file;
		return this.answer(root, store => {
			const known = hasFile(store, relative);
			return { ...relatedFiles(store, relative), known, suggestions: known ? [] : filesNamed(store, relative) };
		}, async () => ({ imports: [], importedBy: [], tests: [], changedWith: [], known: false, suggestions: [] }));
	}

	repoMap({ root, path: subfolder, depth, maxChars }: { root: string; path?: string; depth?: number; maxChars?: number }): Promise<Answer<string>> {
		return this.answer(root, store => repoMap(store, root, { path: subfolder, depth, maxChars }), async () => fallbackRepoMap(root, maxChars, await this.shown(root)));
	}

	/**
	 * What live search may show of `root`: the files the index would cover,
	 * so secret files, .geminiignore and gemini.index.exclude apply before
	 * the first build as they do after it.
	 */
	private async shown(root: string): Promise<PathFilter> {
		const workspace = await this.workspaces.get(root);
		const rules = workspace ? await this.rules(workspace) : await SkipRules.forFolder(root, defaultSettings);
		return relative => !rules.pathReason(relative);
	}

	/**
	 * Answers from the folder's index when it is built, else from `fallback`
	 * (live search) with how far the build is. A damaged index is rebuilt and
	 * this answer comes from live search.
	 */
	private async answer<T>(root: string, query: (store: IndexStore) => T | Promise<T>, fallback: () => Promise<T>): Promise<Answer<T>> {
		const store = await this.queryable(root);
		if (store) {
			try {
				const result = await query(store);
				return store.meta('truncated') === '1' ? { result, partial: true } : { result };
			} catch (err) {
				if (!isCorruption(err)) {
					throw err;
				}
				await this.recover(root, err);
			}
		}
		return { result: await fallback(), fallback: await this.progress(root) };
	}

	/** Moves a damaged index aside and builds a new one. */
	private async recover(root: string, err: unknown): Promise<void> {
		const workspace = await this.workspaces.get(root);
		if (!workspace) {
			return;
		}
		this.options.log?.(`The index of ${root} is damaged and is being rebuilt: ${err instanceof Error ? err.message : String(err)}`);
		await this.closeStore(workspace);
		await moveAside(workspace.file);
		await this.open(workspace);
		workspace.needsReconcile = true;
		this.schedule(workspace);
	}

	/** Deletes indexes no window has used for 30 days, unless a live process holds them. */
	async collectUnused(): Promise<void> {
		const codeDir = path.join(this.options.baseDir, 'code');
		for (const name of await fs.readdir(codeDir).catch(() => [] as string[])) {
			const dir = path.join(codeDir, name);
			// No mark: an index from before marks, or half made; judge it by its folder.
			const used = (await fs.stat(path.join(dir, 'used')).catch(() => fs.stat(dir)).catch(() => undefined))?.mtimeMs;
			if (used === undefined || this.now() - used < unusedMs) {
				continue;
			}
			const lock = await IndexLock.acquire(dir);
			if (lock) {
				await lock.release();
				await fs.rm(dir, { recursive: true, force: true });
			}
		}
	}

	async dispose(): Promise<void> {
		clearInterval(this.idleTimer);
		const workspaces = await Promise.all(this.workspaces.values());
		this.workspaces.clear();
		for (const workspace of workspaces) {
			workspace.paused = true;
			clearTimeout(workspace.reopenTimer);
			await this.closeStore(workspace);
		}
		this.ignored.dispose();
	}

	/**
	 * Closes the indexes nobody used for ten minutes, with nothing to do: an
	 * open one holds a database connection and its cache. The next request or
	 * file change opens it again.
	 */
	async closeIdle(): Promise<void> {
		for (const pending of [...this.workspaces.values()]) {
			const workspace = await pending;
			if (workspace.store && !workspace.running && !workspace.opening && !workspace.pending.size && !workspace.needsReconcile && this.now() - workspace.usedAt >= idleCloseMs) {
				await this.closeStore(workspace);
				workspace.evicted = true;
			}
		}
	}

	// --- Internals

	private workspace(root: string, settings: IndexSettings): Promise<Workspace> {
		let pending = this.workspaces.get(root);
		if (!pending) {
			pending = workspaceId(root).then(id => {
				const dir = path.join(this.options.baseDir, 'code', id);
				return {
					root, dir, file: path.join(dir, 'index.db'), settings, store: undefined, lock: undefined, state: { kind: 'none' },
					pending: new Set(), needsReconcile: false, paused: false, running: undefined, opening: undefined, known: undefined, rules: undefined, lastStatusAt: 0, skipped: [],
					realRoot: undefined, wanted: false, evicted: false, usedAt: this.now(), turnHead: undefined, reopenTimer: undefined,
				} satisfies Workspace;
			});
			this.workspaces.set(root, pending);
			return pending;
		}
		return pending.then(workspace => {
			workspace.usedAt = this.now();
			if (JSON.stringify(workspace.settings) !== JSON.stringify(settings)) {
				workspace.settings = settings;
				workspace.rules = undefined;
				workspace.needsReconcile = true;
			}
			return workspace;
		});
	}

	/**
	 * A folder this window keeps current, its index open: opened again when it
	 * was closed for being idle, or failed to open before.
	 */
	private async reopened(root: string): Promise<Workspace | undefined> {
		const workspace = await this.workspaces.get(root);
		if (!workspace || (!workspace.store && !workspace.wanted)) {
			return undefined;
		}
		workspace.usedAt = this.now();
		if (!workspace.store) {
			const evicted = workspace.evicted;
			await this.open(workspace);
			// After a failure, what changed meanwhile is unknown.
			workspace.needsReconcile ||= !evicted;
		}
		return workspace.store ? workspace : undefined;
	}

	/** Opens the folder's index, once however many requests ask at the same time. */
	private open(workspace: Workspace): Promise<void> {
		return workspace.opening ??= this.openNow(workspace).finally(() => workspace.opening = undefined);
	}

	private async openNow(workspace: Workspace): Promise<void> {
		if (workspace.store) {
			return;
		}
		try {
			await fs.mkdir(workspace.dir, { recursive: true });
			workspace.lock = await IndexLock.acquire(workspace.dir);
			workspace.store = workspace.lock || !await exists(workspace.file)
				? await IndexStore.open(workspace.file)
				: await IndexStore.open(workspace.file, { readOnly: true });
			if (workspace.store.readOnly) {
				workspace.state = await readyState(workspace.store);
			} else {
				await fs.writeFile(path.join(workspace.dir, 'root'), workspace.root);
				workspace.state = built(workspace) ? await readyState(workspace.store) : { kind: 'building', done: 0, total: 0, first: true };
			}
			workspace.evicted = false;
		} catch (err) {
			await workspace.lock?.release();
			workspace.lock = undefined;
			workspace.store = undefined;
			this.setState(workspace, { kind: 'failed', message: err instanceof Error ? err.message : String(err) }, true);
			// A passing problem (the file busy, the disk full): the file is kept, and opened again soon.
			this.options.log?.(`Could not open the index of ${workspace.root}: ${err instanceof Error ? err.message : String(err)}`);
			clearTimeout(workspace.reopenTimer);
			workspace.reopenTimer = setTimeout(() => {
				workspace.reopenTimer = undefined;
				if (workspace.wanted && !workspace.store && this.workspaces.has(workspace.root)) {
					void this.reconcile({ root: workspace.root });
				}
			}, reopenAfterMs);
			workspace.reopenTimer.unref?.();
		}
	}

	private async closeStore(workspace: Workspace): Promise<void> {
		workspace.store?.close();
		workspace.store = undefined;
		await workspace.lock?.release();
		workspace.lock = undefined;
		workspace.known = undefined;
		workspace.pending.clear();
	}

	/** Takes the lock and reopens for writing, for a window whose index another window was writing. */
	private async takeOver(workspace: Workspace): Promise<boolean> {
		if (workspace.lock?.held) {
			return true;
		}
		// Another window took over a lock this process stopped refreshing.
		workspace.lock = undefined;
		const lock = await IndexLock.acquire(workspace.dir);
		if (!lock) {
			return false;
		}
		workspace.store?.close();
		workspace.lock = lock;
		try {
			workspace.store = await IndexStore.open(workspace.file);
		} catch (err) {
			await lock.release();
			workspace.lock = undefined;
			workspace.store = undefined;
			this.setState(workspace, { kind: 'failed', message: err instanceof Error ? err.message : String(err) }, true);
			return false;
		}
		workspace.needsReconcile = true;
		return true;
	}

	/** The folder's index when it can answer: open and built at least once. */
	private async queryable(root: string): Promise<IndexStore | undefined> {
		let workspace = await this.workspaces.get(root);
		if (!workspace) {
			if (!await exists(path.join(this.options.baseDir, 'code', await workspaceId(root), 'index.db'))) {
				return undefined;
			}
			workspace = await this.workspace(root, defaultSettings);
		}
		workspace.usedAt = this.now();
		if (!workspace.store) {
			await this.open(workspace);
		}
		return workspace.store && built(workspace) ? workspace.store : undefined;
	}

	private async progress(root: string): Promise<{ done: number; total: number }> {
		const state = (await this.workspaces.get(root))?.state;
		return state && (state.kind === 'building' || state.kind === 'paused') ? { done: state.done, total: state.total } : { done: 0, total: 0 };
	}

	private async touchUsed(workspace: Workspace): Promise<void> {
		if (!workspace.store || workspace.store.readOnly) {
			return;
		}
		const mark = path.join(workspace.dir, 'used');
		const at = new Date(this.now());
		// Only used for cleaning up.
		await fs.utimes(mark, at, at).catch(() => fs.writeFile(mark, '')).catch(() => undefined);
	}

	private schedule(workspace: Workspace): void {
		if (workspace.running || workspace.paused || !workspace.store) {
			return;
		}
		if (!workspace.needsReconcile && !workspace.pending.size) {
			return;
		}
		this.setBusy(1);
		workspace.running = (async () => {
			while (!workspace.paused && workspace.store && (workspace.needsReconcile || workspace.pending.size)) {
				if (!await this.takeOver(workspace)) {
					// Another window writes this index; it sees the same changes.
					workspace.needsReconcile = false;
					workspace.pending.clear();
					break;
				}
				if (workspace.needsReconcile) {
					workspace.needsReconcile = false;
					workspace.pending.clear();
					await this.runReconcile(workspace);
				} else {
					const paths = [...workspace.pending];
					workspace.pending.clear();
					await this.applyPaths(workspace, paths);
				}
			}
		})().catch(async err => {
			if (isCorruption(err)) {
				await this.recover(workspace.root, err);
				return;
			}
			this.options.log?.(`Indexing ${workspace.root} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
			this.setState(workspace, { kind: 'failed', message: err instanceof Error ? err.message : String(err) }, true);
		}).finally(() => {
			workspace.running = undefined;
			this.setBusy(-1);
			// Changes that came in during the last slice.
			this.schedule(workspace);
		});
	}

	private setBusy(delta: number): void {
		const was = this.busy > 0;
		this.busy += delta;
		if (was !== this.busy > 0) {
			this.options.onIdle?.(this.busy === 0);
		}
	}

	private async rules(workspace: Workspace): Promise<SkipRules> {
		return workspace.rules ??= await SkipRules.forFolder(workspace.root, workspace.settings);
	}

	private async runReconcile(workspace: Workspace): Promise<void> {
		const store = workspace.store!;
		const first = !built(workspace);
		const headBefore = store.meta('head');
		const inventory = await takeInventory(workspace.root, workspace.settings);
		workspace.rules = undefined;
		workspace.skipped = inventory.skipped.slice(0, maxSkippedKept).map(s => ({ path: s.path, reason: s.reason }));
		const states = store.fileStates();
		const listed = new Set(inventory.files.map(f => f.path));
		const rules = await this.rules(workspace);
		// A file left out for what it held is read again once the user includes it.
		const changed = inventory.files.filter(file => {
			const state = states.get(file.path);
			return !state || state.size !== file.size || state.mtime !== file.mtime || (!!state.skipped && rules.forced(file.path));
		});
		const removed = [...states.keys()].filter(p => !listed.has(p));
		// Imports written now resolve against every listed file; older ones may name a file new since.
		const added = inventory.files.filter(file => !states.has(file.path)).map(file => file.path);
		const known = workspace.known = new Known(listed);
		this.setState(workspace, { kind: 'building', done: 0, total: changed.length, first }, true);

		let done = 0;
		for (let at = 0; at < changed.length; at += readBatch) {
			if (workspace.paused || workspace.store !== store) {
				return;
			}
			const batch = changed.slice(at, at + readBatch);
			const contents = await Promise.all(batch.map(file => fs.readFile(path.join(workspace.root, file.path)).catch(() => undefined)));
			await this.writeSliced(store, batch.map((file, i) => ({ file, content: contents[i] })), states, known, rules);
			done += batch.length;
			this.setState(workspace, { kind: 'building', done, total: changed.length, first }, false);
		}
		if (workspace.store !== store) {
			return;
		}
		await this.removeSliced(store, removed, known);
		if (!first) {
			this.resolveImports(store, known, added);
		}
		store.setMeta('truncated', inventory.truncated ? '1' : '0');
		const head = await gitHead(workspace.root);
		if (first || head !== headBefore || !store.meta('cochange_at')) {
			const pairs = await cochangePairs(workspace.root);
			store.transaction(() => store.replaceCochange(pairs));
			store.setMeta('cochange_at', String(this.now()));
		}
		if (head) {
			store.setMeta('head', head);
		}
		// The next turn-end update looks from what this reconcile saw.
		workspace.turnHead = undefined;
		store.setMeta('built_at', String(this.now()));
		store.setMeta('root', workspace.root);
		this.setState(workspace, await readyState(store), true);
	}

	private async applyPaths(workspace: Workspace, paths: readonly string[]): Promise<void> {
		if (paths.length > maxPathsPerUpdate) {
			// A burst (a checkout, a generator): one inventory is cheaper than this many checks.
			workspace.needsReconcile = true;
			return;
		}
		const store = workspace.store!;
		const rules = await this.rules(workspace);
		const known = workspace.known ??= new Known((store.statement('SELECT path FROM files').all() as { path: string }[]).map(r => r.path));
		const realRoot = workspace.realRoot ??= await fs.realpath(workspace.root).catch(() => workspace.root);
		// Only the changed paths: a save in a large repository must not read the whole index.
		const states = store.fileStates(paths);
		const toWrite: { file: InventoryFile; content: Buffer | undefined }[] = [];
		const toRemove: string[] = [];
		for (const relative of paths) {
			// Through links too: a path from a file event may lead out of the folder.
			const found = await statInFolder(realRoot, workspace.root, relative, true);
			const stat = found?.stat;
			if (stat?.isDirectory()) {
				// A folder appeared (a checkout, a copy): look at everything.
				workspace.needsReconcile = true;
				return;
			}
			if (!stat && !states.has(relative)) {
				// A folder went (rm -rf src/legacy is one event): its files go with it.
				toRemove.push(...store.filesUnder(relative));
				continue;
			}
			if (!stat || rules.pathReason(relative) || rules.sizeReason(relative, stat.size) || await this.ignored.isIgnored(path.join(workspace.root, relative), workspace.root)) {
				if (states.has(relative)) {
					toRemove.push(relative);
				}
				continue;
			}
			const state = states.get(relative);
			const mtime = Math.floor(stat.mtimeMs);
			if (state && state.size === stat.size && state.mtime === mtime) {
				continue;
			}
			toWrite.push({ file: { path: relative, size: stat.size, mtime }, content: await fs.readFile(path.join(workspace.root, relative)).catch(() => undefined) });
		}
		if (workspace.store !== store) {
			return;
		}
		await this.removeSliced(store, toRemove, known);
		const added = await this.writeSliced(store, toWrite, states, known, rules);
		if (toWrite.length || toRemove.length) {
			this.resolveImports(store, known, added);
			this.setState(workspace, await readyState(store), true);
		}
	}

	/** Removes files in transactions of about `sliceMs` each, yielding between them, as `writeSliced` writes. */
	private async removeSliced(store: IndexStore, paths: readonly string[], known: Known): Promise<void> {
		let at = 0;
		while (at < paths.length) {
			const started = this.now();
			store.transaction(() => {
				while (at < paths.length && (this.now() - started < sliceMs)) {
					const relative = paths[at++];
					store.removeFile(relative);
					known.delete(relative);
				}
			});
			await new Promise<void>(resolve => setImmediate(resolve));
		}
	}

	/** Writes files in transactions of about `sliceMs` each, yielding between them. The files new to the index. */
	private async writeSliced(store: IndexStore, items: readonly { file: InventoryFile; content: Buffer | undefined }[], states: ReadonlyMap<string, { hash: string; skipped?: string }>, known: Known, rules: SkipRules): Promise<string[]> {
		const added: string[] = [];
		let at = 0;
		while (at < items.length) {
			const started = this.now();
			store.transaction(() => {
				while (at < items.length && (this.now() - started < sliceMs)) {
					const { file, content } = items[at++];
					if (!content) {
						if (states.has(file.path)) {
							store.removeFile(file.path);
						}
						known.delete(file.path);
						continue;
					}
					if (known.add(file.path)) {
						added.push(file.path);
					}
					const hash = createHash('sha1').update(content).digest('hex');
					const state = states.get(file.path);
					if (state?.hash === hash && !(state.skipped && rules.forced(file.path))) {
						store.touchFile(file.path, file.size, file.mtime);
						continue;
					}
					const text = content.toString('utf8');
					const skipped = rules.contentReason(file.path, text);
					const record = { path: file.path, lang: languageName(file.path), size: file.size, mtime: file.mtime, hash, skipped };
					if (skipped) {
						store.writeFile(record, undefined);
						continue;
					}
					const parsed = parseFile(file.path, text);
					store.writeFile(record, parsed, parsed.imports.map(spec => resolveImport(file.path, spec, parsed.lang, known)));
				}
			});
			await new Promise<void>(resolve => setImmediate(resolve));
		}
		return added;
	}

	/**
	 * Points imports at files that exist now, such as one added after the file
	 * importing it. Only when files were added, and only the imports that can
	 * name one of them: a save changes no file's existence.
	 */
	private resolveImports(store: IndexStore, known: Known, added: readonly string[]): void {
		if (!added.length) {
			return;
		}
		const unresolved = store.unresolvedImports(importNames(added));
		if (!unresolved.length) {
			return;
		}
		store.transaction(() => {
			for (const row of unresolved) {
				const target = resolveImport(row.path, row.spec, row.lang, known);
				if (target) {
					store.setImportTarget(row.id, target);
				}
			}
		});
	}

	private statusOf(workspace: Workspace): IndexStatus {
		return { root: workspace.root, state: workspace.state, readOnly: !!workspace.store && !workspace.lock };
	}

	private setState(workspace: Workspace, state: IndexState, force: boolean): void {
		workspace.state = state;
		const now = this.now();
		if (force || now - workspace.lastStatusAt >= statusEveryMs) {
			workspace.lastStatusAt = now;
			this.options.onStatus?.(this.statusOf(workspace));
		}
	}
}

function built(workspace: Workspace): boolean {
	return !!workspace.store?.meta('built_at');
}

/** The folder-relative path of `file` (absolute, or relative to `root`), or undefined outside `root`. */
function relativeTo(root: string, file: string): string | undefined {
	const absolute = path.isAbsolute(file) ? file : path.join(root, file);
	if (!isInside(root, absolute) || absolute === root) {
		return undefined;
	}
	return path.relative(root, absolute).split(path.sep).join('/');
}

async function readyState(store: IndexStore): Promise<IndexState> {
	const counts = store.counts();
	let bytes = 0;
	for (const suffix of ['', '-wal']) {
		bytes += (await fs.stat(store.file + suffix).catch(() => undefined))?.size ?? 0;
	}
	return { kind: 'ready', ...counts, bytes, updatedAt: Number(store.meta('built_at') ?? 0) };
}

/**
 * The names an import of one of `files` can carry: a file's name before its
 * first dot (`cart` for cart.service.ts, `Cart` for Cart.java), and the
 * folder's name for a folder's own module (index.ts, __init__.py, mod.rs).
 */
export function importNames(files: readonly string[]): Set<string> {
	const names = new Set<string>();
	for (const file of files) {
		const parts = file.split('/');
		const stem = parts[parts.length - 1].split('.')[0];
		if (stem) {
			names.add(stem);
		}
		if ((stem === 'index' || stem === '__init__' || stem === 'mod') && parts.length > 1) {
			names.add(parts[parts.length - 2]);
		}
	}
	return names;
}
