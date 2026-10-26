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
//
// It runs with the user's network access (VPN included), so it only goes
// where it was sent: redirects are followed by hand, each hop checked against
// gemini.docs.allowedDomains and the source's scope, sitemaps named by
// robots.txt or a sitemap index likewise, and no request goes to a private or
// loopback address unless the source's own address is one. Bodies are read
// through a byte cap, whatever the server says their length is.

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
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
	/** The addresses a host name resolves to; `dns.lookup` unless a test gives its own. */
	readonly lookup?: (host: string) => Promise<readonly string[]>;
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
/** A batch is sent once its pages hold this much, however few they are: one IPC message stays small. */
const batchBytes = 8 * 1024 * 1024;
const maxPageBytes = 5 * 1024 * 1024;
const maxRedirects = 5;
const defaultMaxBytes = 50 * 1024 * 1024;
const timeoutMs = 20_000;
const maxSitemaps = 10;
const signInPath = /(?:^|[/._-])(?:login|log-in|signin|sign-in|sso|auth|oauth|saml|idp)(?:$|[/._-])/i;

export class CrawlError extends Error { }

/** Where one crawl may send requests: allowed hosts, and no private address unless the source is at one. */
interface Reach {
	readonly start: URL;
	/** Whether a URL may be asked for at all. */
	readonly may: (url: URL) => Promise<boolean>;
}

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
	const start = new URL(options.url);
	if (start.protocol !== 'https:' && start.protocol !== 'http:') {
		throw new CrawlError('Only http and https addresses can be fetched.');
	}
	if (options.allowedHost && !options.allowedHost(start.hostname)) {
		throw new CrawlError(`${start.hostname} is not in gemini.docs.allowedDomains.`);
	}
	const reach = await reachOf(start, options);
	const scope = scopeOf(start, options.scope);
	const robots = options.scope === 'page' ? { allowed: () => true, sitemaps: [] } : await readRobots(start.origin, options, reach);
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
		const discovered = await discover(start, scope, robots.sitemaps, options, reach);
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
	let batched = 0;
	let firstError: string | undefined;
	let handled = 0;
	const flush = async (force: boolean) => {
		if (pages.length >= batchSize || batched >= batchBytes || unchanged.length >= batchSize * 5 || (force && (pages.length || unchanged.length))) {
			batched = 0;
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
			let fetchedPage: Fetched;
			try {
				fetchedPage = await request(options, reach, url, {
					...validators?.etag ? { 'If-None-Match': validators.etag } : {},
					...validators?.lastModified ? { 'If-Modified-Since': validators.lastModified } : {},
				}, scope);
			} catch (err) {
				failed++;
				firstError ??= `${url}: ${err instanceof Error ? err.message : String(err)}`;
				continue;
			} finally {
				if (delayMs) {
					await new Promise(resolve => setTimeout(resolve, delayMs));
				}
			}
			if (fetchedPage.kind === 'sign-in') {
				failed++;
				firstError ??= 'Sign-in needed: the page redirected to a sign-in form. Pages behind a sign-in aren\'t supported yet.';
				continue;
			}
			if (fetchedPage.kind === 'outside') {
				failed++;
				firstError ??= `${url}: redirected to ${fetchedPage.to}, outside this source`;
				continue;
			}
			const response = fetchedPage.response;
			if (response.status === 304) {
				unchangedCount++;
				unchanged.push(url);
				await flush(false);
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
			const read = await readCapped(response, maxPageBytes).catch(() => undefined);
			if (!read) {
				continue;
			}
			const body = read.text;
			bytes += read.bytes;
			batched += read.bytes;
			fetched++;
			pages.push({ url, body, type, etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined });
			if (mode === 'links' && type === 'html' && depth < maxDepth) {
				for (const link of extractLinks(body, fetchedPage.url)) {
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

async function discover(start: URL, inScope: (url: string) => boolean, robotsSitemaps: readonly string[], options: CrawlOptions, reach: Reach): Promise<{ mode: CrawlMode; urls: string[]; full?: DocsPage }> {
	const dir = start.pathname.endsWith('/') ? start.pathname : `${start.pathname}/`;
	// A list of pages at the address, else the site's, filtered to the address.
	const roots = options.scope === 'site' ? ['/'] : dir === '/' ? [dir] : [dir, '/'];
	// The whole docs in one file, only at the address itself: the site's own would cover more than was asked.
	const fullUrl = `${start.origin}${options.scope === 'site' ? '/' : dir}llms-full.txt`;
	const full = await tryText(options, reach, fullUrl);
	if (full) {
		return { mode: 'llms-full', urls: [], full: { url: fullUrl, body: full.body, type: 'markdown', etag: full.etag, lastModified: full.lastModified } };
	}
	for (const root of roots) {
		const list = await tryText(options, reach, `${start.origin}${root}llms.txt`);
		if (list) {
			const urls = markdownLinks(list.body, `${start.origin}${root}`).filter(inScope);
			if (urls.length) {
				return { mode: 'llms', urls };
			}
		}
	}
	// A sitemap named by robots.txt or a sitemap index is fetched only from a host the source may reach.
	const allowedSitemap = (url: string) => {
		try {
			const parsed = new URL(url);
			return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && (!options.allowedHost || options.allowedHost(parsed.hostname));
		} catch {
			return false;
		}
	};
	const listed = robotsSitemaps.filter(allowedSitemap);
	const sitemaps = listed.length ? [...listed] : [`${start.origin}/sitemap.xml`];
	const urls: string[] = [];
	for (let i = 0; i < sitemaps.length && i < maxSitemaps; i++) {
		const map = await tryText(options, reach, sitemaps[i]);
		if (!map) {
			continue;
		}
		const locs = [...map.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => decodeXml(m[1]));
		if (/<sitemapindex/i.test(map.body)) {
			sitemaps.push(...locs.filter(loc => !sitemaps.includes(loc) && allowedSitemap(loc)));
		} else {
			urls.push(...locs.filter(inScope));
		}
	}
	return urls.length ? { mode: 'sitemap', urls: [...new Set(urls)] } : { mode: 'links', urls: [] };
}

async function tryText(options: CrawlOptions, reach: Reach, url: string): Promise<{ body: string; etag?: string; lastModified?: string } | undefined> {
	try {
		const fetched = await request(options, reach, url, {});
		if (fetched.kind !== 'response') {
			return undefined;
		}
		const response = fetched.response;
		const type = response.headers.get('content-type') ?? '';
		if (!response.ok || /text\/html/i.test(type)) {
			// A site that answers every path with its HTML app has no such file.
			await response.body?.cancel().catch(() => undefined);
			return undefined;
		}
		const read = await readCapped(response, maxPageBytes * 2);
		return read ? { body: read.text, etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined } : undefined;
	} catch {
		return undefined;
	}
}

type Fetched =
	| { readonly kind: 'response'; readonly response: Response; readonly url: string }
	| { readonly kind: 'sign-in' }
	| { readonly kind: 'outside'; readonly to: string };

/**
 * Asks for `url`, following up to five redirects by hand: each hop must be
 * one the crawl may reach and, for a page, within `scope`. A redirect to a
 * sign-in form is reported as such.
 */
async function request(options: CrawlOptions, reach: Reach, url: string, headers: Record<string, string>, scope?: (url: string) => boolean): Promise<Fetched> {
	let current = new URL(url);
	for (let hop = 0; ; hop++) {
		if (!await reach.may(current)) {
			return { kind: 'outside', to: current.href };
		}
		const timeout = AbortSignal.timeout(timeoutMs);
		const response = await options.fetch(current.href, {
			headers: { 'User-Agent': options.userAgent ?? 'GeminiCode-Docs', Accept: 'text/html,text/markdown,text/plain;q=0.9,*/*;q=0.5', ...headers },
			redirect: 'manual',
			signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
		});
		const location = response.headers.get('location');
		if (response.status < 300 || response.status >= 400 || response.status === 304 || !location) {
			return { kind: 'response', response, url: current.href };
		}
		await response.body?.cancel().catch(() => undefined);
		if (hop >= maxRedirects) {
			throw new Error('too many redirects');
		}
		let next: URL;
		try {
			next = new URL(location, current);
		} catch {
			throw new Error(`a redirect to ${location}, which is not an address`);
		}
		if (isSignIn(next, reach.start)) {
			return { kind: 'sign-in' };
		}
		if (scope && !scope(next.href)) {
			return { kind: 'outside', to: next.href };
		}
		current = next;
	}
}

/**
 * A response's body as text, read until `maxBytes` and no further: the
 * stream is cancelled past the cap, so a server that sends no length (or a
 * false one) can't make the crawler hold more. Undefined when it was cut.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<{ readonly text: string; readonly bytes: number } | undefined> {
	const reader = response.body?.getReader();
	if (!reader) {
		return { text: '', bytes: 0 };
	}
	const decoder = new TextDecoder();
	let text = '';
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		bytes += value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel().catch(() => undefined);
			return undefined;
		}
		text += decoder.decode(value, { stream: true });
	}
	return { text: text + decoder.decode(), bytes };
}

async function readRobots(origin: string, options: CrawlOptions, reach: Reach): Promise<{ allowed: (pathname: string) => boolean; sitemaps: string[] }> {
	const robots = await tryText(options, reach, `${origin}/robots.txt`);
	return robots ? parseRobots(robots.body) : { allowed: () => true, sitemaps: [] };
}

/**
 * Where the crawl may go: http and https, allowed hosts, and no private,
 * loopback or link-local address unless the source's own address is one
 * (documentation on the company network). Host names are resolved once each.
 */
async function reachOf(start: URL, options: CrawlOptions): Promise<Reach> {
	const lookup = options.lookup ?? (async (host: string) => (await dns.lookup(host, { all: true })).map(entry => entry.address));
	const verdicts = new Map<string, Promise<boolean>>();
	const isPrivateHost = (host: string) => {
		let verdict = verdicts.get(host);
		if (!verdict) {
			verdict = hostIsPrivate(host, lookup);
			verdicts.set(host, verdict);
		}
		return verdict;
	};
	const privateAllowed = await isPrivateHost(start.hostname);
	return {
		start,
		may: async url => (url.protocol === 'https:' || url.protocol === 'http:')
			&& (!options.allowedHost || options.allowedHost(url.hostname))
			&& (privateAllowed || !await isPrivateHost(url.hostname)),
	};
}

/** Whether `host` is, or resolves to, a private, loopback or link-local address. A name that doesn't resolve is left to the request to fail. */
async function hostIsPrivate(host: string, lookup: (host: string) => Promise<readonly string[]>): Promise<boolean> {
	const name = host.replace(/^\[|\]$/g, '').toLowerCase();
	if (name === 'localhost' || name.endsWith('.localhost')) {
		return true;
	}
	if (isIP(name)) {
		return isPrivateAddress(name);
	}
	try {
		return (await lookup(name)).some(isPrivateAddress);
	} catch {
		return false;
	}
}

/** Whether an IP address is private, loopback, link-local, shared (CGNAT) or unspecified. */
export function isPrivateAddress(address: string): boolean {
	const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
	if (isIP(ip) === 4 || mapped) {
		const [a, b] = (mapped ?? ip).split('.').map(Number);
		return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
	}
	if (isIP(ip) === 6) {
		return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
	}
	return false;
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
