/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The messages between the extension host and the indexer process, over
// Node's IPC channel: requests with ids, their answers, and status events.

import type { DocsSearchResult, DocsSourceInput, DocsSourceStatus } from '../docs/docsProtocol';
import type { RelatedResult, SearchQuery, SearchResult, SymbolResult } from './query';

export interface IndexSettings {
	readonly exclude: readonly string[];
	readonly maxFileBytes: number;
}

export type IndexState =
	| { readonly kind: 'none' }
	| { readonly kind: 'building'; readonly done: number; readonly total: number; readonly first: boolean }
	| { readonly kind: 'paused'; readonly done: number; readonly total: number }
	| { readonly kind: 'ready'; readonly files: number; readonly symbols: number; readonly skipped: number; readonly bytes: number; readonly updatedAt: number }
	| { readonly kind: 'failed'; readonly message: string };

export interface IndexStatus {
	readonly root: string;
	readonly state: IndexState;
	/** Another window writes this index; this one only reads it. */
	readonly readOnly: boolean;
}

/** An answer to a query, and whether it came from live search because the index isn't built yet. */
export interface Answer<T> {
	readonly result: T;
	readonly fallback?: { readonly done: number; readonly total: number };
}

/** Each method may answer at once or later. */
export interface IndexerMethods {
	ensure(params: { readonly root: string; readonly settings: IndexSettings; readonly build: boolean }): IndexStatus;
	update(params: { readonly root: string; readonly paths: readonly string[] }): void;
	reconcile(params: { readonly root: string }): void;
	rebuild(params: { readonly root: string; readonly settings: IndexSettings }): IndexStatus;
	pause(params: { readonly root: string }): IndexStatus;
	resume(params: { readonly root: string }): IndexStatus;
	remove(params: { readonly root: string }): void;
	seed(params: { readonly from: string; readonly to: string; readonly settings: IndexSettings }): IndexStatus;
	status(params: { readonly roots: readonly string[] }): IndexStatus[];
	skipped(params: { readonly root: string }): { readonly path: string; readonly reason: string }[];
	files(params: { readonly root: string }): string[] | undefined;
	search(params: { readonly root: string; readonly query: SearchQuery }): Answer<SearchResult>;
	findSymbol(params: { readonly root: string; readonly name: string; readonly kind?: string; readonly references?: boolean }): Answer<SymbolResult>;
	related(params: { readonly root: string; readonly path: string }): Answer<RelatedResult & { readonly known: boolean; readonly suggestions: readonly string[] }>;
	repoMap(params: { readonly root: string; readonly path?: string; readonly depth?: number; readonly maxChars?: number }): Answer<string>;
	docsIngest(params: { readonly source: DocsSourceInput; readonly pages: readonly DocsPage[]; readonly unchanged: readonly string[]; readonly complete: boolean }): DocsSourceStatus;
	docsStatus(params: { readonly ids: readonly string[] }): DocsSourceStatus[];
	docsRemove(params: { readonly id: string }): void;
	docsSearch(params: { readonly ids: readonly string[]; readonly query: string; readonly limit?: number }): DocsSearchResult;
	docsValidators(params: { readonly id: string }): Record<string, { readonly etag?: string; readonly lastModified?: string }>;
}

/** A fetched page: HTML, or Markdown or text from an llms.txt file. */
export interface DocsPage {
	readonly url: string;
	readonly body: string;
	readonly type: 'html' | 'markdown' | 'text';
	readonly etag?: string;
	readonly lastModified?: string;
}

export type IndexerMethod = keyof IndexerMethods;
export type IndexerParams<M extends IndexerMethod> = Parameters<IndexerMethods[M]>[0];
export type IndexerResult<M extends IndexerMethod> = ReturnType<IndexerMethods[M]>;

export type HostMessage = { readonly id: number; readonly method: IndexerMethod; readonly params: unknown };

export type IndexerMessage =
	| { readonly kind: 'answer'; readonly id: number; readonly result?: unknown; readonly error?: string }
	| { readonly kind: 'event'; readonly event: 'status'; readonly status: IndexStatus }
	| { readonly kind: 'event'; readonly event: 'idle'; readonly idle: boolean }
	| { readonly kind: 'event'; readonly event: 'log'; readonly message: string };
