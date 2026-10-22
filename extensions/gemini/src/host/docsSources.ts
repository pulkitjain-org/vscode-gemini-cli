/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { crawl, CrawlError, domainAllowed } from '../acp/docs/crawler';
import type { DocsRefresh, DocsScope, DocsSearchResult, DocsSourceStatus } from '../acp/docs/docsProtocol';
import { DocsRegistry, DocsSource, isDue, normalizedUrl, provisionalTitle, sourceId } from '../acp/docs/docsRegistry';
import { IndexLock } from '../acp/index/indexLock';
import type { AttachedDocs } from '../acp/indexMcp';
import { configSection } from './configuration';
import type { DocsProvider, WorkspaceIndex } from './workspaceIndex';

/** How often due sources are looked for, while the window is open. */
const checkEveryMs = 30 * 60 * 1000;
/** The first look, after the window has settled. */
const firstCheckMs = 2 * 60 * 1000;
export const defaultMaxPages = 500;

export interface NewSource {
	readonly url: string;
	readonly scope: DocsScope;
	readonly maxPages: number;
	readonly refresh?: DocsRefresh;
	readonly folders: readonly string[];
}

/** A source as the Index page shows it: what the registry knows, and whether it is being fetched now. */
export interface SourceView extends DocsSource {
	readonly fetching: boolean;
	readonly sections?: number;
	readonly bytes?: number;
}

/**
 * Documentation from the web, for agents' `docs_search`. The user adds a
 * source (an address, how much of the site, how often to refresh) and
 * attaches it to folders; it is stored once (docsRegistry.ts) however many
 * folders use it. Pages are fetched here, in the extension host, through
 * the editor's network settings, and handed to the indexer process to
 * convert and store. One window fetches a source at a time (a lock beside
 * the stores); due sources are refreshed in the background, a page that
 * hasn't changed costing one conditional request.
 */
export class DocsSources implements DocsProvider, vscode.Disposable {

	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	private readonly registry: DocsRegistry;
	private readonly fetching = new Map<string, AbortController>();
	private readonly statuses = new Map<string, DocsSourceStatus>();
	private readonly timers: ReturnType<typeof setTimeout>[] = [];

	constructor(private readonly index: WorkspaceIndex, private readonly log: vscode.LogOutputChannel) {
		this.registry = new DocsRegistry(path.join(index.baseDir, 'docs', 'sources.json'));
		void this.registry.load().then(() => this.onDidChangeEmitter.fire());
		const first = setTimeout(() => void this.refreshDue(), firstCheckMs);
		const every = setInterval(() => void this.refreshDue(), checkEveryMs);
		first.unref?.();
		every.unref?.();
		this.timers.push(first, every);
	}

	/** The sources attached to `folder`, for its agents' tools. */
	attachedTo(folder: string): readonly AttachedDocs[] {
		if (!docsEnabled()) {
			return [];
		}
		return this.registry.cached
			.filter(source => source.folders.includes(folder) && (source.pages ?? 0) > 0)
			.map(source => ({ id: source.id, title: source.title ?? provisionalTitle(source.url), url: source.url }));
	}

	async search(ids: readonly string[], query: string): Promise<DocsSearchResult> {
		return await this.index.request('docsSearch', { ids, query }) ?? { hits: [], total: 0, terms: [] };
	}

	/** Every source, read again from disk, with what the indexer knows of each. */
	async list(): Promise<SourceView[]> {
		const sources = await this.registry.load();
		const statuses = sources.length ? await this.index.request('docsStatus', { ids: sources.map(s => s.id) }).catch(() => undefined) : undefined;
		for (const status of statuses ?? []) {
			this.statuses.set(status.id, status);
		}
		return sources.map(source => {
			const status = this.statuses.get(source.id);
			return { ...source, fetching: this.fetching.has(source.id), sections: status?.sections, bytes: status?.bytes };
		});
	}

	/** Why `url` can't be added, or undefined. */
	refusal(url: string): string | undefined {
		if (!docsEnabled()) {
			return vscode.l10n.t("Adding documentation is turned off (gemini.docs.enabled).");
		}
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return vscode.l10n.t("Enter a full address, such as https://react.dev/reference.");
		}
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
			return vscode.l10n.t("Only http and https addresses can be fetched.");
		}
		if (!domainAllowed(parsed.hostname, allowedDomains())) {
			return vscode.l10n.t("{0} is not one of the sites documentation may come from (gemini.docs.allowedDomains).", parsed.hostname);
		}
		return undefined;
	}

	/** Adds a source (or attaches an existing one to more folders) and fetches it. */
	async add(input: NewSource): Promise<string> {
		const refused = this.refusal(input.url);
		if (refused) {
			throw new Error(refused);
		}
		const url = normalizedUrl(input.url);
		const id = sourceId(url, input.scope);
		await this.registry.update(sources => {
			const existing = sources.find(s => s.id === id);
			if (existing) {
				return sources.map(s => s.id === id ? { ...s, maxPages: input.maxPages, refresh: input.refresh, folders: [...new Set([...s.folders, ...input.folders])] } : s);
			}
			return [...sources, { id, url, scope: input.scope, maxPages: input.maxPages, ...input.refresh ? { refresh: input.refresh } : {}, addedAt: Date.now(), folders: [...new Set(input.folders)] }];
		});
		this.onDidChangeEmitter.fire();
		void this.fetch(id);
		return id;
	}

	async attach(id: string, folder: string, attached: boolean): Promise<void> {
		await this.registry.update(sources => sources.map(s => s.id !== id ? s : { ...s, folders: attached ? [...new Set([...s.folders, folder])] : s.folders.filter(f => f !== folder) }));
		this.onDidChangeEmitter.fire();
	}

	async setRefresh(id: string, refresh: DocsRefresh | undefined): Promise<void> {
		await this.registry.update(sources => sources.map(s => s.id !== id ? s : { ...s, refresh }));
		this.onDidChangeEmitter.fire();
	}

	async remove(id: string): Promise<void> {
		this.fetching.get(id)?.abort();
		await this.registry.update(sources => sources.filter(s => s.id !== id));
		await this.index.request('docsRemove', { id }).catch(() => undefined);
		this.statuses.delete(id);
		this.onDidChangeEmitter.fire();
	}

	/** Fetches a source now: its changed pages, then drops the pages it no longer has. */
	async fetch(id: string): Promise<void> {
		if (this.fetching.has(id) || !docsEnabled()) {
			return;
		}
		const source = (await this.registry.load()).find(s => s.id === id);
		if (!source) {
			return;
		}
		const lockDir = path.join(this.index.baseDir, 'docs');
		const lock = await IndexLock.acquire(lockDir, process.pid, `${id}.fetch.lock`);
		if (!lock) {
			// Another window is fetching it.
			return;
		}
		const abort = new AbortController();
		this.fetching.set(id, abort);
		this.onDidChangeEmitter.fire();
		const run = Date.now();
		let error: string | undefined;
		let status: DocsSourceStatus | undefined;
		try {
			const validators = await this.index.request('docsValidators', { id }) ?? {};
			const result = await crawl({
				url: source.url,
				scope: source.scope,
				maxPages: source.maxPages,
				validators,
				fetch,
				signal: abort.signal,
				allowedHost: host => domainAllowed(host, allowedDomains()),
				userAgent: `GeminiCode-Docs/${vscode.version}`,
				onBatch: async (pages, unchanged) => {
					status = await this.index.request('docsIngest', { source: { id, url: source.url, run }, pages, unchanged, complete: false });
				},
			});
			error = result.error;
			if (!error && !abort.signal.aborted) {
				status = await this.index.request('docsIngest', { source: { id, url: source.url, run }, pages: [], unchanged: [], complete: true });
			}
			this.log.info(`Docs ${source.url}: ${result.mode}, ${result.fetched} fetched, ${result.unchanged} unchanged, ${result.failed} failed, ${result.blockedByRobots} blocked by robots.txt${error ? `; ${error}` : ''}`);
		} catch (err) {
			error = err instanceof CrawlError || err instanceof Error ? err.message : String(err);
			this.log.warn(`Docs ${source.url} failed: ${error}`);
		} finally {
			await lock.release();
			this.fetching.delete(id);
		}
		if (status) {
			this.statuses.set(id, status);
		}
		if (!abort.signal.aborted) {
			await this.registry.update(sources => sources.map(s => s.id !== id ? s : {
				...s,
				...status?.title ? { title: status.title } : {},
				...status ? { pages: status.pages } : {},
				...error ? { error } : { error: undefined, fetchedAt: Date.now() },
			}));
		}
		this.onDidChangeEmitter.fire();
	}

	dispose(): void {
		for (const timer of this.timers) {
			clearTimeout(timer);
		}
		for (const abort of this.fetching.values()) {
			abort.abort();
		}
		this.onDidChangeEmitter.dispose();
	}

	/** Fetches the sources due again, one after another, that some folder uses. */
	private async refreshDue(): Promise<void> {
		if (!docsEnabled()) {
			return;
		}
		const fallback = refreshSetting();
		const now = Date.now();
		for (const source of await this.registry.load()) {
			if (source.folders.length && isDue(source, fallback, now) && !source.error) {
				await this.fetch(source.id);
			}
		}
	}
}

function docsEnabled(): boolean {
	return vscode.workspace.getConfiguration(configSection).get<boolean>('docs.enabled', true);
}

function allowedDomains(): string[] {
	const value = vscode.workspace.getConfiguration(configSection).get<unknown>('docs.allowedDomains', []);
	return Array.isArray(value) ? value.filter((d): d is string => typeof d === 'string') : [];
}

function refreshSetting(): DocsRefresh {
	const value = vscode.workspace.getConfiguration(configSection).get<string>('docs.refresh', 'daily');
	return value === 'weekly' || value === 'manual' ? value : 'daily';
}
