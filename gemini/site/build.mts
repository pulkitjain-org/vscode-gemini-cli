/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds the download page for GitHub Pages from the latest GitHub Release:
// `index.html` (the landing page), `notes.html` (the release notes, rendered
// from the markdown written in the release), and `latest.json`, which the
// app's update notice reads. Run on every release and on changes to this
// folder (.github/workflows/gemini-pages.yml).
//
// The landing page's feature sections are fixed in `renderPage`; edit them by
// hand when they change. Their screenshots and clips live in
// `gemini/site/media/`, each in a -dark and a -light copy (see `mediaFiles`);
// a missing one is left out. The showcase plays clips of the app with
// `showcase.mts` and `showcase.css`, and `page.mts` runs the theme switch, the
// particles and the pointer's light; the .mts files are served as plain
// JavaScript. The
// Geist fonts in `gemini/site/fonts/` are served with the page.
//
//   node gemini/site/build.mts <out-dir>            # needs GITHUB_REPOSITORY, uses GITHUB_TOKEN if set
//   node gemini/site/build.mts <out-dir> --sample   # a made-up release, to preview the page
//   node gemini/site/build.mts <out-dir> --none     # the page before the first release

import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

/** What `latest.json` holds. The app reads `version`, `url` and `notesUrl`; keep those stable. */
export interface LatestRelease {
	readonly schema: 1;
	/** Without the `v`, such as `0.1.0`; null before the first release. */
	readonly version: string | null;
	readonly name?: string;
	readonly publishedAt?: string;
	/** Whether the build is signed and notarized by Apple. */
	readonly signed?: boolean;
	/** The download page. */
	readonly url: string;
	/** The release on GitHub. */
	readonly notesUrl?: string;
	readonly downloads: {
		readonly 'darwin-arm64'?: { readonly name: string; readonly url: string; readonly size: number; readonly sha256?: string };
	};
}

interface GitHubAsset { readonly name: string; readonly browser_download_url: string; readonly size: number }
interface GitHubRelease {
	readonly tag_name: string;
	readonly draft?: boolean;
	readonly prerelease?: boolean;
	readonly name: string | null;
	readonly html_url: string;
	readonly published_at: string;
	readonly body_html?: string;
	readonly assets: readonly GitHubAsset[];
}

const siteDir = import.meta.dirname;
const dmgPattern = /^GeminiCode-.+-arm64(-unsigned)?\.dmg$/;
/**
 * The feature screenshots in `media/`, taken from the app at 1440 × 900
 * points: `<name>-dark.webp` and `<name>-light.webp`. The showcase's clips sit
 * beside them as `showcase-<view>-<theme>.mp4`, each with its last frame as a
 * .webp (see `showcaseViews`).
 */
const mediaFiles = {
	look: { name: 'look', width: 1400, height: 1000 },
	plus: { name: 'plus', width: 1400, height: 1000 },
	plan: { name: 'plan', width: 1400, height: 1000 },
	review: { name: 'review', width: 1600, height: 1000 },
	branch: { name: 'branch', width: 1600, height: 1000 },
	helpers: { name: 'helpers', width: 1600, height: 1000 },
} as const;
type Media = keyof typeof mediaFiles;

async function main(outDir: string | undefined, mode: string | undefined): Promise<void> {
	if (!outDir) {
		throw new Error('usage: build.mts <out-dir> [--sample | --none]');
	}
	const repo = process.env.GITHUB_REPOSITORY ?? 'pulkitjain-org/vscode-gemini-cli';
	const [owner, name] = repo.split('/');
	const pageUrl = `https://${owner.toLowerCase()}.github.io/${name}/`;
	const release = mode === '--sample' ? sampleRelease(repo) : mode === '--none' ? undefined : await fetchLatestRelease(repo);
	const latest = await toLatest(release, pageUrl);

	fs.mkdirSync(outDir, { recursive: true });
	const notesHtml = await copyNotesImages(release?.body_html ?? '', outDir);
	const mediaDir = path.join(siteDir, 'media');
	const available = new Set(fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : []);
	if (available.size) {
		fs.cpSync(mediaDir, path.join(outDir, 'media'), { recursive: true });
	}
	fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(latest, null, '\t') + '\n');
	fs.writeFileSync(path.join(outDir, 'index.html'), renderPage(latest, repo, available));
	fs.writeFileSync(path.join(outDir, 'notes.html'), renderNotesPage(latest, notesHtml, repo));
	for (const file of ['site.css', 'showcase.css']) {
		fs.copyFileSync(path.join(siteDir, file), path.join(outDir, file));
	}
	for (const script of ['page', 'showcase']) {
		fs.writeFileSync(path.join(outDir, `${script}.js`), toJavaScript(fs.readFileSync(path.join(siteDir, `${script}.mts`), 'utf8')));
	}
	fs.cpSync(path.join(siteDir, 'fonts'), path.join(outDir, 'fonts'), { recursive: true });
	fs.copyFileSync(path.join(siteDir, '..', 'branding', 'icon.svg'), path.join(outDir, 'icon.svg'));
	fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
	console.log(latest.version ? `Built the page for GeminiCode ${latest.version}.` : 'Built the page; there is no release yet.');
}

async function fetchLatestRelease(repo: string): Promise<GitHubRelease | undefined> {
	const headers: Record<string, string> = { accept: 'application/vnd.github.html+json', 'x-github-api-version': '2022-11-28' };
	if (process.env.GITHUB_TOKEN) {
		headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	}
	// `latest` skips drafts and prereleases.
	const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
	if (response.status === 404) {
		return undefined;
	}
	if (!response.ok) {
		throw new Error(`GitHub answered HTTP ${response.status} for the latest release.`);
	}
	const latest = await response.json() as GitHubRelease;
	if (hasDmg(latest)) {
		return latest;
	}
	// A release published by hand has no .dmg until gemini-release.yml uploads
	// it, which takes a while, and that upload rebuilds the page again. Until
	// then keep offering the newest release that has one, rather than "No
	// release yet" (and a latest.json without a version).
	const listed = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, { headers });
	if (!listed.ok) {
		throw new Error(`GitHub answered HTTP ${listed.status} for the list of releases.`);
	}
	const previous = (await listed.json() as GitHubRelease[]).find(release => !release.draft && !release.prerelease && hasDmg(release));
	console.log(`${latest.tag_name} has no .dmg yet; ${previous ? `showing ${previous.tag_name} until it does` : 'no earlier release has one either'}.`);
	return previous ?? latest;
}

function hasDmg(release: GitHubRelease): boolean {
	return release.assets.some(asset => dmgPattern.test(asset.name));
}

// Images pasted into release notes come back in `body_html` as
// private-user-images.githubusercontent.com links whose token expires five
// minutes later, so the page would show broken images from then on. Copy each
// one next to the page while its link still works and point the notes, both
// the image and the link GitHub wraps it in, at the copy. If a copy fails, use
// the image's permanent github.com/user-attachments link, which GitHub
// redirects to a fresh one.
const privateImagePattern = /(\s(?:src|href)=")(https:\/\/private-user-images\.githubusercontent\.com\/[^"]+)(")/g;
const attachmentIdPattern = /\/\d+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.[a-z0-9]+)?\?/i;

export async function copyNotesImages(notesHtml: string, outDir: string): Promise<string> {
	const sources = new Set(Array.from(notesHtml.matchAll(privateImagePattern), match => decodeEntities(match[2])));
	const replacements = new Map<string, string>();
	for (const source of sources) {
		const id = attachmentIdPattern.exec(source);
		if (!id) {
			continue;
		}
		const file = `notes/${id[1]}${id[2]?.toLowerCase() ?? ''}`;
		try {
			const response = await fetch(source);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			fs.mkdirSync(path.join(outDir, 'notes'), { recursive: true });
			fs.writeFileSync(path.join(outDir, file), Buffer.from(await response.arrayBuffer()));
			replacements.set(source, file);
		} catch (err) {
			console.warn(`Could not copy release notes image ${id[1]} (${err}); linking to GitHub instead.`);
			replacements.set(source, `https://github.com/user-attachments/assets/${id[1]}`);
		}
	}
	return notesHtml.replace(privateImagePattern, (match, before: string, source: string, after: string) => {
		const replacement = replacements.get(decodeEntities(source));
		return replacement ? `${before}${attr(replacement)}${after}` : match;
	});
}

function decodeEntities(value: string): string {
	return value.replace(/&amp;/g, '&');
}

async function toLatest(release: GitHubRelease | undefined, pageUrl: string): Promise<LatestRelease> {
	const dmg = release?.assets.find(asset => dmgPattern.test(asset.name));
	if (!release || !dmg) {
		return { schema: 1, version: null, url: pageUrl, downloads: {} };
	}
	const checksum = release.assets.find(asset => asset.name === `${dmg.name}.sha256`);
	const sha256 = checksum ? await fetchChecksum(checksum.browser_download_url) : undefined;
	return {
		schema: 1,
		version: release.tag_name.replace(/^v/, ''),
		name: release.name ?? release.tag_name,
		publishedAt: release.published_at,
		signed: !dmg.name.endsWith('-unsigned.dmg'),
		url: pageUrl,
		notesUrl: release.html_url,
		downloads: { 'darwin-arm64': { name: dmg.name, url: dmg.browser_download_url, size: dmg.size, ...(sha256 ? { sha256 } : {}) } },
	};
}

async function fetchChecksum(url: string): Promise<string | undefined> {
	if (url.startsWith('sample:')) {
		return url.slice('sample:'.length);
	}
	try {
		const response = await fetch(url);
		const hash = response.ok ? /^[0-9a-f]{64}/.exec(await response.text())?.[0] : undefined;
		return hash;
	} catch {
		return undefined;
	}
}

// ---- Shared page parts ----

interface Context {
	readonly repoUrl: string;
	readonly version: string | null;
	readonly dmg: LatestRelease['downloads']['darwin-arm64'];
	readonly sizeMb?: string;
	readonly releasedLong?: string;
	readonly releasedShort?: string;
}

function context(latest: LatestRelease, repo: string): Context {
	const dmg = latest.version ? latest.downloads['darwin-arm64'] : undefined;
	const date = latest.publishedAt ? new Date(latest.publishedAt) : undefined;
	const format = (month: 'long' | 'short') => date?.toLocaleDateString('en-GB', { day: 'numeric', month, year: 'numeric', timeZone: 'UTC' });
	return {
		repoUrl: `https://github.com/${repo}`,
		version: dmg ? latest.version : null,
		dmg,
		sizeMb: dmg ? (dmg.size / 1024 / 1024).toFixed(0) : undefined,
		releasedLong: format('long'),
		releasedShort: format('short'),
	};
}

// Icons from Lucide (lucide.dev, ISC License), drawn on a 24 × 24 grid.
const icons: Record<string, string> = {
	'apple': '<path d="M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06Z"/><path d="M10 2c1 .5 2 2 2 5"/>',
	'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
	'terminal': '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
	'github': '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
	'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
	'moon': '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
	'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
	'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
	'sparkles': '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
	'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
	'gauge': '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
	'zap': '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
	'list-checks': '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
	'hammer': '<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>',
	'bot': '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
	'git-compare': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
	'git-branch': '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
	'blocks': '<rect width="7" height="7" x="14" y="3" rx="1"/><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"/>',
	'wand-sparkles': '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
	'history': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
	'globe': '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
	'eye': '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
	'text-cursor-input': '<path d="M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1"/><path d="M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5"/><path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"/><path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"/><path d="M9 7v10"/>',
	'scan-search': '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/>',
	'bell': '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
	'layout-grid': '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
	'square-pen': '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
};

function sprite(): string {
	return `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${Object.entries(icons).map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`).join('')}</svg>`;
}

function icon(name: keyof typeof icons, cls = ''): string {
	return `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function layout(title: string, body: string, c: Context, current: 'home' | 'notes'): string {
	const home = current === 'home' ? '' : './';
	const get = c.dmg
		? `<a class="get" href="${attr(c.dmg.url)}">${icon('download')}<span>Download<span class="long"> for Mac</span></span></a>`
		: `<a class="get" href="${attr(c.repoUrl)}/releases">Releases</a>`;
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${text(title)}</title>
	<meta name="description" content="GeminiCode is a code editor with the Gemini CLI built in. Start Gemini agents side by side and review every change they make. Download it for Mac.">
	<link rel="icon" href="icon.svg" type="image/svg+xml">
	<link rel="preload" href="fonts/geist-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
	<link rel="stylesheet" href="site.css">${current === 'home' ? '\n\t<link rel="stylesheet" href="showcase.css">' : ''}
	<script>try { const t = localStorage.getItem('theme'); if (t === 'dark' || t === 'light') { document.documentElement.dataset.theme = t; } } catch {}</script>
	<script src="page.js" defer></script>${current === 'home' ? '\n\t<script src="showcase.js" defer></script>' : ''}
</head>
<body>
	${sprite()}
	<div class="backdrop" aria-hidden="true"></div>
	<canvas class="particles" aria-hidden="true"></canvas>
	<div class="spotlight" aria-hidden="true"></div>
	<header class="top">
		<div class="wrap">
			<a class="brand" href="./"><img src="icon.svg" alt=""><span>GeminiCode</span>${c.version ? `<span class="chip">v${text(c.version)}</span>` : ''}</a>
			<nav aria-label="Page">
				<a href="${home}#features">Features</a>
				<a href="${home}#showcase">Showcase</a>
				<a href="${home}#install">Install</a>
				<a href="notes.html"${current === 'notes' ? ' aria-current="page"' : ''}>Release notes</a>
				<a href="${attr(c.repoUrl)}/blob/main/gemini/docs/USING.md">Guide ${icon('arrow-up-right')}</a>
			</nav>
			<div class="right">
				<button class="icon-btn theme" type="button" aria-label="Switch between light and dark">${icon('sun', 'sun')}${icon('moon', 'moon')}</button>
				<a class="icon-btn github" href="${attr(c.repoUrl)}" aria-label="GeminiCode on GitHub">${icon('github')}</a>
				${get}
			</div>
		</div>
	</header>
	<main>
${body}
	</main>
	<footer class="foot">
		<div class="wrap">
			<a class="brand" href="./"><img src="icon.svg" alt=""><span>GeminiCode</span></a>
			<div class="spacer"></div>
			<a href="${attr(c.repoUrl)}/releases">All releases</a>
			<a href="${attr(c.repoUrl)}">Source</a>
			<a href="${attr(c.repoUrl)}/issues">Report a problem</a>
		</div>
	</footer>
</body>
</html>
`;
}

function unsignedNote(latest: LatestRelease): string {
	return latest.version && latest.signed === false ? `
			<aside class="note">
				<h3>This build is not signed by Apple yet</h3>
				<p>macOS blocks it the first time. After dragging GeminiCode to Applications, open it once and choose <b>Done</b>. Then open <b>System Settings → Privacy &amp; Security</b> and choose <b>Open Anyway</b> next to GeminiCode.</p>
				<p>Or run this in Terminal: <code>xattr -dr com.apple.quarantine /Applications/GeminiCode.app</code></p>
			</aside>` : '';
}

/**
 * A screenshot in the page's theme: the dark copy on a dark page, the
 * light one on a light page. Empty when either copy is missing.
 */
function themed(media: Media, available: ReadonlySet<string>, alt: string): string {
	const { name, width, height } = mediaFiles[media];
	if (!available.has(`${name}-dark.webp`) || !available.has(`${name}-light.webp`)) {
		return '';
	}
	return ['dark', 'light'].map(theme => `<img class="on-${theme}" src="media/${name}-${theme}.webp" width="${width}" height="${height}" alt="${attr(alt)}" loading="lazy" decoding="async">`).join('');
}

// ---- Landing page ----

const showcaseViews = [
	{ id: 'work', icon: 'bot', label: 'Agents at work', caption: 'Describe a task in Agent Home and press Return. The agent reads, edits and shows each change on the right while the other agents finish or wait for you in the list.', alt: 'An agent starting on a task in Agents mode, with three other agents in the list and its changes in the Changes panel' },
	{ id: 'wait', icon: 'bell', label: 'Waiting on you', caption: 'An agent asks before it runs a command. Allow it once and watch the tests run, or reject it and the agent works around it.', alt: 'An agent asking to run npm test, the test run after Allow once, and its summary of the fix' },
	{ id: 'review', icon: 'git-compare', label: 'Review the diff', caption: 'Open a changed file to keep or undo each edit in place, or keep and undo them all from the Changes panel.', alt: 'Keeping an agent\'s edits one by one in total.ts, with Keep and Undo above each change' },
	{ id: 'enhance', icon: 'wand-sparkles', label: 'Enhance prompt', caption: 'Write what you want in plain words. Enhance rewrites it as a precise prompt, and Revert brings your words back.', alt: 'A short request in the composer rewritten by Enhance into a precise prompt' },
	{ id: 'plan', icon: 'list-checks', label: 'Plan first', caption: 'In Plan mode the agent reads and plans without changing anything. Build This Plan starts the work when you are happy with it.', alt: 'An agent in Plan mode writing a numbered plan that ends with Build This Plan' },
] as const;

/** The showcase's clips and their last frames, in both themes; all of them or no showcase. */
function hasShowcase(available: ReadonlySet<string>): boolean {
	return showcaseViews.every(view => ['dark', 'light'].every(theme => available.has(`showcase-${view.id}-${theme}.mp4`) && available.has(`showcase-${view.id}-${theme}.webp`)));
}

function renderShowcase(available: ReadonlySet<string>): string {
	if (!hasShowcase(available)) {
		return '';
	}
	const first = showcaseViews[0];
	// Without JavaScript the stage shows the first clip's last frame; showcase.js plays the clips.
	const still = ['dark', 'light'].map(theme => `<img class="on-${theme}" src="media/showcase-${first.id}-${theme}.webp" width="2000" height="1250" alt="${attr(first.alt)}" fetchpriority="high" decoding="async">`).join('');
	return `
	<section id="showcase" class="wrap">
		<div class="showcase panel">
			<div class="sc-bar">
				<div class="sc-tabs" role="tablist" aria-label="What the showcase shows">
					${showcaseViews.map((view, i) => `<button type="button" role="tab" id="sc-tab-${view.id}" aria-controls="sc-stage" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-view="${view.id}" data-caption="${attr(view.caption)}" data-alt="${attr(view.alt)}">${icon(view.icon)}<span>${text(view.label)}</span></button>`).join('\n\t\t\t\t\t')}
				</div>
				<div class="sc-theme" role="group" aria-label="App theme">
					<button type="button" data-theme="dark" aria-pressed="true">Dark</button><button type="button" data-theme="light" aria-pressed="false">Light</button>
				</div>
			</div>
			<div class="sc-stage" id="sc-stage" role="tabpanel" aria-labelledby="sc-tab-${first.id}">${still}</div>
			<p class="sc-caption"><span class="sc-dot" aria-hidden="true"></span><span class="sc-text" aria-live="polite">${text(first.caption)}</span></p>
		</div>
	</section>`;
}

export function renderPage(latest: LatestRelease, repo: string, available: ReadonlySet<string> = new Set()): string {
	const c = context(latest, repo);
	const pill = c.version
		? `<a class="pill" href="notes.html"><i class="dot"></i><span>New in ${text(c.version)}: a calmer look, a simpler composer and faster replies</span>${icon('arrow-right')}</a>` : '';
	const download = (small: string, big: string) => c.dmg ? `
					<a class="dl" href="${attr(c.dmg.url)}">
						${icon('apple')}
						<span><small>${small}</small><b>${big}</b></span>
						${icon('download', 'arrow')}
					</a>`
		: `
					<span class="dl disabled"><span><small>No release yet</small><b>The first build is on its way</b></span></span>`;
	const meta = c.version
		? `v${text(c.version)}${c.releasedShort ? ` · ${text(c.releasedShort)}` : ''} · macOS 12+ · Apple silicon · Gemini CLI built in`
		: `<a href="${attr(c.repoUrl)}/releases">Check GitHub Releases</a> · Mac with Apple silicon`;
	const crop = (media: Media, alt: string) => {
		const shot = themed(media, available, alt);
		return shot ? `<div class="crop">${shot}</div>` : '';
	};
	const row = (media: Media, alt: string, eyebrow: string, title: string, body: string, points: readonly string[], flip: boolean) => {
		const shot = themed(media, available, alt);
		return `
				<article class="feature${flip ? ' flip' : ''}">
					<div>
						<p class="eyebrow">${eyebrow}</p>
						<h3>${title}</h3>
						<p>${body}</p>
						<ul>${points.map(point => `<li>${point}</li>`).join('')}</ul>
					</div>
					${shot ? `<div class="media panel">${shot}</div>` : ''}
				</article>`;
	};
	const mini = (name: keyof typeof icons, title: string, body: string) =>
		`<article class="card panel lift"><div class="ico">${icon(name)}</div><h3>${title}</h3><p>${body}</p></article>`;

	const body = `
	<section class="hero">
		<div class="wrap">
			${pill}
			<h1>Code with Gemini agents.<br><span class="grad">Review every change they make.</span></h1>
			<p class="sub">GeminiCode is a full code editor, built on the open-source core of VS&nbsp;Code, with the Gemini CLI inside. Start agents side by side, watch what each one is doing as it works, and keep or undo every edit they make.</p>
			<div class="actions">${download('Download for Mac', c.dmg ? `Apple silicon · ${c.sizeMb} MB` : '')}
				<a class="ghost" href="#install">${icon('terminal')}How to install</a>
			</div>
			<p class="meta">${meta}</p>
		</div>
	</section>
${renderShowcase(available)}

	<section id="features" class="block">
		<div class="wrap">
			<div class="head">
				<p class="eyebrow">${c.version ? `New in ${text(c.version)}` : 'New'}</p>
				<h2 class="h2">Calmer, simpler, faster</h2>
				<a class="more" href="notes.html">Read the release notes ${icon('arrow-right')}</a>
			</div>
			<div class="bento">
				<article class="card wide panel">
					<div>
						<div class="ico">${icon('sparkles')}</div>
						<h3>A calmer look</h3>
						<p>GeminiCode Dark and Light share one quiet look: soft greys, panels as cards with a hairline edge, and Graphite as the one accent. The Gemini colours are kept for the moments that matter, such as the bar that runs while an agent works.</p>
					</div>
					${crop('look', 'An agent at work in GeminiCode: the chat, the working strip and the Changes panel')}
				</article>
				<article class="card panel lift">
					<div class="ico">${icon('zap')}</div>
					<h3>Answers sooner</h3>
					<p>Agents start on Flash, and the agent gets ready in the background after launch and while you type on Agent Home. Enhance prompt and inline edit appear as Gemini writes them, and long chats open on their latest messages.</p>
				</article>
				<article class="card panel lift">
					<div class="ico">${icon('gauge')}</div>
					<h3>Usage at a glance</h3>
					<p>The ring under the composer shows how full the chat's context is. Click it for today's quota for each model and the tokens this chat used.</p>
				</article>
				<article class="card wide panel">
					<div>
						<div class="ico">${icon('plus')}</div>
						<h3>Everything in one + menu</h3>
						<p>The composer is just your words, the model and Send. Mode, files, @&nbsp;context, skills, Follow the agent and usage sit in the + menu, and a mode other than Default shows as a chip you can clear.</p>
					</div>
					${crop('plus', 'The composer\'s + menu: mode, files, context, skills, Follow the agent and usage')}
				</article>
				<article class="card wide panel">
					<div>
						<div class="ico">${icon('list-checks')}</div>
						<h3>Plan, then build</h3>
						<p>A reply in Plan mode ends with Build This Plan. With the model on Auto, Gemini plans with Pro and builds with Flash.</p>
					</div>
					${crop('plan', 'An agent\'s plan in Plan mode, ending with Build This Plan')}
				</article>
				<article class="card panel lift">
					<div class="ico">${icon('git-branch')}</div>
					<h3>Pickers in the chat</h3>
					<p>The model, branch and folder menus open right where you click, and the branch menu can create a branch.</p>
				</article>
			</div>
		</div>
	</section>

	<section class="block">
		<div class="wrap rows">${row('review', 'Reviewing an agent\'s edits in total.ts, with Keep and Undo above each change', 'Review', 'Review every change in place.', 'Open a file an agent changed: added lines are tinted, removed lines are marked, and Keep and Undo sit above each change. The Changes panel lists every file, with Keep All, Undo All and Commit.', ['Each reply that changed files can be undone in one click', 'The sparkle in Source Control writes the commit message'], false)}${row('branch', 'An agent on its own branch, with Merge Back in the Agents list', 'Worktrees', 'Agents on their own branch.', 'Give an agent its own copy of the repository on a new branch, so your folder and other agents are untouched. Merge Back when it is done.', ['A setup command or <code>.gemini/worktree-setup.sh</code> makes the branch ready to run', 'Each agent\'s row shows its branch and its changes'], true)}${row('helpers', 'Project Helpers: MCP servers, skills, hooks, extensions, memory and Gemini CLI settings', 'Project Helpers', 'Everything an agent loads, on one page.', 'Project Helpers lists MCP servers, skills, hooks, Gemini CLI extensions and memory, with a switch for each. Remote MCP servers can sign in.', ['Four Gemini CLI settings, such as Plan with Pro, build with Flash', 'Skills show in the / menu too'], false)}
		</div>
	</section>

	<section class="block">
		<div class="wrap">
			<div class="head">
				<p class="eyebrow">Also in GeminiCode</p>
				<h2 class="h2">From prompt to commit</h2>
			</div>
			<div class="mini">
				${mini('layout-grid', 'Agents mode', 'Describe a task in Agent Home and press Return. Each agent gets a card with its status, changes and next step. <kbd>⌥⌘M</kbd> switches to the classic editor layout.')}
				${mini('wand-sparkles', 'Enhance your prompt', 'Write what you want in plain words and press Enhance, or <kbd>⌥⌘E</kbd>. The rewrite streams in, and nothing is sent until you press Send.')}
				${mini('history', 'Pick up a CLI session', 'A new agent lists the Gemini CLI sessions saved for its folder, including ones you started in the terminal. Click Restore to carry on.')}
				${mini('globe', 'A browser your agents can use', 'Agents open the app they\'re building in the built-in browser, then read, click, type and take screenshots to check their work.')}
				${mini('eye', 'Follow the agent', 'Turn it on in the + menu and each file the agent reads or edits opens at the line it\'s on. Focus stays in the chat.')}
				${mini('text-cursor-input', 'Inline edit', 'Select code, press <kbd>⌘I</kbd> and say what to change. The new lines stream in for you to keep or undo.')}
				${mini('scan-search', 'Review My Changes', 'An agent in Plan mode reads your uncommitted diff and reports findings without editing anything.')}
				${mini('bell', 'Know when it\'s done', 'A Mac notification and a Dock badge when an agent finishes or needs you, so you can work on something else.')}
			</div>
		</div>
	</section>

	<section id="install" class="block">
		<div class="wrap">
			<div class="install panel">
				<div class="head">
					<p class="eyebrow">Install</p>
					<h2 class="h2">Up and running in five steps</h2>
					<p>The Gemini CLI comes with the app. All you need is a Google account with a Gemini Code Assist license.</p>
				</div>${unsignedNote(latest)}
				<ol class="steps">
					<li><span class="n">01</span><div><b>Open the .dmg</b><span>Drag GeminiCode to Applications.</span></div></li>
					<li><span class="n">02</span><div><b>Launch GeminiCode</b><span>The Get Started walkthrough opens. The Gemini CLI comes with the app.</span></div></li>
					<li><span class="n">03</span><div><b>Sign in with Google</b><span>Use the account that holds your Gemini Code Assist license.</span></div></li>
					<li><span class="n">04</span><div><b>Check your Cloud project</b><span>Only if your organisation doesn't set it for you.</span></div></li>
					<li><span class="n">05</span><div><b>Start an agent</b><span>Describe a task in Agent Home and press Return.</span></div></li>
				</ol>
				<div class="actions">${download('Download for Mac', c.version ? `GeminiCode ${text(c.version)}` : '')}
					<a class="ghost" href="${attr(c.repoUrl)}/blob/main/gemini/docs/USING.md">Read the user guide ${icon('arrow-right')}</a>
				</div>
				<p class="fine">GeminiCode tells you when an update is out and links back here.</p>
			</div>
		</div>
	</section>`;
	return layout('GeminiCode: code with Gemini agents', body, c, 'home');
}

// ---- Release notes page ----

/**
 * Gives each h2/h3 in the notes an id, and returns them for the side navigation.
 * A paragraph that is only bold text, such as `**Agents mode**` on a line of
 * its own, reads as a heading, so it becomes an h4 and is listed too.
 */
export function addHeadingIds(notesHtml: string): { html: string; headings: { level: number; id: string; label: string }[] } {
	const headings: { level: number; id: string; label: string }[] = [];
	const used = new Set<string>();
	const boldHeadings = notesHtml.replace(/<p>\s*<strong>([^<]+)<\/strong>\s*<\/p>/g, '<h4>$1</h4>');
	const html = boldHeadings.replace(/<h([234])([^>]*)>([\s\S]*?)<\/h\1>/g, (match, level: string, attrs: string, inner: string) => {
		const label = inner.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, '\'').replace(/&quot;/g, '"').trim();
		if (!label) {
			return match;
		}
		const existing = /\sid="([^"]+)"/.exec(attrs)?.[1];
		let id = existing ?? (label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section');
		if (!existing) {
			for (let n = 2; used.has(id); n++) {
				id = `${id.replace(/-\d+$/, '')}-${n}`;
			}
		}
		used.add(id);
		headings.push({ level: Number(level), id, label });
		return existing ? match : `<h${level}${attrs} id="${attr(id)}">${inner}</h${level}>`;
	});
	return { html, headings };
}

export function renderNotesPage(latest: LatestRelease, notesHtml: string, repo: string): string {
	const c = context(latest, repo);
	if (!c.version || !c.dmg) {
		const empty = `
	<section class="release wrap">
		<aside>
			<a class="back" href="./">← Back</a>
			<div><p class="eyebrow">Release notes</p><h1>No release yet</h1></div>
		</aside>
		<div class="notes panel"><p>The first build is on its way. <a href="${attr(c.repoUrl)}/releases">Check GitHub Releases</a>.</p></div>
	</section>`;
		return layout('Release notes · GeminiCode', empty, c, 'notes');
	}

	const { html, headings } = addHeadingIds(notesHtml);
	const top = Math.min(...headings.map(h => h.level));
	const toc = headings.length >= 2 ? `
			<nav class="toc">
				${headings.map(h => `<a${h.level > top ? ' class="sub"' : ''} href="#${attr(h.id)}">${text(h.label)}</a>`).join('\n\t\t\t\t')}
			</nav>` : '';
	const sha = c.dmg.sha256 ? `
			<div class="sha">SHA-256 of ${text(c.dmg.name)}<code>${text(c.dmg.sha256)}</code></div>` : '';

	const body = `
	<section class="release wrap">
		<aside>
			<a class="back" href="./">← Back</a>
			<div>
				<p class="eyebrow">Release notes</p>
				<h1>GeminiCode ${text(c.version)}</h1>
				${c.releasedLong ? `<p class="date">${text(c.releasedLong)}</p>` : ''}
			</div>
			<div>
				<a class="dl" href="${attr(c.dmg.url)}">${icon('download')}Download ${text(c.version)}</a>
				<small>Apple silicon · ${c.sizeMb} MB · macOS 12 or later</small>
			</div>${toc}${sha}
		</aside>
		<div>${unsignedNote(latest)}
			<div class="notes panel">${html.trim() ? html : '<p>No notes for this release.</p>'}</div>
			<a class="more" href="${attr(latest.notesUrl ?? `${c.repoUrl}/releases`)}">See this release on GitHub ↗</a>
		</div>
	</section>`;
	return layout(`GeminiCode ${c.version} release notes`, body, c, 'notes');
}

/** Browser code is written in TypeScript for the linter; the page gets it with the types stripped. */
function toJavaScript(source: string): string {
	return stripTypeScriptTypes(source).replace(/[ \t]+$/gm, '');
}

function text(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attr(value: string): string {
	return text(value).replace(/"/g, '&quot;');
}

function sampleRelease(repo: string): GitHubRelease {
	return {
		tag_name: 'v0.4.0',
		name: 'GeminiCode 0.4.0',
		html_url: `https://github.com/${repo}/releases/tag/v0.4.0`,
		published_at: '2026-10-08T12:00:00Z',
		body_html: '<p>GeminiCode 0.4.0 for Mac with Apple silicon, built on Code - OSS 1.141.0 with Gemini CLI 0.62.0.</p><h2>What\'s Changed</h2><ul><li>Glass Light and Glass Dark, styled after macOS Liquid Glass</li><li>A browser your agents can use</li><li>Keep the Mac awake while agents work</li></ul><h3>Shortcuts</h3><table><thead><tr><th>Keys</th><th>What it does</th></tr></thead><tbody><tr><td><kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>Up</kbd></td><td>Jump to your previous prompt</td></tr><tr><td><kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd></td><td>Switch between Agents and Editor modes</td></tr></tbody></table><h3>Known limitations</h3><ul><li>No autocomplete.</li></ul>',
		assets: [
			{ name: 'GeminiCode-0.4.0-arm64.dmg', browser_download_url: `https://github.com/${repo}/releases/download/v0.4.0/GeminiCode-0.4.0-arm64.dmg`, size: 212_000_000 },
			{ name: 'GeminiCode-0.4.0-arm64.dmg.sha256', browser_download_url: `sample:${'0123456789abcdef'.repeat(4)}`, size: 100 },
		],
	};
}

if (import.meta.main) {
	main(process.argv[2], process.argv[3]).catch(err => {
		console.error(err);
		process.exit(1);
	});
}
