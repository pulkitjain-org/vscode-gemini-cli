/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawl, CrawlOptions, domainAllowed, isPrivateAddress, markdownLinks, parseRobots, readCapped, scopeOf } from '../../../src/acp/docs/crawler';
import type { DocsPage } from '../../../src/acp/index/indexerProtocol';

type Route = { status?: number; type?: string; body?: string; headers?: Record<string, string>; redirect?: string };

describe('crawl', () => {
	let origin = '';
	const routes = new Map<string, Route>();
	const requested: string[] = [];
	const server = http.createServer((req, res) => {
		requested.push(req.url ?? '');
		const route = routes.get(req.url ?? '');
		if (!route) {
			res.writeHead(404).end();
			return;
		}
		if (route.redirect) {
			res.writeHead(302, { Location: route.redirect }).end();
			return;
		}
		const etag = route.headers?.ETag;
		if (etag && req.headers['if-none-match'] === etag) {
			res.writeHead(304).end();
			return;
		}
		res.writeHead(route.status ?? 200, { 'Content-Type': route.type ?? 'text/html', ...route.headers }).end(route.body ?? '');
	});

	beforeAll(async () => {
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => server.close());

	const run = async (options: Partial<CrawlOptions> & { url: string }) => {
		const pages: DocsPage[] = [];
		const unchanged: string[] = [];
		requested.length = 0;
		const result = await crawl({ scope: 'prefix', maxPages: 50, validators: {}, fetch, delayMs: 0, onBatch: async (p, u) => { pages.push(...p); unchanged.push(...u); }, ...options });
		return { result, pages: pages.map(p => p.url.slice(origin.length)).sort(), unchanged: unchanged.map(u => u.slice(origin.length)) };
	};

	it('uses llms.txt, keeping to the address\'s path', async () => {
		routes.clear();
		routes.set('/docs/llms.txt', { type: 'text/plain', body: `# Docs\n\n- [Intro](/docs/intro): start\n- [API](${'API_ORIGIN'}/docs/api.md)\n- [Blog](/blog/post)\n` });
		routes.set('/docs/intro', { body: '<main><h1>Intro</h1></main>' });
		routes.set('/docs/api.md', { type: 'text/markdown', body: '# API' });
		routes.get('/docs/llms.txt')!.body = routes.get('/docs/llms.txt')!.body!.replace('API_ORIGIN', origin);
		const { result, pages } = await run({ url: `${origin}/docs` });
		expect(result).toMatchObject({ mode: 'llms', fetched: 2, failed: 0 });
		expect(pages).toEqual(['/docs/api.md', '/docs/intro']);
	});

	it('uses llms-full.txt as one page when the address has it', async () => {
		routes.clear();
		routes.set('/guide/llms-full.txt', { type: 'text/plain', body: '# Guide\n\n## One\n\nText.' });
		const { result, pages } = await run({ url: `${origin}/guide/` });
		expect(result).toMatchObject({ mode: 'llms-full', fetched: 1 });
		expect(pages).toEqual(['/guide/llms-full.txt']);
	});

	it('reads a sitemap index from robots.txt, and skips what robots.txt disallows', async () => {
		routes.clear();
		routes.set('/robots.txt', { type: 'text/plain', body: `User-agent: *\nDisallow: /ref/private\nSitemap: ${origin}/sitemap-index.xml\n` });
		routes.set('/sitemap-index.xml', { type: 'application/xml', body: `<sitemapindex><sitemap><loc>${origin}/sitemap-ref.xml</loc></sitemap></sitemapindex>` });
		routes.set('/sitemap-ref.xml', { type: 'application/xml', body: `<urlset><url><loc>${origin}/ref/a</loc></url><url><loc>${origin}/ref/private/b</loc></url><url><loc>${origin}/other</loc></url></urlset>` });
		routes.set('/ref/a', { body: '<h1>A</h1>' });
		routes.set('/ref/private/b', { body: '<h1>B</h1>' });
		const { result, pages } = await run({ url: `${origin}/ref` });
		expect(result).toMatchObject({ mode: 'sitemap', fetched: 1, blockedByRobots: 1 });
		expect(pages).toEqual(['/ref/a']);
	});

	it('follows links under the address when the site lists no pages, within the page limit', async () => {
		routes.clear();
		routes.set('/kb/', { body: `<a href="/kb/one">1</a><a href="two#part">2</a><a href="/elsewhere">x</a><a href="${origin}/kb/logo.png">logo</a>` });
		routes.set('/kb/one', { body: '<a href="/kb/three">3</a>' });
		routes.set('/kb/two', { body: '<p>two</p>' });
		routes.set('/kb/three', { body: '<p>three</p>' });
		const all = await run({ url: `${origin}/kb/` });
		expect(all.result).toMatchObject({ mode: 'links', fetched: 4 });
		expect(all.pages).toEqual(['/kb/', '/kb/one', '/kb/three', '/kb/two']);
		const limited = await run({ url: `${origin}/kb/`, maxPages: 2 });
		expect(limited.pages).toHaveLength(2);
	});

	it('asks for a page again only if it changed', async () => {
		routes.clear();
		routes.set('/p', { body: '<h1>P</h1>', headers: { ETag: '"v1"' } });
		const { result, unchanged } = await run({ url: `${origin}/p`, scope: 'page', validators: { [`${origin}/p`]: { etag: '"v1"' } } });
		expect(result).toMatchObject({ mode: 'page', fetched: 0, unchanged: 1 });
		expect(unchanged).toEqual(['/p']);
	});

	it('reports a page behind a sign-in, and refuses a site that is not allowed', async () => {
		routes.clear();
		routes.set('/wiki/runbook', { redirect: '/login?next=/wiki/runbook' });
		routes.set('/login?next=/wiki/runbook', { body: '<form>Sign in</form>' });
		const { result } = await run({ url: `${origin}/wiki/runbook`, scope: 'page' });
		expect(result.error).toBe('Sign-in needed: the page redirected to a sign-in form. Pages behind a sign-in aren\'t supported yet.');
		await expect(crawl({ url: `${origin}/x`, scope: 'page', maxPages: 1, validators: {}, fetch, onBatch: async () => undefined, allowedHost: host => domainAllowed(host, ['react.dev']) }))
			.rejects.toThrow('127.0.0.1 is not in gemini.docs.allowedDomains.');
	});

	it('follows a redirect only to an allowed host within the source\'s scope', async () => {
		routes.clear();
		routes.set('/docs/away', { redirect: 'http://elsewhere.invalid/docs/away' });
		routes.set('/docs/moved', { redirect: '/blog/moved' });
		routes.set('/docs/renamed', { redirect: '/docs/new-name' });
		routes.set('/docs/new-name', { body: '<h1>New</h1>' });
		routes.set('/docs/llms.txt', { type: 'text/plain', body: '- [A](/docs/away)\n- [M](/docs/moved)\n- [R](/docs/renamed)\n' });
		const { result, pages } = await run({ url: `${origin}/docs`, allowedHost: host => host === '127.0.0.1' });
		expect(result).toMatchObject({ mode: 'llms', fetched: 1, failed: 2 });
		expect(pages).toEqual(['/docs/renamed']);
		const away = await run({ url: `${origin}/docs/away`, scope: 'page', allowedHost: host => host === '127.0.0.1' });
		expect(away.result.error).toBe(`${origin}/docs/away: redirected to http://elsewhere.invalid/docs/away, outside this source`);
	});

	it('fetches sitemaps only from allowed hosts', async () => {
		routes.clear();
		routes.set('/robots.txt', { type: 'text/plain', body: 'Sitemap: http://elsewhere.invalid/sitemap.xml\n' });
		routes.set('/sitemap.xml', { type: 'application/xml', body: `<sitemapindex><sitemap><loc>http://elsewhere.invalid/more.xml</loc></sitemap><sitemap><loc>${origin}/s2.xml</loc></sitemap></sitemapindex>` });
		routes.set('/s2.xml', { type: 'application/xml', body: `<urlset><url><loc>${origin}/ref/a</loc></url></urlset>` });
		routes.set('/ref/a', { body: '<h1>A</h1>' });
		const { result, pages } = await run({ url: `${origin}/ref`, allowedHost: host => host === '127.0.0.1' });
		expect(result).toMatchObject({ mode: 'sitemap', fetched: 1 });
		expect(pages).toEqual(['/ref/a']);
		expect(requested).toEqual(expect.arrayContaining(['/robots.txt', '/sitemap.xml', '/s2.xml']));
	});

	it('sends pages to the indexer in batches of at most about 8 MB', async () => {
		routes.clear();
		const big = `<main><p>${'x'.repeat(3 * 1024 * 1024)}</p></main>`;
		for (const name of ['a', 'b', 'c', 'd']) {
			routes.set(`/big/${name}`, { body: big });
		}
		routes.set('/big/llms.txt', { type: 'text/plain', body: '- [a](/big/a)\n- [b](/big/b)\n- [c](/big/c)\n- [d](/big/d)\n' });
		const batches: number[] = [];
		const result = await crawl({ url: `${origin}/big`, scope: 'prefix', maxPages: 50, validators: {}, fetch, delayMs: 0, onBatch: async pages => { batches.push(pages.length); } });
		expect(result).toMatchObject({ fetched: 4 });
		expect(batches).toEqual([3, 1]);
	});
});

describe('crawl, from a public address', () => {
	it('never asks a private or loopback address, through redirects, robots.txt or sitemaps', async () => {
		const asked: string[] = [];
		const addresses: Record<string, string[]> = { 'docs.example.com': ['93.184.216.34'], 'intranet.example.com': ['10.1.2.3'] };
		const answers: Record<string, () => Response> = {
			'https://docs.example.com/robots.txt': () => new Response('Sitemap: https://intranet.example.com/sitemap.xml\n', { headers: { 'Content-Type': 'text/plain' } }),
			'https://docs.example.com/guide/llms.txt': () => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } }),
			'https://docs.example.com/sitemap.xml': () => new Response('<sitemapindex><sitemap><loc>http://127.0.0.1:9/s.xml</loc></sitemap></sitemapindex>', { headers: { 'Content-Type': 'application/xml' } }),
			'https://docs.example.com/guide/': () => new Response('<main><h1>Guide</h1><a href="https://docs.example.com/guide/next">n</a></main>', { headers: { 'Content-Type': 'text/html' } }),
			'https://docs.example.com/guide/next': () => new Response(null, { status: 301, headers: { Location: 'https://localhost/guide/next' } }),
		};
		const fakeFetch = (async (url: string | URL | Request) => {
			const href = String(url);
			asked.push(href);
			return answers[href]?.() ?? new Response('', { status: 404 });
		}) as typeof fetch;
		const pages: string[] = [];
		const result = await crawl({
			url: 'https://docs.example.com/guide/', scope: 'site', maxPages: 10, validators: {}, fetch: fakeFetch, delayMs: 0,
			lookup: async host => addresses[host] ?? ['93.184.216.34'],
			onBatch: async batch => { pages.push(...batch.map(p => p.url)); },
		});
		expect(pages).toEqual(['https://docs.example.com/guide/']);
		expect(result).toMatchObject({ mode: 'links', fetched: 1, failed: 1 });
		expect(asked.filter(url => !url.startsWith('https://docs.example.com/'))).toEqual([]);
	});

	it('knows private, loopback, link-local and shared addresses', () => {
		expect(['10.0.0.1', '172.16.5.4', '172.32.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '8.8.8.8', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '2001:4860::8888'].map(isPrivateAddress))
			.toEqual([true, true, false, true, true, true, true, false, true, true, true, true, false]);
	});

	it('stops reading a body past its cap, whatever length the server gives', async () => {
		let pulled = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull: controller => {
				pulled++;
				controller.enqueue(new Uint8Array(64 * 1024));
			},
		});
		expect(await readCapped(new Response(stream), 1024 * 1024)).toBeUndefined();
		expect(pulled).toBeLessThan(20);
		expect(await readCapped(new Response('small'), 1024)).toEqual({ text: 'small', bytes: 5 });
	});
});

describe('docs helpers', () => {
	it('keeps a prefix source to its path, and treats a file\'s address as its folder', () => {
		const inReference = scopeOf(new URL('https://react.dev/reference'), 'prefix');
		const inDocs = scopeOf(new URL('https://x.dev/docs/intro.html'), 'prefix');
		expect([
			inReference('https://react.dev/reference'), inReference('https://react.dev/reference/react/useEffect'), inReference('https://react.dev/references'), inReference('https://react.dev/learn'),
			inDocs('https://x.dev/docs/api.html'), inDocs('https://x.dev/blog/'),
		]).toEqual([true, true, false, false, true, false]);
	});

	it('reads robots.txt rules for this fetcher, longest match first', () => {
		const robots = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: GeminiCode\nDisallow: /private\nAllow: /private/public\nSitemap: https://x.dev/s.xml');
		expect([robots.allowed('/docs'), robots.allowed('/private/x'), robots.allowed('/private/public/y'), robots.sitemaps]).toEqual([true, false, true, ['https://x.dev/s.xml']]);
		expect(parseRobots('User-agent: *\nDisallow: /*.pdf$').allowed('/a.pdf')).toBe(false);
	});

	it('matches allowed domains, and reads links from llms.txt', () => {
		expect(['react.dev', 'docs.example.com', 'example.com', 'evil.dev'].map(h => domainAllowed(h, ['react.dev', '*.example.com']))).toEqual([true, true, true, false]);
		expect(domainAllowed('anything.dev', [])).toBe(true);
		expect(markdownLinks('- [A](/a.md)\n- [B](https://b.dev/b "B")', 'https://x.dev/docs/')).toEqual(['https://x.dev/a.md', 'https://b.dev/b']);
	});
});
