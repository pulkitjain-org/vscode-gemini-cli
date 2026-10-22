/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs axe-core on the built site's pages in a headless Chromium and fails on
// any violation, so the download page and the docs keep passing before they
// are published. Needs axe-core and playwright-core, installed next to this
// script or on NODE_PATH, and a Chromium: CHROMIUM names its executable, else
// the usual names are tried.
//
//   node gemini/site/check-a11y.mts <site folder> [page.html ...]
//
// With no pages named, it checks the landing page, the feature pages, the docs
// home and every docs page.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const [site, ...named] = process.argv.slice(2);
if (!site) {
	console.error('Pass the built site folder.');
	process.exit(2);
}
const folder = (name: string) => existsSync(path.join(site, name)) ? readdirSync(path.join(site, name)).filter(file => file.endsWith('.html')).map(file => `${name}/${file}`) : [];
// A moved page's stand-in only sends the visitor on, so it has nothing to check.
const moved = (page: string) => readFileSync(path.join(site, page), 'utf8').includes('http-equiv="refresh"');
const pages = named.length ? named : ['index.html', 'notes.html', ...folder('features'), ...folder('docs')].filter(page => existsSync(path.join(site, page)) && !moved(page));

const candidates = [process.env.CHROMIUM, process.env.CHROME_PATH, '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const executablePath = candidates.find(p => existsSync(p));
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
let bad = 0;
for (const page of pages) {
	const tab = await browser.newPage();
	await tab.goto(`file://${path.resolve(site, page)}`);
	await tab.addScriptTag({ content: axeSource });
	const result = await tab.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] } }));
	console.log(`${page}: ${result.violations.length} violations, ${result.passes.length} rules passed`);
	for (const v of result.violations) {
		bad++;
		console.log(`  ${v.impact}: ${v.id}, ${v.help} (${v.nodes.length} nodes, for example ${v.nodes[0]?.target?.join(' ')})`);
	}
	await tab.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
