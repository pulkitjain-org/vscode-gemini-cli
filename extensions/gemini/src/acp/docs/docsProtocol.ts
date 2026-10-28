/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Documentation from URLs: what the extension host (which fetches, through
// the editor's network settings) and the indexer process (which converts and
// stores) say to each other about a source.

/** What to fetch: the page alone, pages under its path, or the whole site. */
/** How many pages a source fetches when nothing says otherwise. */
export const defaultMaxPages = 500;

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
	/** The section's headings, outermost first, joined by a single right-pointing angle quote (U+203A). */
	readonly heading: string;
	readonly text: string;
}

export interface DocsSearchResult {
	readonly hits: readonly DocsHit[];
	readonly total: number;
	readonly terms: readonly string[];
}

/** Whether `host` may be fetched from, per patterns such as `react.dev` or `*.example.com`; none allows every site. */
export function domainAllowed(host: string, patterns: readonly string[]): boolean {
	const name = host.toLowerCase();
	const list = patterns.map(p => p.trim().toLowerCase()).filter(Boolean);
	return !list.length || list.some(pattern => pattern === '*' || (pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) || name === pattern.slice(2) : name === pattern));
}
