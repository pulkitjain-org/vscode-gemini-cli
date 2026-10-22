/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Documentation from URLs: what the extension host (which fetches, through
// the editor's network settings) and the indexer process (which converts and
// stores) say to each other about a source.

/** What to fetch: the page alone, pages under its path, or the whole site. */
export type DocsScope = 'page' | 'prefix' | 'site';
export type DocsRefresh = 'daily' | 'weekly' | 'manual';

export interface DocsSourceInput {
	readonly id: string;
	readonly url: string;
	/** Each fetch has its own number; pages the latest complete fetch didn't see are dropped. */
	readonly run: number;
}

export interface DocsSourceStatus {
	readonly id: string;
	readonly pages: number;
	readonly sections: number;
	readonly bytes: number;
	/** The site's own name for itself, from the first page. */
	readonly title?: string;
	readonly fetchedAt?: number;
}

export interface DocsHit {
	readonly source: string;
	readonly url: string;
	readonly title: string;
	/** The section's headings, outermost first, joined by ` › `. */
	readonly heading: string;
	readonly text: string;
}

export interface DocsSearchResult {
	readonly hits: readonly DocsHit[];
	readonly total: number;
	readonly terms: readonly string[];
}
