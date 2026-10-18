/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs Lighthouse on the built site and fails when a score is under its
// floor: accessibility 100, performance 90, best practices 90, SEO 90. The
// site is served from a folder on a local port, gzipped as GitHub Pages
// serves it, since Lighthouse wants a URL and scores the bytes transferred.
// Needs the lighthouse package, installed next to this script or on
// NODE_PATH, and a Chrome or Chromium: CHROME_PATH names it, else Lighthouse
// finds one.
//
//   node gemini/site/check-lighthouse.mjs <site folder> [page.html ...]

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const [site, ...named] = process.argv.slice(2);
if (!site) {
	console.error('Pass the built site folder.');
	process.exit(2);
}
const pages = named.length ? named : ['index.html', 'docs/index.html'].filter(page => existsSync(path.join(site, page)));
const floors = { performance: 90, accessibility: 100, 'best-practices': 90, seo: 90 };
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.png': 'image/png', '.md': 'text/markdown' };

const server = createServer((req, res) => {
	let file = path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
	if (file.endsWith('/')) {
		file += 'index.html';
	}
	try {
		const body = readFileSync(path.join(site, file));
		const type = types[path.extname(file)] ?? 'application/octet-stream';
		// GitHub Pages compresses text, and Lighthouse scores the bytes transferred, so the local server does too.
		if (/^(text\/|application\/json|image\/svg)/.test(type) && /gzip/.test(req.headers['accept-encoding'] ?? '')) {
			res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip' }).end(gzipSync(body));
			return;
		}
		res.writeHead(200, { 'content-type': type }).end(body);
	} catch {
		res.writeHead(404).end('not found');
	}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const lighthouse = require.resolve('lighthouse/cli/index.js');
const chrome = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(p => existsSync(p));
let bad = 0;
for (const page of pages) {
	const out = path.join(site, `lighthouse-${page.replace(/[^\w]+/g, '-')}.json`);
	const code = await new Promise(resolve => spawn(process.execPath, [lighthouse, `http://127.0.0.1:${port}/${page}`, '--quiet', '--chrome-flags=--headless=new --no-sandbox', '--only-categories=performance,accessibility,best-practices,seo', '--output=json', `--output-path=${out}`], { stdio: 'inherit', env: { ...process.env, ...chrome ? { CHROME_PATH: chrome } : {} } }).on('close', resolve));
	if (code !== 0) {
		console.log(`${page}: Lighthouse exited with ${code}`);
		bad++;
		continue;
	}
	const report = JSON.parse(readFileSync(out, 'utf8'));
	const scores = Object.fromEntries(Object.entries(report.categories).map(([id, category]) => [id, Math.round(category.score * 100)]));
	const audits = report.audits;
	console.log(`${page}: ${Object.entries(scores).map(([id, score]) => `${id} ${score}`).join(', ')}; LCP ${audits['largest-contentful-paint']?.displayValue}, TBT ${audits['total-blocking-time']?.displayValue}`);
	for (const [id, floor] of Object.entries(floors)) {
		if ((scores[id] ?? 0) < floor) {
			bad++;
			console.log(`  ${id} is ${scores[id]}, under ${floor}. Failing audits: ${report.categories[id].auditRefs.map(ref => audits[ref.id]).filter(a => a && a.score !== null && a.score < 1).map(a => `${a.id} (${a.displayValue ?? ''})`).join(', ')}`);
		}
	}
}
server.close();
process.exit(bad ? 1 : 0);
