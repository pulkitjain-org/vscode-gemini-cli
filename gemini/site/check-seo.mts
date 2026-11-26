/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks what the built site tells search engines, link previews and AI tools, and fails on
// the first kind of mistake it finds on any page. Every page needs a unique title, a
// description of at most 160 characters, a canonical address that is a page of the site,
// Open Graph tags whose image exists, and JSON-LD that parses; a clip's VideoObject must name a
// thumbnail and a video that exist, a date and a duration. sitemap.xml must list exactly
// the pages that may be indexed, llms.txt may link only files that exist, and 404.html must
// be there and say noindex. Needs nothing installed.
//
//   node gemini/site/check-seo.mts <site folder>

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const site = process.argv[2];
if (!site) {
	console.error('Pass the built site folder.');
	process.exit(2);
}
const siteUrl = (JSON.parse(readFileSync(path.join(site, 'latest.json'), 'utf8')) as { url: string }).url;
const problems: string[] = [];

/** The built file an address on the site is served from, or undefined for an address elsewhere. */
function fileFor(url: string): string | undefined {
	if (!url.startsWith(siteUrl)) {
		return undefined;
	}
	const at = url.slice(siteUrl.length).replace(/[#?].*$/, '');
	return !at || at.endsWith('/') ? `${at}index.html` : at;
}

function htmlFiles(dir = ''): string[] {
	return readdirSync(path.join(site, dir), { withFileTypes: true }).flatMap(entry => {
		const at = dir ? `${dir}/${entry.name}` : entry.name;
		return entry.isDirectory() ? (entry.name === 'media' || entry.name === 'fonts' ? [] : htmlFiles(at)) : entry.name.endsWith('.html') ? [at] : [];
	});
}

function decode(value: string): string {
	return value.replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const titles = new Map<string, string>();
const indexable = new Set<string>();
for (const page of htmlFiles()) {
	const html = readFileSync(path.join(site, page), 'utf8');
	// A moved page's stand-in only sends the visitor on.
	if (html.includes('http-equiv="refresh"')) {
		continue;
	}
	const say = (problem: string) => problems.push(`${page}: ${problem}`);
	const meta = (key: string) => {
		const match = new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`).exec(html);
		return match ? decode(match[1]) : undefined;
	};
	const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
	if (!title) {
		say('no title');
	} else if (titles.has(title)) {
		say(`the same title as ${titles.get(title)}: ${title}`);
	} else {
		titles.set(title, page);
	}
	const description = meta('description');
	if (!description || description.length > 160) {
		say(`the description must be 1 to 160 characters, not ${description?.length ?? 0}`);
	}
	const canonical = /<link rel="canonical" href="([^"]+)">/.exec(html)?.[1];
	const canonicalFile = canonical && fileFor(canonical);
	if (!canonicalFile || !existsSync(path.join(site, canonicalFile))) {
		say(`its canonical address, ${canonical ?? 'missing'}, is not a page of the site`);
	}
	for (const key of ['og:title', 'og:description', 'og:url', 'og:image', 'og:image:alt', 'twitter:card']) {
		if (!meta(key)) {
			say(`no ${key}`);
		}
	}
	const image = meta('og:image');
	const imageFile = image && fileFor(image);
	if (image && (!imageFile || !existsSync(path.join(site, imageFile)))) {
		say(`its preview image, ${image}, is not in the site`);
	}
	if (meta('og:url') && meta('og:url') !== canonical) {
		say('og:url is not the canonical address');
	}
	for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
		let graph: { '@type'?: string; [key: string]: unknown }[] = [];
		try {
			graph = (JSON.parse(json) as { '@graph'?: typeof graph })['@graph'] ?? [];
		} catch (error) {
			say(`JSON-LD that doesn't parse: ${(error as Error).message}`);
		}
		for (const video of graph.filter(entry => entry['@type'] === 'VideoObject')) {
			for (const key of ['thumbnailUrl', 'contentUrl'] as const) {
				const file = typeof video[key] === 'string' ? fileFor(video[key]) : undefined;
				if (!file || !existsSync(path.join(site, file))) {
					say(`a VideoObject's ${key}, ${String(video[key])}, is not in the site`);
				}
			}
			if (typeof video.uploadDate !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(video.uploadDate) || Number.isNaN(Date.parse(video.uploadDate))) {
				say(`a VideoObject's uploadDate is not a date and time with a time zone: ${String(video.name)}, ${String(video.uploadDate)}`);
			}
			if (typeof video.duration !== 'string' || !/^PT\d+S$/.test(video.duration)) {
				say(`a VideoObject has no duration: ${String(video.name)}`);
			}
		}
	}
	const noindex = html.includes('<meta name="robots" content="noindex">');
	if (page === '404.html' && !noindex) {
		say('the 404 page must say noindex');
	}
	if (!noindex && canonical) {
		indexable.add(canonical);
	}
}
if (!existsSync(path.join(site, '404.html'))) {
	problems.push('404.html is missing');
}

const sitemapFile = path.join(site, 'sitemap.xml');
if (existsSync(sitemapFile)) {
	const listed = new Set([...readFileSync(sitemapFile, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => decode(match[1])));
	for (const url of indexable) {
		if (!listed.has(url)) {
			problems.push(`sitemap.xml: ${url} is missing`);
		}
	}
	for (const url of listed) {
		if (!indexable.has(url)) {
			problems.push(`sitemap.xml: ${url} is not an indexable page`);
		}
	}
} else {
	problems.push('sitemap.xml is missing');
}

const llmsFile = path.join(site, 'llms.txt');
if (existsSync(llmsFile)) {
	const llms = readFileSync(llmsFile, 'utf8');
	if (!llms.startsWith('# ')) {
		problems.push('llms.txt must start with a # heading');
	}
	for (const [, url] of llms.matchAll(/\]\((https?:[^)\s]+)\)/g)) {
		const file = fileFor(url);
		if (file && !existsSync(path.join(site, file))) {
			problems.push(`llms.txt links ${url}, which is not in the site`);
		}
	}
} else {
	problems.push('llms.txt is missing');
}

for (const problem of problems) {
	console.log(problem);
}
console.log(problems.length ? `${problems.length} problems.` : `Checked ${titles.size} pages, sitemap.xml and llms.txt: no problems.`);
process.exit(problems.length ? 1 : 0);
