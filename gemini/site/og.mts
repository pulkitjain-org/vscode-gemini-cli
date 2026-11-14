/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Makes the link preview images in media/og/ and the repository's social preview, as JPEG cards
// in the site's fonts and palette.
//
// The site's cards are 1200 x 630: the mark, the page's name and its headline, over the page's
// light screenshot. Everything that matters is in the middle 630 x 630, since some apps crop
// previews square. The `github` card is 1280 x 640, GitHub's size: the mark, the name and the
// headline in the dark palette, with no screenshot, so it stays true across releases. It is written to
// gemini/branding/social-preview.jpg for the repository's Settings > General > Social preview.
// Run it when a card's screenshot is retaken or its words change:
//
//   node gemini/site/og.mts [name ...]
//
// It needs Google Chrome (or CHROME_PATH) to draw each card and ffmpeg to write the JPEG.
// The cards' alt text is in ogImages in build.mts.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

interface Card {
	/** The headline's two lines; the second is set in italic. */
	readonly lines: readonly [string, string];
	/** A site card's page name beside the wordmark. */
	readonly label?: string;
	/** A site card's light screenshot in media/, without `-light.webp`. */
	readonly shot?: string;
	/** Width and height when not 1200 x 630. */
	readonly size?: readonly [number, number];
	/** Where to write the card, from the repository's root, when not media/og/<name>.jpg. */
	readonly out?: string;
	/** The site's dark palette (Charcoal) instead of the light one (Paper). */
	readonly dark?: boolean;
}

const tagline = 'A VS Code fork with the official Gemini CLI built in.';

const cards: Readonly<Record<string, Card>> = {
	'home': { label: 'For Mac', lines: ['Code with Gemini agents.', 'Review every change.'], shot: 'home' },
	'agents': { label: 'Agents', lines: ['Several agents,', 'side by side.'], shot: 'index-page' },
	'chat-and-review': { label: 'Chat and review', lines: ['Keep or undo', 'every change.'], shot: 'showcase-review' },
	'projects': { label: 'Projects', lines: ['Split larger work', 'into threads.'], shot: 'project-threads' },
	'browser': { label: 'Browser', lines: ['A browser your', 'agents can use.'], shot: 'browser-page' },
	'team-tools': { label: 'Connected tools', lines: ['From the ticket', 'to the merge.'], shot: 'mr-review-diff' },
	'notes': { label: 'Release notes', lines: ['What\'s new', 'in GeminiCode.'], shot: 'home' },
	'github': { lines: ['Code with Gemini agents.', 'Review every change.'], size: [1280, 640], out: 'gemini/branding/social-preview.jpg', dark: true },
};

const siteDir = path.dirname(new URL(import.meta.url).pathname);
const repoDir = path.resolve(siteDir, '..', '..');
const font = (file: string) => pathToFileURL(path.join(siteDir, 'fonts', file)).href;
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** The mark: the tile, its frame, ring and star, in the given colours. */
function mark(size: number, tile: string, glyph: string): string {
	return `<svg width="${size}" height="${size}" viewBox="0 0 256 256"><rect x="16" y="16" width="224" height="224" rx="54" fill="${tile}"/><rect x="52" y="52" width="152" height="152" rx="34" stroke-width="16" fill="none" stroke="${glyph}"/><circle cx="128" cy="128" r="54" stroke-width="12" fill="none" stroke="${glyph}"/><path d="M128 94Q128 128 162 128Q128 128 128 162Q128 128 94 128Q128 128 128 94Z" fill="${glyph}"/></svg>`;
}

function page(card: Card, [width, height]: readonly [number, number]): string {
	const c = card.dark
		? { ground: '#141412', fg: '#F1EEE6', soft: '#A09E94', accent: '#3DBE8B', dot: 'rgb(241 238 230 / 0.16)', line: 'rgb(241 238 230 / 0.14)', tile: '#F4F2EC', glyph: '#16150F' }
		: { ground: '#F4F2EC', fg: '#16150F', soft: '#5E5D55', accent: '#0C6A51', dot: 'rgb(22 21 15 / 0.13)', line: 'rgb(22 21 15 / 0.16)', tile: '#16150F', glyph: '#F1EEE6' };
	const head = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Geist; font-weight: 100 900; src: url("${font('geist-latin-wght-normal.woff2')}"); }
@font-face { font-family: "Geist Mono"; font-weight: 100 900; src: url("${font('geist-mono-latin-wght-normal.woff2')}"); }
@font-face { font-family: Newsreader; font-weight: 200 800; src: url("${font('newsreader-latin-wght-normal.woff2')}"); }
@font-face { font-family: Newsreader; font-style: italic; font-weight: 200 800; src: url("${font('newsreader-latin-wght-italic.woff2')}"); }
* { margin: 0; box-sizing: border-box; }
html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
body { position: relative; background: ${c.ground}; color: ${c.fg}; font-family: Geist, sans-serif;
	background-image: radial-gradient(${c.dot} 1.2px, transparent 1.4px); background-size: 22px 22px; }
h1 { font-family: Newsreader, serif; font-weight: 500; letter-spacing: -0.02em; }
h1 em { display: block; font-weight: 400; color: ${c.accent}; }
`;
	const headline = `<h1>${escape(card.lines[0])}<em>${escape(card.lines[1])}</em></h1>`;
	if (!card.shot) {
		// The mark large on the left; the wordmark, headline and tagline beside it.
		return `${head}
body { display: flex; align-items: center; justify-content: center; gap: 64px; }
.text { width: 680px; }
.wm { font-size: 46px; font-weight: 600; letter-spacing: -0.02em; }
h1 { margin-top: 22px; font-size: 62px; line-height: 1.04; }
.tag { margin-top: 30px; padding-top: 24px; border-top: 2px solid ${c.line}; font-family: "Geist Mono", monospace; font-size: 19px; color: ${c.soft}; }
</style></head><body>
${mark(300, c.tile, c.glyph)}
<div class="text"><div class="wm">GeminiCode</div>${headline}<p class="tag">${escape(tagline)}</p></div>
</body></html>`;
	}
	const shot = pathToFileURL(path.join(siteDir, 'media', `${card.shot}-light.webp`)).href;
	return `${head}
body { text-align: center; }
.brand { position: absolute; left: 0; right: 0; top: 46px; display: flex; justify-content: center; align-items: center; gap: 12px; font-size: 25px; font-weight: 600; letter-spacing: -0.01em; }
.label { margin-left: 10px; padding-left: 20px; border-left: 2px solid ${c.line}; font-family: "Geist Mono", monospace; font-size: 16px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: ${c.accent}; }
h1 { position: absolute; left: 0; right: 0; top: 110px; font-size: 64px; line-height: 1.02; }
.frame { position: absolute; left: calc(50% - 500px); top: 290px; width: 1000px; height: 625px; border-radius: 16px; overflow: hidden;
	background: #FFFFFF url("${shot}") no-repeat 0 0 / 1000px 625px;
	box-shadow: 0 0 0 1px rgb(22 21 15 / 0.16), 0 24px 70px rgb(22 21 15 / 0.22); }
</style></head><body>
<div class="brand">${mark(40, c.tile, c.glyph)}GeminiCode<span class="label">${escape(card.label ?? '')}</span></div>
${headline}
<div class="frame"></div>
</body></html>`;
}

const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const names = process.argv.slice(2);
for (const name of names.length ? names : Object.keys(cards)) {
	const card = cards[name];
	if (!card) {
		throw new Error(`No card named ${name}; the cards are ${Object.keys(cards).join(', ')}.`);
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
	try {
		const html = path.join(dir, 'card.html');
		const png = path.join(dir, 'card.png');
		const size = card.size ?? [1200, 630];
		const out = card.out ?? path.relative(repoDir, path.join(siteDir, 'media', 'og', `${name}.jpg`));
		fs.writeFileSync(html, page(card, size));
		execFileSync(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--allow-file-access-from-files',
			`--window-size=${size[0]},${size[1]}`, '--virtual-time-budget=3000', `--user-data-dir=${path.join(dir, 'profile')}`, `--screenshot=${png}`, pathToFileURL(html).href], { stdio: 'ignore' });
		execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', png, '-q:v', '3', path.join(repoDir, out)]);
		console.log(out);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
