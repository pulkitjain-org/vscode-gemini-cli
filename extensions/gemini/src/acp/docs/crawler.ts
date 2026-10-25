/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Fetches a documentation source's pages, in the extension host, so the
// machine's proxy, VPN and certificates apply. It finds the pages the way a
// site offers them: `llms-full.txt` (the whole docs as Markdown), then
// `llms.txt` (a list of pages), then the sitemap, and only then by following
// links under the address. It keeps to the address's path, honours
// robots.txt, asks for each page again only if it changed (ETag and
// Last-Modified), and stops at its limits. Pages go to the indexer process
// in batches, which converts and stores them.

import type { DocsPage } from '../index/indexerProtocol';
import type { DocsScope } from './docsProtocol';

export interface CrawlOptions {
	readonly url: string;
	readonly scope: DocsScope;
	readonly maxPages: number;
	/** Each page's validators from the last fetch, by URL. */
	readonly validators: Readonly<Record<string, { readonly etag?: string; readonly lastModified?: string }>>;
	readonly fetch: typeof fetch;
	/** Whether a site may be fetched from, per `gemini.docs.allowedDomains`. */
	readonly allowedHost?: (host: string) => boolean;
	readonly onBatch: (pages: readonly DocsPage[], unchanged: readonly string[]) => Promise<void>;
	readonly signal?: AbortSignal;
	/** Between requests to the site. */
	readonly delayMs?: number;
	readonly concurrency?: number;
	readonly maxBytes?: number;
	readonly maxDepth?: number;
	readonly userAgent?: string;
}

export type CrawlMode = 'page' | 'llms-full' | 'llms' | 'sitemap' | 'links';

export interface CrawlResult {
	readonly mode: CrawlMode;
	readonly fetched: number;
	readonly unchanged: number;
	readonly failed: number;
	readonly blockedByRobots: number;
	/** Why nothing could be fetched, for the Index page. */
	readonly error?: string;
}

const batchSize = 20;
const maxPageBytes = 5 * 1024 * 1024;
const defaultMaxBytes = 50 * 1024 * 1024;
const timeoutMs = 20_000;
const maxSitemaps = 10;
const signInPath = /(?:^|[/._-])(?:login|log-in|signin|sign-in|sso|auth|oauth|saml|idp)(?:$|[/._-])/i;

export class CrawlError extends Error { }

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
	const start = new URL(options.url);
	if (start.protocol !== 'https:' && start.protocol !== 'http:') {
		throw new CrawlError('Only http and https addresses can be fetched.');
	}
	if (options.allowedHost && !options.allowedHost(start.hostname)) {
		throw new CrawlError(`${start.hostname} is not in gemini.docs.allowedDomains.`);
	}
	const scope = scopeOf(start, options.scope);
	const robots = options.scope === 'page' ? { allowed: () => true, sitemaps: [] } : await readRobots(start.origin, options);
	const queue: { url: string; depth: number }[] = [];
	const seen = new Set<string>();
	const enqueue = (url: string, depth: number) => {
		const clean = withoutFragment(url);
		if (clean && !seen.has(clean) && scope(clean)) {
			seen.add(clean);
			queue.push({ url: clean, depth });
		}
	};

	let mode: CrawlMode = 'page';
	if (options.scope !== 'page') {
		const discovered = await discover(start, scope, robots.sitemaps, options);
		mode = discovered.mode;
		if (discovered.full) {
			await options.onBatch([discovered.full], []);
			return { mode, fetched: 1, unchanged: 0, failed: 0, blockedByRobots: 0 };
		}
		for (const url of discovered.urls) {
			enqueue(url, 0);
		}
	}
	if (!queue.length) {
		// No list of pages: start at the address and follow its links.
		mode = options.scope === 'page' ? 'page' : 'links';
		const first = withoutFragment(start.href)!;
		seen.add(first);
		queue.push({ url: first, depth: 0 });
	}

	const pages: DocsPage[] = [];
	const unchanged: string[] = [];
	let fetched = 0;
	let unchangedCount = 0;
	let failed = 0;
	let blocked = 0;
	let bytes = 0;
	let firstError: string | undefined;
	let handled = 0;
	const flush = async (force: boolean) => {
		if (pages.length >= batchSize || unchanged.length >= batchSize * 5 || (force && (pages.length || unchanged.length))) {
			await options.onBatch(pages.splice(0), unchanged.splice(0));
		}
	};
	const maxBytes = options.maxBytes ?? defaultMaxBytes;
	const maxDepth = options.maxDepth ?? 4;
	const delayMs = options.delayMs ?? 250;

	const worker = async () => {
		while (queue.length && handled < options.maxPages && bytes < maxBytes && !options.signal?.aborted) {
			const { url, depth } = queue.shift()!;
			if (!robots.allowed(new URL(url).pathname)) {
				blocked++;
				continue;
			}
			handled++;
			const validators = options.validators[url];
			let response: Response;
			try {
				response = await request(options, url, {
					...validators?.etag ? { 'If-None-Match': validators.etag } : {},
					...validators?.lastModified ? { 'If-Modified-Since': validators.lastModified } : {},
				});
			} catch (err) {
				failed++;
				firstError ??= `${url}: ${err instanceof Error ? err.message : String(err)}`;
				continue;
			} finally {
				if (delayMs) {
					await new Promise(resolve => setTimeout(resolve, delayMs));
				}
			}
			if (response.status === 304) {
				unchangedCount++;
				unchanged.push(url);
				await flush(false);
				continue;
			}
			if (response.redirected && isSignIn(new URL(response.url), start)) {
				failed++;
				firstError ??= 'Sign-in needed: the page redirected to a sign-in form. Pages behind a sign-in aren\'t supported yet.';
				continue;
			}
			if (!response.ok) {
				failed++;
				firstError ??= `${url}: HTTP ${response.status}`;
				continue;
			}
			const type = pageType(response.headers.get('content-type'), url);
			const length = Number(response.headers.get('content-length') ?? 0);
			if (!type || length > maxPageBytes) {
				await response.body?.cancel().catch(() => undefined);
				continue;
			}
			const body = await response.text();
			if (body.length > maxPageBytes) {
				continue;
			}
			bytes += body.length;
			fetched++;
			pages.push({ url, body, type, etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined });
			if (mode === 'links' && type === 'html' && depth < maxDepth) {
				for (const link of extractLinks(body, response.url || url)) {
					enqueue(link, depth + 1);
				}
			}
			await flush(false);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 2) }, worker));
	await flush(true);
	const error = fetched + unchangedCount === 0 ? firstError ?? (blocked ? 'robots.txt does not allow fetching these pages.' : 'No pages could be fetched.') : undefined;
	return { mode, fetched, unchanged: unchangedCount, failed, blockedByRobots: blocked, ...error ? { error } : {} };
}

/** Whether a URL is within the source: same site, and under the address's path unless the whole site was asked for. */
export function scopeOf(start: URL, scope: DocsScope): (url: string) => boolean {
	const lastSegment = start.pathname.slice(start.pathname.lastIndexOf('/') + 1);
	// "/docs/intro.html" is a page in /docs/; "/reference" is a folder of pages.
	const base = scope === 'site' ? '/' : /\.[a-z0-9]+$/i.test(lastSegment) ? start.pathname.slice(0, start.pathname.lastIndexOf('/') + 1) : start.pathname;
	const prefix = base.endsWith('/') ? base : `${base}/`;
	const exact = withoutFragment(start.href);
	return url => {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return false;
		}
		if (scope === 'page') {
			return withoutFragment(parsed.href) === exact;
		}
		return parsed.origin === start.origin && (parsed.pathname === base || parsed.pathname.startsWith(prefix)) && !/\.(?:png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|mp4|woff2?|css|js|json|xml)$/i.test(parsed.pathname);
	};
}

async function discover(start: URL, inScope: (url: string) => boolean, robotsSitemaps: readonly string[], options: CrawlOptions): Promise<{ mode: CrawlMode; urls: string[]; full?: DocsPage }> {
	const dir = start.pathname.endsWith('/') ? start.pathname : `${start.pathname}/`;
	// A list of pages at the address, else the site's, filtered to the address.
	const roots = options.scope === 'site' ? ['/'] : dir === '/' ? [dir] : [dir, '/'];
	// The whole docs in one file, only at the address itself: the site's own would cover more than was asked.
	const fullUrl = `${start.origin}${options.scope === 'site' ? '/' : dir}llms-full.txt`;
	const full = await tryText(options, fullUrl);
	if (full) {
		return { mode: 'llms-full', urls: [], full: { url: fullUrl, body: full.body, type: 'markdown', etag: full.etag, lastModified: full.lastModified } };
	}
	for (const root of roots) {
		const list = await tryText(options, `${start.origin}${root}llms.txt`);
		if (list) {
			const urls = markdownLinks(list.body, `${start.origin}${root}`).filter(inScope);
			if (urls.length) {
				return { mode: 'llms', urls };
			}
		}
	}
	const sitemaps = robotsSitemaps.length ? [...robotsSitemaps] : [`${start.origin}/sitemap.xml`];
	const urls: string[] = [];
	for (let i = 0; i < sitemaps.length && i < maxSitemaps; i++) {
		const map = await tryText(options, sitemaps[i]);
		if (!map) {
			continue;
		}
		const locs = [...map.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => decodeXml(m[1]));
		if (/<sitemapindex/i.test(map.body)) {
			sitemaps.push(...locs.filter(loc => !sitemaps.includes(loc)));
		} else {
			urls.push(...locs.filter(inScope));
		}
	}
	return urls.length ? { mode: 'sitemap', urls: [...new Set(urls)] } : { mode: 'links', urls: [] };
}

async function tryText(options: CrawlOptions, url: string): Promise<{ body: string; etag?: string; lastModified?: string } | undefined> {
	try {
		const response = await request(options, url, {});
		const type = response.headers.get('content-type') ?? '';
		if (!response.ok || /text\/html/i.test(type)) {
			// A site that answers every path with its HTML app has no such file.
			await response.body?.cancel().catch(() => undefined);
			return undefined;
		}
		const body = await response.text();
		return body.length <= maxPageBytes * 2 ? { body, etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined } : undefined;
	} catch {
		return undefined;
	}
}

async function request(options: CrawlOptions, url: string, headers: Record<string, string>): Promise<Response> {
	const timeout = AbortSignal.timeout(timeoutMs);
	return options.fetch(url, {
		headers: { 'User-Agent': options.userAgent ?? 'GeminiCode-Docs', Accept: 'text/html,text/markdown,text/plain;q=0.9,*/*;q=0.5', ...headers },
		redirect: 'follow',
		signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
	});
}

async function readRobots(origin: string, options: CrawlOptions): Promise<{ allowed: (pathname: string) => boolean; sitemaps: string[] }> {
	const robots = await tryText(options, `${origin}/robots.txt`);
	return robots ? parseRobots(robots.body) : { allowed: () => true, sitemaps: [] };
}

/** robots.txt rules for this fetcher (its own group, else `*`): the longest matching rule wins, Allow on a tie. */
export function parseRobots(text: string, agent = 'geminicode'): { allowed: (pathname: string) => boolean; sitemaps: string[] } {
	const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
	const sitemaps: string[] = [];
	let current: (typeof groups)[number] | undefined;
	let lastWasAgent = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/#.*$/, '').trim();
		const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
		if (!match) {
			continue;
		}
		const key = match[1].toLowerCase();
		const value = match[2].trim();
		if (key === 'sitemap') {
			sitemaps.push(value);
			continue;
		}
		if (key === 'user-agent') {
			if (!current || !lastWasAgent) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			current.agents.push(value.toLowerCase());
			lastWasAgent = true;
			continue;
		}
		lastWasAgent = false;
		if (current && (key === 'allow' || key === 'disallow') && value) {
			current.rules.push({ allow: key === 'allow', pattern: value });
		}
	}
	const own = groups.filter(g => g.agents.some(a => a !== '*' && agent.includes(a)));
	const rules = (own.length ? own : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules);
	const compiled = rules.map(rule => ({ ...rule, regex: new RegExp(`^${rule.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`) }));
	return {
		sitemaps,
		allowed: pathname => {
			let best: { allow: boolean; length: number } | undefined;
			for (const rule of compiled) {
				if (rule.regex.test(pathname) && (!best || rule.pattern.length > best.length || (rule.pattern.length === best.length && rule.allow))) {
					best = { allow: rule.allow, length: rule.pattern.length };
				}
			}
			return best?.allow ?? true;
		},
	};
}

/** Links in an HTML page, absolute, for following links when a site offers no list. */
export function extractLinks(html: string, base: string): string[] {
	const links = new Set<string>();
	for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
		const href = decodeXml(match[1] ?? match[2] ?? match[3] ?? '');
		try {
			const url = new URL(href, base);
			if (url.protocol === 'http:' || url.protocol === 'https:') {
				links.add(withoutFragment(url.href)!);
			}
		} catch {
			// Not a URL.
		}
	}
	return [...links];
}

/** Links in Markdown (an llms.txt), absolute. */
export function markdownLinks(markdown: string, base: string): string[] {
	const links: string[] = [];
	for (const match of markdown.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
		try {
			links.push(withoutFragment(new URL(match[1], base).href)!);
		} catch {
			// Not a URL.
		}
	}
	return [...new Set(links)];
}

/** Whether `host` may be fetched from, per patterns such as `react.dev` or `*.example.com`; none allows every site. */
export function domainAllowed(host: string, patterns: readonly string[]): boolean {
	const name = host.toLowerCase();
	const list = patterns.map(p => p.trim().toLowerCase()).filter(Boolean);
	return !list.length || list.some(pattern => pattern === '*' || (pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) || name === pattern.slice(2) : name === pattern));
}

function isSignIn(final: URL, start: URL): boolean {
	return signInPath.test(final.pathname) || (final.hostname !== start.hostname && /(?:login|signin|auth|sso|okta|accounts)\./i.test(final.hostname));
}

function pageType(contentType: string | null, url: string): DocsPage['type'] | undefined {
	const type = (contentType ?? '').toLowerCase();
	if (type.includes('text/html') || type.includes('application/xhtml')) {
		return 'html';
	}
	if (type.includes('markdown') || /\.(?:md|mdx|markdown)$/i.test(new URL(url).pathname)) {
		return 'markdown';
	}
	if (type.includes('text/plain')) {
		return /\.txt$/i.test(new URL(url).pathname) ? 'markdown' : 'text';
	}
	return undefined;
}

function withoutFragment(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		parsed.hash = '';
		return parsed.href;
	} catch {
		return undefined;
	}
}

function decodeXml(text: string): string {
	return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'');
}
