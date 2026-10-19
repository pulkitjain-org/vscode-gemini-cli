/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds the GeminiCode site for GitHub Pages from the latest GitHub Release:
// `index.html` (the landing page), `notes.html` (the release notes, rendered
// from the markdown written in the release, with `notes.md` beside it),
// `docs/` (the user docs, from gemini/docs/guide/, see docs.mts), and
// `latest.json`, which the app's update notice reads. Run on every release and
// on changes to this folder or the guide (.github/workflows/gemini-pages.yml).
//
// The landing page's sections are written out in `renderPage`; edit them by
// hand when the product changes, and keep every sentence true to
// gemini/README.md and gemini/docs/guide/. Its screenshots live in
// `gemini/site/media/`, each in a -dark and a -light copy (`mediaFiles`); a
// missing one leaves a labelled placeholder frame (see MEDIA-TODO.md).
// `site.css` holds the two palettes (Paper and Charcoal) as one token set,
// `landing.css` and `docs.css` each page's own parts; `page.mts` runs the theme
// switch and the reveals, `landing.mts` the hero and the showcase card,
// `docs-page.mts` the docs' search, code copy and "On this page". The .mts
// files are served as plain JavaScript modules. The Geist, Geist Mono and
// Newsreader fonts in `gemini/site/fonts/` are served with the page. Each docs
// page and the release notes are also written as Markdown, which Copy as
// Markdown copies.
//
//   node gemini/site/build.mts <out-dir>            # needs GITHUB_REPOSITORY, uses GITHUB_TOKEN if set
//   node gemini/site/build.mts <out-dir> --sample   # a made-up release, to preview the page
//   node gemini/site/build.mts <out-dir> --none     # the page before the first release

import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { docGroups, docPages, featureIndex, markdownForCopy, renderMarkdown, type DocPage, type RenderedDoc } from './docs.mts';

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
	readonly body?: string;
	readonly body_html?: string;
	readonly assets: readonly GitHubAsset[];
}

const siteDir = import.meta.dirname;
const guideDir = path.join(siteDir, '..', 'docs', 'guide');
const dmgPattern = /^GeminiCode-.+-arm64(-unsigned)?\.dmg$/;
/**
 * The landing page's screenshots in `media/`: `<name>-dark.webp` and
 * `<name>-light.webp`, with their pixel size. The showcase clip sits beside
 * them as `showcase-work-<theme>.mp4`. The docs' images are in `media/` and
 * `media/docs/`, named by the guide's Markdown.
 */
const mediaFiles = {
	'showcase-work': { width: 2000, height: 1250 },
	'showcase-review': { width: 2000, height: 1250 },
	'project-threads': { width: 1600, height: 1000 },
	'browser-page': { width: 1600, height: 1000 },
	files: { width: 1400, height: 1000 },
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
	fs.mkdirSync(path.join(outDir, 'media'), { recursive: true });
	// The clips have no speech; this empty captions track says so to assistive technology.
	fs.writeFileSync(path.join(outDir, 'media', 'silent.vtt'), 'WEBVTT\n\nNOTE This clip has no speech.\n');
	fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(latest, null, '\t') + '\n');
	fs.writeFileSync(path.join(outDir, 'index.html'), renderPage(latest, repo, available));
	fs.writeFileSync(path.join(outDir, 'notes.html'), renderNotesPage(latest, notesHtml, repo));
	fs.writeFileSync(path.join(outDir, 'notes.md'), notesMarkdown(latest, release?.body));
	writeDocs(outDir, latest, repo, pageUrl, mediaDir);
	for (const file of ['site.css', 'landing.css', 'docs.css']) {
		fs.copyFileSync(path.join(siteDir, file), path.join(outDir, file));
	}
	for (const script of ['page', 'landing', 'docs-page']) {
		fs.writeFileSync(path.join(outDir, `${script}.js`), toJavaScript(fs.readFileSync(path.join(siteDir, `${script}.mts`), 'utf8')));
	}
	fs.cpSync(path.join(siteDir, 'fonts'), path.join(outDir, 'fonts'), { recursive: true });
	fs.writeFileSync(path.join(outDir, 'icon.svg'), favicon());
	fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
	console.log(latest.version ? `Built the page for GeminiCode ${latest.version}.` : 'Built the page; there is no release yet.');
}

async function fetchLatestRelease(repo: string): Promise<GitHubRelease | undefined> {
	// `full` has the notes both as HTML, for the page, and as written, for Copy as Markdown.
	const headers: Record<string, string> = { accept: 'application/vnd.github.full+json', 'x-github-api-version': '2022-11-28' };
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
const icons = {
	'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
	'github': '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
	'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
	'moon': '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
	'monitor': '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
	'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
	'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
	'external': '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
	'book': '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
	'search': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	'copy': '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
	'check': '<path d="M20 6 9 17l-5-5"/>',
	'chevron-right': '<path d="m9 18 6-6-6-6"/>',
	'chevrons-up-down': '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
	'menu': '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
	'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
	'pointer': '<path d="M12.586 12.586 19 19"/><path d="M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z"/>',
	'pencil': '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
	'rocket': '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
	'bot': '<rect width="18" height="10" x="3" y="11" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" x2="8" y1="16" y2="16"/><line x1="16" x2="16" y1="16" y2="16"/>',
	'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
	'plug': '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
} as const;

function sprite(): string {
	return `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${Object.entries(icons).map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`).join('')}</svg>`;
}

function icon(name: keyof typeof icons, cls = ''): string {
	return `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

/**
 * The Aperture mark: a rounded-square frame, a ring and a four-point star,
 * monochrome. With the tile, the nav's inverse tile (ink on Paper, paper on
 * Charcoal, from the --logo tokens); without it, the glyph alone in
 * currentColor. Sizes of 32px and under take the thicker redraw.
 */
function logo(size: number, tile = true, cls = ''): string {
	const small = size <= 32;
	const glyph = small
		? '<rect class="ring" x="50" y="50" width="156" height="156" rx="36" stroke-width="20"/><circle class="ring" cx="128" cy="128" r="54" stroke-width="14"/><path class="star" d="M128 92Q128 128 164 128Q128 128 128 164Q128 128 92 128Q128 128 128 92Z"/>'
		: '<rect class="ring" x="52" y="52" width="152" height="152" rx="34" stroke-width="16"/><circle class="ring" cx="128" cy="128" r="54" stroke-width="12"/><path class="star" d="M128 94Q128 128 162 128Q128 128 128 162Q128 128 94 128Q128 128 128 94Z"/>';
	return `<svg class="logo${tile ? '' : ' bare'}${cls ? ` ${cls}` : ''}" width="${size}" height="${size}" viewBox="0 0 256 256" aria-hidden="true">${tile ? '<rect class="tile" x="16" y="16" width="224" height="224" rx="54"/>' : ''}${glyph}</svg>`;
}

/** The favicon: the mark as ink on a paper tile, with the thin rim the branding uses. */
function favicon(): string {
	return `<svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg"><rect x="16" y="16" width="224" height="224" rx="54" fill="#F4F2EC" stroke="rgba(22,21,15,.18)" stroke-width="6"/><rect x="50" y="50" width="156" height="156" rx="36" fill="none" stroke="#16150F" stroke-width="20"/><circle cx="128" cy="128" r="54" fill="none" stroke="#16150F" stroke-width="14"/><path d="M128 92Q128 128 164 128Q128 128 128 164Q128 128 92 128Q128 128 128 92Z" fill="#16150F"/></svg>\n`;
}

type PageKind = 'home' | 'notes' | 'docs';

function themeSwitch(): string {
	return `<div class="seg" role="group" aria-label="Site theme">
					<button type="button" data-theme-set="dark" aria-label="Dark theme" aria-pressed="false">${icon('moon')}</button>
					<button type="button" data-theme-set="light" aria-label="Light theme" aria-pressed="false">${icon('sun')}</button>
					<button type="button" data-theme-set="system" aria-label="Follow the system theme" aria-pressed="true">${icon('monitor')}</button>
				</div>`;
}

/**
 * The page around `body`. `root` leads from the page to the site's root,
 * `../` for the docs. The docs take a white reading ground in Paper and the
 * same Charcoal as the rest of the site when dark.
 */
function layout(title: string, body: string, c: Context, current: PageKind, root = '', description = 'GeminiCode is a VS Code fork with the Gemini CLI built in. Run Gemini agents side by side and review every change they make. Download it for Mac.'): string {
	const home = current === 'home' ? '' : `${root}./`;
	const style = { home: 'landing.css', notes: 'docs.css', docs: 'docs.css' }[current];
	const script = { home: 'landing.js', notes: 'page.js', docs: 'docs-page.js' }[current];
	// The stylesheets go inline, so the first paint waits for nothing but the HTML; their font
	// paths are relative to the site's root, so a page in docs/ gets them rewritten.
	const css = ['site.css', style].map(file => fs.readFileSync(path.join(siteDir, file), 'utf8').replace(/^\/\*[\s\S]*?\*\/\n\n/, '').replace(/url\(fonts\//g, `url(${root}fonts/`)).join('\n');
	const typing = current === 'home' ? 'try{if(!matchMedia(\'(prefers-reduced-motion: reduce)\').matches&&!sessionStorage.getItem(\'typed\')){document.documentElement.classList.add(\'typing\')}}catch{}' : '';
	const download = c.dmg
		? `<a class="btn primary small dl" href="${attr(c.dmg.url)}">${icon('download')}<span class="dl-label">Download<span class="long"> for Mac</span></span></a>`
		: `<a class="btn primary small" href="${attr(c.repoUrl)}/releases">Releases</a>`;
	const links = current === 'home'
		? [['#agents', 'Agents'], ['#review', 'Review'], ['#projects', 'Projects'], ['docs/', 'Docs'], [c.repoUrl, 'GitHub']]
		: [[`${root}docs/`, 'Docs', current === 'docs'], [`${root}notes.html`, 'Releases', current === 'notes'], [c.repoUrl, 'GitHub']];
	const navLinks = links.map(([href, label, on]) => `<a href="${attr(String(href))}"${on ? ' aria-current="page"' : ''}>${text(String(label))}</a>`).join('\n\t\t\t\t');
	const news = current === 'home' ? `
		<div class="news"><div class="wrap"><span class="k">Preview</span><a href="#projects">Projects: one chat, many threads, each on its own branch →</a></div></div>` : '';
	const search = current === 'docs' ? `
				<button type="button" class="search-btn" aria-label="Search the docs">${icon('search')}<span>Search docs</span><kbd>⌘K</kbd></button>` : '';
	const brandTail = current === 'docs' ? `<span class="sep">/</span><span class="sub">Docs</span>` : '';
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${text(title)}</title>
	<meta name="description" content="${attr(description)}">
	<meta name="color-scheme" content="light dark">
	<link rel="icon" href="${root}icon.svg" type="image/svg+xml">
	<link rel="preload" href="${root}fonts/geist-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
	<style>
${css}
	</style>
	<script>document.documentElement.classList.add('js');try{const t=localStorage.getItem('theme');if(t==='dark'||t==='light'){document.documentElement.dataset.theme=t}}catch{}${typing}</script>${script === 'page.js' ? '' : `
	<link rel="modulepreload" href="${root}page.js">`}
	<script type="module" src="${root}${script}"></script>
</head>
<body class="${current === 'docs' || current === 'notes' ? 'docs-ground' : 'home'}">
	${sprite()}
	<div class="frame l" aria-hidden="true"></div>
	<div class="frame r" aria-hidden="true"></div>
	<header class="top">${news}
		<div class="wrap nav">
			<a class="brand" href="${root}./">${logo(26)}<span class="wm">GeminiCode</span>${brandTail}</a>
			<nav class="links" aria-label="Site">
				${navLinks}
			</nav>
			<div class="right">${search}
				${themeSwitch()}
				${download}
				<button type="button" class="menu-btn" aria-label="Menu" aria-expanded="false" aria-controls="menu">${icon('menu', 'bars')}${icon('x', 'x')}</button>
			</div>
		</div>
		<nav class="menu" id="menu" aria-label="Site, on phones">
			<div class="wrap">
				${navLinks}
				${current === 'home' ? '' : `<a href="${home}">Home</a>`}
				${c.dmg ? `<a class="dl" href="${attr(c.dmg.url)}">Download for Mac</a>` : ''}${current === 'docs' ? `
				<button type="button" class="search-btn" aria-label="Search the docs">${icon('search')}<span>Search docs</span><kbd>/</kbd></button>` : ''}
			</div>
		</nav>${current === 'docs' ? `
		<div class="progress" aria-hidden="true"></div>` : ''}
	</header>
	<main id="main">
${body}
	</main>
${current === 'docs' ? docsFooter(c, root) : siteFooter(c, root)}
</body>
</html>
`;
}

function siteFooter(c: Context, root: string): string {
	const home = root ? `${root}./` : '';
	return `	<footer class="foot" id="releases">
		<div class="wrap cols">
			<div class="about">
				<a class="brand" href="${root}./">${logo(24)}<span class="wm">GeminiCode</span></a>
				<p>A fork of Code - OSS with the Gemini CLI built in as its coding agent.</p>
			</div>
			<div class="col"><span class="label">Product</span><a href="${home}#install">Download</a><a href="${root}notes.html">Release notes</a><a href="${root}docs/#all-features">Features</a></div>
			<div class="col"><span class="label">Docs</span><a href="${root}docs/getting-started.html">Getting started</a><a href="${root}docs/agents.html">Agents</a><a href="${root}docs/review.html">Review and safety</a><a href="${root}docs/shortcuts.html">Keyboard shortcuts</a></div>
			<div class="col"><span class="label">Project</span><a href="${attr(c.repoUrl)}">GitHub</a><a href="${attr(c.repoUrl)}/issues">Issues</a><a href="${attr(c.repoUrl)}/security/advisories/new">Report a vulnerability</a><a href="${attr(c.repoUrl)}/blob/main/gemini/docs/ARCHITECTURE.md">Architecture</a></div>
		</div>
		<div class="wrap legal">
			<span>Copyright © 2026 pulkitjain-org and contributors. Released under the MIT License.</span>
			<span>Gemini is a trademark of Google LLC. GeminiCode is not affiliated with or endorsed by Google.</span>
		</div>
		<div class="wrap mark" data-reveal aria-hidden="true"><span>GeminiCode</span></div>
	</footer>`;
}

function docsFooter(c: Context, root: string): string {
	return `	<footer class="dfoot">
		<div class="wrap cols">
			<div class="about">
				<a class="brand" href="${root}./">${logo(24)}<span class="wm">GeminiCode</span></a>
				<p>Pages are plain Markdown in gemini/docs/guide/, so they read on GitHub too. Edit a page from its footer.</p>
			</div>
			<div class="col"><b>Guides</b><a href="getting-started.html">Getting started</a><a href="agents.html">Agents</a><a href="review.html">Review and safety</a><a href="projects.html">Projects</a></div>
			<div class="col"><b>Reference</b><a href="shortcuts.html">Keyboard shortcuts</a><a href="helpers.html#geminicode-settings">Settings</a><a href="troubleshooting.html">Troubleshooting</a></div>
			<div class="col"><b>Project</b><a href="${attr(c.repoUrl)}">GitHub</a><a href="${attr(c.repoUrl)}/issues">Issues</a><a href="${attr(c.repoUrl)}/blob/main/gemini/docs/ARCHITECTURE.md">Architecture</a><a href="${root}./#install">Download</a></div>
		</div>
		<div class="wrap legal"><span>© 2026 pulkitjain-org and contributors · MIT License</span><span>Not affiliated with or endorsed by Google.</span></div>
	</footer>`;
}

function unsignedNote(latest: LatestRelease): string {
	return latest.version && latest.signed === false ? `
			<div class="note" role="note">
				<h3>This build is not signed by Apple yet</h3>
				<p>macOS blocks it the first time. After dragging GeminiCode to Applications, open it once and choose <b>Done</b>. Then open <b>System Settings → Privacy &amp; Security</b> and choose <b>Open Anyway</b> next to GeminiCode.</p>
				<p>Or run this in Terminal: <code>xattr -dr com.apple.quarantine /Applications/GeminiCode.app</code></p>
			</div>` : '';
}

/**
 * A product screenshot in both themes: the page's theme shows one, a frame's
 * Dark · Light pill can override it. The light copy loads eagerly when asked
 * (the showcase, the page's largest paint); the dark one lazily, since it is
 * hidden on a light page. A missing file leaves a labelled placeholder frame.
 */
function shot(media: Media, available: ReadonlySet<string>, alt: string, options: { eager?: boolean; cls?: string; sizes?: string } = {}): string {
	const { width, height } = mediaFiles[media];
	// A 1000px-wide copy beside a shot (`<name>-<theme>-1000.webp`, see MEDIA-TODO.md) serves phones.
	const srcset = (theme: 'light' | 'dark') => available.has(`${media}-${theme}-1000.webp`)
		? ` srcset="media/${media}-${theme}-1000.webp 1000w, media/${media}-${theme}.webp ${width}w" sizes="${options.sizes ?? '(max-width: 1248px) calc(100vw - 32px), 1152px'}"` : '';
	const image = (theme: 'light' | 'dark') => available.has(`${media}-${theme}.webp`)
		? `<img class="on-${theme}" src="media/${media}-${theme}.webp"${srcset(theme)} width="${width}" height="${height}" alt="${attr(alt)}"${options.eager && theme === 'light' ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`
		: `<span class="ph on-${theme}"><b>Screenshot still to come</b><span>media/${media}-${theme}.webp, ${width} × ${height}</span></span>`;
	return `<span class="shot${options.cls ? ` ${options.cls}` : ''}" data-media="${media}" style="--ar: ${width} / ${height}">${image('light')}${image('dark')}</span>`;
}

// ---- Landing page ----

/** One of the eight capabilities, as a tile with a caption on the orbit rings around the headline. */
interface Capability { href: string; title: string; cap: string; thumb: string }

/**
 * Two rings of sixteen tiles each, the eight capabilities twice over, that turn in opposite
 * directions around the headline (landing.mts moves them). Only the outer ring's first pass
 * is in the tab order and the accessibility tree; the repeats are decoration.
 */
function orbit(capabilities: readonly Capability[]): string {
	const sizes = [138, 152, 164, 152];
	const ring = (order: readonly number[], listed: boolean) => order.map((which, i) => {
		const { href, title, cap, thumb } = capabilities[which];
		const quiet = !listed || i >= capabilities.length;
		return `
				<a class="float" style="--tsz: ${sizes[i % sizes.length]}" href="${attr(href)}"${quiet ? ' tabindex="-1" aria-hidden="true"' : ''}>
					${thumb}
					<span class="txt"><span class="ttl">${text(title)}</span><span class="cap">${text(cap)}</span></span>
				</a>`;
	}).join('');
	const all = capabilities.map((_, i) => i);
	// The inner ring starts half way round the list, so a capability never sits beside its twin.
	const inner = all.map(i => (i + all.length / 2) % all.length);
	return `
		<div class="orbit" data-orbit>
			<div class="ring" data-ring="outer">${ring([...all, ...all], true)}
			</div>
			<div class="ring" data-ring="inner">${ring([...inner, ...inner], false)}
			</div>
		</div>`;
}

export function renderPage(latest: LatestRelease, repo: string, available: ReadonlySet<string> = new Set()): string {
	const c = context(latest, repo);
	const primary = (label: string, cls = '') => c.dmg
		? `<a class="btn primary dl${cls}" href="${attr(c.dmg.url)}">${icon('download')}<span class="dl-label">${text(label)}</span></a>`
		: `<a class="btn primary${cls}" href="${attr(c.repoUrl)}/releases">${text('See the releases')}</a>`;
	const heroMeta = c.version
		? `GeminiCode ${text(c.version)} · macOS 26 or later · Apple silicon · ${c.sizeMb} MB · MIT`
		: `No release yet · <a href="${attr(c.repoUrl)}/releases">Check GitHub Releases</a> · Mac with Apple silicon, macOS 26 or later`;
	const thumbShot = (media: Media) => `<span class="thumb">${shot(media, available, '')}</span>`;
	const capabilities: Capability[] = [
		{ href: '#agents', title: 'Agents side by side', cap: 'Each in its own tab, with its own chat', thumb: thumbShot('files') },
		{ href: '#review', title: 'Review and safety', cap: 'Keep, Undo, Rewind. Ask first', thumb: thumbShot('showcase-review') },
		{ href: '#agents', title: 'Home', cap: 'Describe a task. Press Return', thumb: `<span class="thumb white" style="justify-content: space-between"><span style="color: var(--fg)">Make the upload client retry twice with backoff<span class="mini-caret"></span></span><span class="row-xs"><span class="mono" style="font-size: 10px; color: var(--muted)">☑ Own branch</span><span class="mini-btn">Start ↩</span></span></span>` },
		{ href: '#projects', title: 'Projects', cap: 'One chat, many threads', thumb: thumbShot('project-threads') },
		{ href: '#beyond', title: 'Agent browser', cap: 'Agents open and use your app', thumb: thumbShot('browser-page') },
		{ href: '#beyond', title: 'Team tools', cap: 'Ticket to merge request', thumb: `<span class="thumb" style="justify-content: center; gap: 8px"><span style="display: flex; gap: 5px; flex-wrap: wrap"><span class="chip xs">Jira</span><span class="chip xs">GitLab</span><span class="chip xs">Sonar</span><span class="chip xs">Snyk</span><span class="chip xs">Figma</span></span><span class="mono" style="font-size: 10px; color: var(--accent)">ACME-412 → !412</span></span>` },
		{ href: '#agents', title: 'Enhance prompt', cap: 'Plain words in, precise prompt out', thumb: `<span class="thumb white" style="justify-content: center; gap: 5px"><span class="draft">make uploads not fail so much</span><span class="mono" style="font-size: 10px; color: var(--accent); align-self: center">↓ ⌥⌘E</span><span class="better">Add backoff, 3 attempts, with a test</span></span>` },
		{ href: 'docs/helpers.html', title: 'Project Helpers', cap: 'MCP, skills, hooks, memory', thumb: `<span class="thumb white" style="justify-content: center; gap: 6px"><span class="row-xs"><span>MCP servers</span><span class="toggle"></span></span><span class="row-xs"><span>Skills</span><span class="toggle"></span></span><span class="row-xs"><span>Hooks</span><span class="toggle off"></span></span><span class="row-xs"><span>Memory and rules</span><span class="toggle"></span></span></span>` },
	];
	const strip = [
		'<b>Plan mode</b> read first, then build',
		'<b>@file</b> attach context',
		'<b>Enhance</b> <kbd>⌥⌘E</kbd>',
		'<b>Keep</b> · <b>Undo</b> in place',
		'<b>Rewind</b> to any message',
		'<b>Merge Back</b> a branch',
		'<b>Add to Gemini</b> from the browser',
		'<b>Review My Changes</b>',
		'<b>Follow the agent</b>',
		'<kbd>⌥⌘M</kbd> Agents ⇄ Editor',
		'<b>Ticket → MR</b> Jira · GitLab',
	].map(tick => `<span class="tick">${tick}</span>`).join('');
	const steps = [
		['Install', 'Open the .dmg and drag GeminiCode to Applications. The Gemini CLI comes with it.'],
		['Sign in', 'Run <b>Gemini: Sign In with Google</b> and set your Google Cloud project ID. Home\'s Get started card has a button for each.'],
		['Connect your tools', 'Open <b>Connections</b> and sign in to Jira, GitLab, SonarQube, Snyk or Figma with your own account. Optional; a checked-in team defaults file fills in the addresses.'],
		['Start an agent', 'Describe a task on Home and press Return. The agent reads your code and asks before each edit and command.'],
	].map(([title, body], i) => `
				<div>
					<span class="num" aria-hidden="true"><span style="--d: ${i * 100}ms"><b>0${i + 1}</b><b>00</b></span></span>
					<h3>${title}</h3>
					<p>${body}</p>
				</div>`).join('');
	const installMeta = c.dmg
		? `${text(c.dmg.name)} · ${c.sizeMb} MB · macOS 26 or later${c.dmg.sha256 ? ` · <a class="sha-link" href="notes.html#sha">SHA-256</a>` : ''}`
		: `The first build is on its way. <a href="${attr(c.repoUrl)}/releases">Check GitHub Releases</a>.`;

	const body = `
	<section class="hero" aria-labelledby="headline">
		<canvas class="dots" aria-hidden="true"></canvas>${orbit(capabilities)}
		<div class="in">
			<div class="centre">
				${logo(56, true, 'mark')}
				<h1 class="h1 serif" id="headline"><span class="sr">Code with Gemini agents. Review every change.</span><span class="tw" aria-hidden="true"><span data-t="Code with Gemini agents.">Code with Gemini agents.</span><br><em data-t="Review every change.">Review every change.</em></span><span class="caret" aria-hidden="true"></span></h1>
				<p class="lead after">A VS Code fork with the official Gemini CLI built in. Run several agents side by side, give each its own branch, and approve every edit and command before it lands.</p>
				<div class="actions after">
					${primary('Download for Mac')}
					<a class="btn ghost" href="docs/">${icon('book')}Read the docs</a>
				</div>
				<p class="meta mono after">${heroMeta}</p>
			</div>
		</div>
	</section>

	<section class="show show-anchor" id="tour" aria-label="GeminiCode in Agents mode" data-reveal>
		<div class="block" aria-hidden="true"></div>
		<div class="card" data-frame>
			<div class="bar">
				<span class="o"></span><span class="o"></span><span class="o"></span>
				<span class="modes" aria-hidden="true"><span class="on">Agents</span><span>Editor</span></span>
				<div class="pill" role="group" aria-label="Screenshot theme"><button type="button" data-shot-theme="dark" aria-pressed="false">Dark</button><button type="button" data-shot-theme="light" aria-pressed="true">Light</button></div>
			</div>
			<div class="stage">
				${shot('showcase-work', available, 'GeminiCode in Agents mode: the agent list on the left, a chat in the middle and the Changes panel on the right', { eager: true })}${available.has('showcase-work-light.mp4') && available.has('showcase-work-dark.mp4') ? `
				<button type="button" class="play" data-clip="work" aria-label="Play a short clip of an agent at work"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></button>` : ''}
			</div>
		</div>
	</section>

	<section class="strip" aria-label="Things you can do">
		<div class="rail"><div class="track"><span class="set">${strip}</span><span class="set dup" aria-hidden="true">${strip}</span></div></div>
	</section>

	<section class="wrap" aria-label="What GeminiCode is">
		<div class="three" data-stagger>
			<div class="reveal" data-reveal>
				<span class="label">01</span>
				<h2 class="serif">Agents that ask first.</h2>
				<p>Default mode asks before every edit and command. Proposed changes open in a diff. Nothing runs or lands until you say so.</p>
			</div>
			<div class="reveal" data-reveal>
				<span class="label">02</span>
				<h2 class="serif">Several at once, each in its own tab.</h2>
				<p>Every agent has its own chat, files and changes, and can work on a branch of its own. Status dots tell you which one needs you. Merge Back when it is done.</p>
			</div>
			<div class="reveal" data-reveal>
				<span class="label">03</span>
				<h2 class="serif">The editor you already know.</h2>
				<p>Built on Code - OSS as a patch series over one pinned release, with the Gemini CLI running inside over the Agent Client Protocol.</p>
			</div>
		</div>
	</section>

	<section class="sec" id="agents" aria-labelledby="agents-h">
		<div class="top-row">
			<div class="head">
				<span class="label reveal" data-reveal>Agents</span>
				<h2 class="h2 serif reveal head" id="agents-h" data-reveal>Run agents side by side.<br><em class="m">Watch the one that needs you.</em></h2>
			</div>
			<p class="reveal" data-reveal>Each agent is a tab with its own chat, files and changes. Start one from Home, and see the status of all of them at a glance.</p>
		</div>
		<div class="bento" data-stagger>
			<div class="tile s7 reveal" data-reveal style="gap: 24px; min-height: 420px">
				<div style="display: flex; flex-direction: column; gap: 8px">
					<h3 class="serif">Agents side by side</h3>
					<p style="max-width: 480px">A status dot per agent: a spinner while it works, amber when it waits for you, green when done. One short note says how long it has worked or the lines it added.</p>
				</div>
				<div class="agents-mock">
					<div class="mock list" aria-hidden="true">
						<div class="r on"><span class="dot spin"></span><span class="n">Flaky upload test</span><span class="t">4m</span></div>
						<div class="r"><span class="dot warn"></span><span class="n">Jira client retries</span><span class="t w">waiting</span></div>
						<div class="r"><span class="dot ok"></span><span class="n">Rename settings</span><span class="t">+184</span></div>
						<div class="r"><span class="dot ok"></span><span class="n">Release docs</span><span class="t">+62</span></div>
						<div class="r"><span class="dot idle"></span><span class="n">Spike: ACP streaming</span><span class="t">2h ago</span></div>
					</div>
					<div class="mock reply" aria-hidden="true">
						<div class="fold">${icon('chevron-right')}<span>Worked for 4m 12s · read 6 files, ran 3 commands</span></div>
						<p>The test failed because the mock server closed the socket before the retry fired. I added a backoff of 200 ms and a third attempt, and the suite passes locally.</p>
						<div class="files"><span>retry.ts</span><span>upload.test.ts</span></div>
						<div class="bar"></div>
					</div>
				</div>
			</div>
			<div class="tile s5 reveal" data-reveal style="gap: 20px">
				<div style="display: flex; flex-direction: column; gap: 8px">
					<h3 class="serif">Home</h3>
					<p>Describe a task and press Return. Home shows each agent's status, changes and next step as a card, and, once you connect them, your tickets and merge requests.</p>
				</div>
				<div class="mock home-mock" aria-hidden="true">
					<p class="task">Make the upload client retry twice with backoff, and cover it with a test<span class="mini-caret"></span></p>
					<div class="opts">
						<span><span class="check">${icon('check')}</span>On its own branch</span>
						<span class="m">Default · Auto</span>
						<span class="start">Start <kbd>↩</kbd></span>
					</div>
				</div>
			</div>
			<div class="tile s4 reveal" data-reveal style="gap: 18px">
				<svg class="branch-svg" viewBox="0 0 320 96" fill="none" aria-hidden="true">
					<path class="rail" d="M16 48 H304" stroke-width="2"/>
					<path class="lane" d="M96 48 C 130 48, 130 20, 164 20 H 230 C 264 20, 264 48, 298 48" stroke-width="2"/>
					<circle class="g" cx="96" cy="48" r="5" stroke="var(--muted)" stroke-width="2"/>
					<circle cx="200" cy="20" r="5" fill="var(--accent)"/>
					<circle class="g" cx="298" cy="48" r="5" stroke="var(--ok)" stroke-width="2"/>
					<text x="150" y="80">agent/upload-retries</text>
					<text x="16" y="80">main</text>
				</svg>
				<h3 class="serif s">Agents on their own branch</h3>
				<p>A worktree per agent, in its own branch. <b>Merge Back</b> when it is done.</p>
			</div>
			<div class="tile s4 reveal" data-reveal style="gap: 18px">
				<div class="mock code" aria-hidden="true">
					<div class="tabs"><span class="on">retry.ts</span><span>client.ts</span><span>upload.test.ts</span></div>
					<div class="lines"><span><span class="ln">41</span>for (let i = 0; i &lt; 3; i++) {</span><span class="hl"><span class="ln">42</span>  await sleep(200 * 2 ** i);</span><span><span class="ln">43</span>  if (await tryUpload()) return;</span></div>
				</div>
				<h3 class="serif s">Follow the agent</h3>
				<p>Every file the agent reads or edits opens at its line as it works.</p>
			</div>
			<div class="tile s4 reveal" data-reveal style="gap: 18px">
				<div class="enh" aria-hidden="true">
					<div class="draft">make uploads not fail so much</div>
					<div class="arrow">${icon('arrow-down')}Enhance · ⌥⌘E</div>
					<div class="better">In <code>src/upload</code>, add exponential backoff with up to 3 attempts, keep the public API unchanged, and add a test for the retry path.</div>
				</div>
				<h3 class="serif s">Enhance prompt</h3>
				<p>Plain words in, a precise prompt out. Review it, or Revert.</p>
			</div>
		</div>
	</section>

	<section class="sec" id="review" aria-labelledby="review-h">
		<div class="split">
			<div class="sticky">
				<span class="label reveal" data-reveal>Review and safety</span>
				<h2 class="h2 serif reveal head" id="review-h" data-reveal>Nothing lands<br><em>without you.</em></h2>
				<p class="reveal" data-reveal>Default mode asks before every edit and command. Proposed changes open in a diff first. Keep or undo each one in place, or rewind the whole conversation to before any message, files included.</p>
				<a class="more reveal" data-reveal href="docs/review.html">How approvals work ${icon('arrow-right')}</a>
			</div>
			<div class="stack" data-stagger>
				<div class="row reveal" data-reveal>
					<span class="n">01</span>
					<div><h3 class="serif">Approval modes</h3><p>Default asks every time. Auto Edit asks only before commands. Plan changes nothing. YOLO is off unless your admin enables it.</p></div>
				</div>
				<div class="row reveal" data-reveal>
					<span class="n">02</span>
					<div><h3 class="serif">Keep, Undo, Rewind</h3><p>Review each change in the file or all at once from Changes. Each reply that changed files undoes in one click.</p></div>
				</div>
				<div class="row reveal" data-reveal>
					<span class="n">03</span>
					<div><h3 class="serif">Secrets stay out</h3><p>Agents cannot read .env files, private keys, cloud credentials or git-ignored files, even through a symbolic link.</p></div>
				</div>
				<div class="pic reveal" data-reveal>
					${shot('showcase-review', available, 'An agent\'s edits shown in the file, with Keep and Undo above each change')}
				</div>
			</div>
		</div>
	</section>

	<section class="sec" id="projects" aria-labelledby="projects-h">
		<div class="proj reveal" data-reveal>
			<div class="split">
				<div class="copy">
					<span class="label">Projects · preview</span>
					<h2 class="h2 serif" id="projects-h">One chat for the <em>whole feature.</em></h2>
					<p>Talk to a coordinator. It splits larger work into threads, each an agent on its own branch, and passes your follow-ups to the right one. Threads show as cards you can open, merge back, review or undo.</p>
					<div class="threads" aria-hidden="true">
						<div class="thread" style="--i: 0"><span class="dot ok"></span><span class="n">Thread · API retries</span><span class="mb">Merge back</span></div>
						<div class="thread" style="--i: 1"><span class="dot warn"></span><span class="n">Thread · Settings UI</span><span class="m w">Approve plan</span></div>
						<div class="thread" style="--i: 2"><span class="dot spin"></span><span class="n">Thread · Docs</span><span class="m">2 repositories</span></div>
					</div>
					<a class="more" href="docs/projects.html">How Projects work ${icon('arrow-right')}</a>
				</div>
				<div class="pic">
					${shot('project-threads', available, 'Thread cards in a project chat, with the side panel counting threads by state')}
				</div>
			</div>
		</div>
	</section>

	<section class="sec beyond" id="beyond" aria-labelledby="beyond-h">
		<div class="head">
			<span class="label reveal" data-reveal>Beyond the editor</span>
			<h2 class="h2 serif reveal head" id="beyond-h" data-reveal>The browser and <em>the team's tools.</em></h2>
		</div>
		<div class="bento" data-stagger>
			<div class="tile s6 pic0 reveal" data-reveal>
				<div class="txt">
					<h3 class="serif">A browser your agents can use.</h3>
					<p>Agents open your app, click, type and read the console. Point at an element and <b>Add to Gemini</b>, or pin notes on the page and send them as one list.</p>
				</div>
				<div class="frame-b">
					<span class="add" aria-hidden="true">${icon('pointer')}Add to Gemini</span>
					${shot('browser-page', available, 'A cart page open in GeminiCode\'s browser beside the chat, with Add to Gemini in the toolbar')}
				</div>
			</div>
			<div class="tile s6 team reveal" data-reveal>
				<h3 class="serif">From ticket to merge request.</h3>
				<p>Sign in to your team's tools with your own account. Start an agent from a ticket, open the merge request, fix the pipeline and the comments, and let Gemini review the result against the ticket.</p>
				<div class="chips"><span class="chip">Jira</span><span class="chip">GitLab</span><span class="chip">SonarQube</span><span class="chip">Snyk</span><span class="chip">Figma</span></div>
				<div class="mock mr" aria-hidden="true">
					<div class="r"><span class="k">ACME-412</span><span class="n">Upload retries</span><span class="s">!412 · passed</span></div>
					<div class="r on"><span class="k">ACME-419</span><span class="n">Settings rename</span><span class="s w">2 comments</span></div>
					<div class="r"><span class="k">SONAR</span><span class="n">New code</span><span class="s">0 new issues</span></div>
				</div>
				<a class="more" href="docs/team-tools.html">Set up your tools ${icon('arrow-right')}</a>
			</div>
		</div>
	</section>

	<section class="sec" id="install" aria-labelledby="install-h">
		<div class="head">
			<span class="label reveal" data-reveal>Install</span>
			<h2 class="h2 serif reveal head" id="install-h" data-reveal>Four steps.<br><em class="m">Nothing else to install.</em></h2>
		</div>${unsignedNote(latest)}
		<div class="four" data-reveal>${steps}
		</div>
		<div class="get-row reveal" data-reveal>
			${primary(c.version ? `Download GeminiCode ${c.version}` : 'Download for Mac', ' big')}
			<span class="meta">${installMeta}</span>
		</div>
	</section>`;
	return layout('GeminiCode: code with Gemini agents, review every change', body, c, 'home');
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
		<div class="aside">
			<a class="back" href="./">← Back</a>
			<div><span class="label">Release notes</span><h1>No release yet</h1></div>
		</div>
		<div class="notes"><p>The first build is on its way. <a href="${attr(c.repoUrl)}/releases">Check GitHub Releases</a>.</p></div>
	</section>`;
		return layout('Release notes · GeminiCode', empty, c, 'notes');
	}

	const { html, headings } = addHeadingIds(notesHtml);
	const top = Math.min(...headings.map(h => h.level));
	const toc = headings.length >= 2 ? `
			<nav class="toc" aria-label="Sections of the notes">
				${headings.map(h => `<a${h.level > top ? ' class="sub"' : ''} href="#${attr(h.id)}">${text(h.label)}</a>`).join('\n\t\t\t\t')}
			</nav>` : '';
	const sha = c.dmg.sha256 ? `
			<div class="sha" id="sha">SHA-256 of ${text(c.dmg.name)}<code>${text(c.dmg.sha256)}</code></div>` : '';

	const body = `
	<section class="release wrap">
		<div class="aside">
			<a class="back" href="./">← Back</a>
			<div>
				<span class="label">Release notes</span>
				<h1>GeminiCode ${text(c.version)}</h1>
				${c.releasedLong ? `<p class="date">${text(c.releasedLong)}</p>` : ''}
			</div>
			<div>
				<a class="btn primary dl" href="${attr(c.dmg.url)}">${icon('download')}<span class="dl-label">Download ${text(c.version)}</span></a>
				<small>Apple silicon · ${c.sizeMb} MB · macOS 26 or later</small>
			</div>
			<div>${copyButton('notes.md')}</div>${toc}${sha}
		</div>
		<div>${unsignedNote(latest)}
			<div class="notes">${html.trim() ? html : '<p>No notes for this release.</p>'}</div>
			<a class="more" href="${attr(latest.notesUrl ?? `${c.repoUrl}/releases`)}">See this release on GitHub ${icon('external')}</a>
		</div>
	</section>`;
	return layout(`GeminiCode ${c.version} release notes`, body, c, 'notes');
}

// ---- Docs ----

/** Every file under `dir`, as paths relative to it with `/` between folders. */
function filesUnder(dir: string): Set<string> {
	if (!fs.existsSync(dir)) {
		return new Set();
	}
	return new Set(fs.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(entry => entry.isFile())
		.map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')));
}

function copyButton(file: string, label = 'Copy as Markdown', cls = 'copy-md'): string {
	return `<button type="button" class="${cls}" data-copy-md="${attr(file)}" title="Copy this page as Markdown, to paste into a chat or a document">${icon('copy', 'cp')}${icon('check', 'ok')}<span class="copy-label">${text(label)}</span></button>`;
}

function searchDialog(): string {
	return `
	<dialog class="search" aria-label="Search the docs" data-docs-root="">
		<form role="search">
			${icon('search')}
			<input type="search" placeholder="Search features, settings and shortcuts" aria-label="Search the docs" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="search-results" aria-autocomplete="list">
			<kbd>esc</kbd>
		</form>
		<div class="results" id="search-results" role="listbox" aria-label="Results"></div>
	</dialog>`;
}

/** The list of pages: every group, with the current page's sections under it. */
function docsSidebar(c: Context, current: DocPage | undefined, rendered?: RenderedDoc): string {
	const subs = rendered?.headings.filter(h => h.level === 2) ?? [];
	const groups = docGroups.map(group => `
				<div>
					<h2>${text(group.name)}</h2>
					<ul>${group.pages.map(page => `
						<li><a href="${page.slug}.html"${page === current ? ' aria-current="page"' : ''}>${text(page.title)}${page.slug === 'projects' ? ' <span class="badge">PREVIEW</span>' : ''}</a>${page === current && subs.length ? `
							<div class="subs">${subs.map(h => `<a href="#${attr(h.id)}">${text(h.text)}</a>`).join('')}</div>` : ''}</li>`).join('')}
					</ul>
				</div>`).join('');
	return `
		<aside class="side" aria-label="Documentation pages">
			<button type="button" class="picker" aria-expanded="false"><span><small>Docs</small>${text(current?.title ?? 'Overview')}</span>${icon('chevrons-up-down')}</button>
			<div class="group-list">
				<div><ul><li><a href="./"${current ? '' : ' aria-current="page"'}>Overview</a></li></ul></div>${groups}
				<div>
					<h2>Releases</h2>
					<ul><li><a href="../notes.html">Release notes</a></li></ul>
				</div>
			</div>
			<div class="maint">
				<b>For maintainers</b>
				<a href="${attr(c.repoUrl)}/blob/main/gemini/docs/ARCHITECTURE.md">Architecture</a>
				<a href="${attr(c.repoUrl)}/blob/main/gemini/docs/PROJECTS.md">How Projects work</a>
				<a href="${attr(c.repoUrl)}/blob/main/gemini/docs/RELEASING.md">Releasing</a>
				<a href="${attr(c.repoUrl)}/blob/main/gemini/docs/ROADMAP.md">Roadmap</a>
			</div>
		</aside>`;
}

const numberWords = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/**
 * Writes `docs/`: a page per guide file with its Markdown beside it, the docs
 * home, `all.md` (every page in one file) and `search.json`.
 */
function writeDocs(outDir: string, latest: LatestRelease, repo: string, pageUrl: string, mediaDir: string): void {
	const c = context(latest, repo);
	const docsDir = path.join(outDir, 'docs');
	fs.mkdirSync(docsDir, { recursive: true });
	const media = filesUnder(mediaDir);
	const sources = new Map(docPages.map(page => [page, fs.readFileSync(path.join(guideDir, `${page.slug}.md`), 'utf8')]));
	const search: { page: string; heading: string; text: string; url: string }[] = [];
	const copies: string[] = [];

	docPages.forEach((page, index) => {
		const source = sources.get(page)!;
		const doc = renderMarkdown(source, { root: '../', media });
		const group = docGroups.find(g => g.pages.includes(page))!;
		const previous = docPages[index - 1];
		const next = docPages[index + 1];
		const onPage = doc.headings.filter(h => h.level === 2);
		const body = `
	<div class="layout">${docsSidebar(c, page, doc)}
		<article class="doc">
			<div class="doc-top">
				<nav class="crumbs" aria-label="Breadcrumb"><a href="./">Docs</a><span class="sep">/</span><span>${text(group.name)}</span><span class="sep">/</span><span class="here">${text(page.title)}</span></nav>
				<div class="acts">
					${copyButton(`${page.slug}.md`, 'Copy as Markdown', 'act')}
					<a class="act" href="${attr(c.repoUrl)}/blob/main/gemini/docs/guide/${page.slug}.md" aria-label="Open the Markdown source on GitHub">${icon('external')}Open .md</a>
				</div>
			</div>
			<h1 class="serif">${text(doc.title)}</h1>
			${doc.lead ? `<p class="lead">${doc.lead}</p>` : ''}
${doc.html}
			<div class="edit-row">
				<span>${c.version ? `Up to date with GeminiCode ${text(c.version)}.` : ''}</span>
				<a href="${attr(c.repoUrl)}/edit/main/gemini/docs/guide/${page.slug}.md">${icon('pencil')}Edit this page on GitHub</a>
			</div>
			<nav class="pager" aria-label="Previous and next page">${previous ? `<a href="${previous.slug}.html"><small>Previous</small><b>${text(previous.title)}</b></a>` : `<a href="./"><small>Previous</small><b>Docs home</b></a>`}${next ? `<a class="next" href="${next.slug}.html"><small>Next</small><b>${text(next.title)} ${icon('arrow-right')}</b></a>` : ''}</nav>
		</article>${onPage.length >= 2 ? `
		<aside class="toc" aria-label="On this page">
			<h2>On this page</h2>
			<nav aria-label="Sections of this page"><span class="rule" aria-hidden="true"></span>${onPage.map(h => `<a href="#${attr(h.id)}">${text(h.text)}</a>`).join('')}</nav>
			<div class="extra"><a href="${attr(c.repoUrl)}/issues">Report a problem</a><a href="shortcuts.html">Keyboard shortcuts</a></div>
		</aside>` : ''}
	</div>${searchDialog()}`;
		fs.writeFileSync(path.join(docsDir, `${page.slug}.html`), layout(`${doc.title} · GeminiCode docs`, body, c, 'docs', '../', page.summary));
		const markdown = markdownForCopy(source, pageUrl);
		fs.writeFileSync(path.join(docsDir, `${page.slug}.md`), markdown);
		copies.push(markdown);
		search.push({ page: page.title, heading: '', text: page.summary, url: `${page.slug}.html` });
		for (const section of doc.sections) {
			search.push({ page: page.title, heading: section.heading, text: section.text, url: `${page.slug}.html#${section.id}` });
		}
	});

	let number = 0;
	const groups = docGroups.map(group => `
		<div class="group">
			<div class="gh"><h2 class="serif">${text(group.name)}</h2><span>${group.pages.length} ${group.pages.length === 1 ? 'guide' : 'guides'}</span></div>
			<div class="grid3">${group.pages.map(page => `
				<a class="gcard" href="${page.slug}.html">
					<span class="n">${String(++number).padStart(2, '0')}</span>
					<b>${text(page.title)}${page.slug === 'projects' ? ' <span class="badge">PREVIEW</span>' : ''}</b>
					<span>${text(page.summary)}</span>${page.topics.length ? `
					<span class="topics">${page.topics.map(topic => `<span>${text(topic)}</span>`).join('')}</span>` : ''}
					${icon('arrow-right', 'go')}
				</a>`).join('')}
			</div>
		</div>`).join('');
	const features = featureIndex.map(group => `
			<div class="fg">
				<h3>${text(group.name)}</h3>${group.items.map(item => `
				<a class="feat" href="${attr(item.href)}"><div><b>${text(item.title)}</b><span>${text(item.body)}</span></div></a>`).join('')}
			</div>`).join('');
	for (const group of featureIndex) {
		for (const item of group.items.filter(item => !search.some(entry => entry.url === item.href))) {
			search.push({ page: group.name, heading: item.title, text: item.body, url: item.href });
		}
	}
	const count = numberWords[docPages.length] ?? String(docPages.length);
	const home = `
	<section class="dhero" aria-labelledby="docs-h">
		<div class="wrap">
			<span class="label">Documentation</span>
			<h1 class="serif" id="docs-h">Everything GeminiCode does, <em>and how to use it.</em></h1>
			<p>${count[0].toUpperCase()}${count.slice(1)} short guides, written to be read in the order below, or searched when something comes up. Each page ends with where to go next.</p>
			<div class="row">
				<a class="btn primary" href="getting-started.html">Open Getting started ${icon('arrow-right')}</a>
				<a class="btn ghost" href="#all-features">Browse all features</a>
			</div>
		</div>
	</section>
	<section class="home-sec" aria-labelledby="want-h">
		<h2 id="want-h">I want to…</h2>
		<div class="grid4">
			<a class="quick" href="getting-started.html">${icon('rocket')}<b>Install and sign in</b><span>The .dmg, Google sign-in and the project ID.</span></a>
			<a class="quick" href="agents.html">${icon('bot')}<b>Run my first agent</b><span>Home, the Agents pane and what the status dots mean.</span></a>
			<a class="quick" href="review.html">${icon('shield-check')}<b>Understand approvals</b><span>Default, Auto Edit, Plan and YOLO, and what agents can't reach.</span></a>
			<a class="quick" href="team-tools.html">${icon('plug')}<b>Connect my team's tools</b><span>Jira, GitLab, SonarQube, Snyk and Figma, with your own account.</span></a>
		</div>
	</section>
	<section class="groups" aria-label="Guides">${groups}
	</section>
	<section class="allf" aria-labelledby="all-features">
		<div class="ah">
			<h2 class="serif" id="all-features">All features</h2>
			<p>Every feature, one line each, linking to the section that explains it. Scan this when you know what you are looking for.</p>
		</div>
		<div class="grid3">${features}
		</div>
	</section>${searchDialog()}`;
	fs.writeFileSync(path.join(docsDir, 'index.html'), layout('GeminiCode docs', home, c, 'docs', '../', 'How to use GeminiCode: agents, chat, review, projects, the browser, team tools and settings.'));
	fs.writeFileSync(path.join(docsDir, 'all.md'), `# GeminiCode docs\n\nFrom ${pageUrl}docs/\n\n` + copies.map(copy => copy.replace(/^(#+) /gm, '#$1 ')).join('\n'));
	fs.writeFileSync(path.join(docsDir, 'search.json'), JSON.stringify(search));
}

/** The release notes as Markdown, for Copy as Markdown on the notes page. */
function notesMarkdown(latest: LatestRelease, body: string | undefined): string {
	if (!latest.version) {
		return '# GeminiCode release notes\n\nNo release yet.\n';
	}
	const download = latest.downloads['darwin-arm64'];
	const lines = [`# GeminiCode ${latest.version} release notes`, ''];
	if (latest.publishedAt) {
		lines.push(`Released ${latest.publishedAt.slice(0, 10)}.${download ? ` Download: ${download.url}` : ''}`, '');
	}
	lines.push((body ?? '').replace(/\r\n/g, '\n').trim() || 'No notes for this release.');
	return lines.join('\n') + '\n';
}

/**
 * Browser code is written in TypeScript for the linter; the page gets it with
 * the types stripped, as ES modules that import each other by their .js names.
 */
function toJavaScript(source: string): string {
	return stripTypeScriptTypes(source).replace(/[ \t]+$/gm, '').replace(/(from\s+|import\s+)'\.\/([\w-]+)\.mts'/g, '$1\'./$2.js\'');
}

function text(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attr(value: string): string {
	return text(value).replace(/"/g, '&quot;');
}

function sampleRelease(repo: string): GitHubRelease {
	return {
		tag_name: 'v1.0.0',
		name: 'GeminiCode 1.0.0',
		html_url: `https://github.com/${repo}/releases/tag/v1.0.0`,
		published_at: '2026-10-16T12:00:00Z',
		body: 'GeminiCode 1.0.0 for Mac with Apple silicon, built on Code - OSS 1.142.0 with Gemini CLI 0.64.0.\n\n## What\'s Changed\n\n- Projects (preview): a coordinator that splits bigger work into threads\n- Add to Gemini and notes in the browser\n- Safer session approvals\n\n### Known limitations\n\n- No autocomplete.',
		body_html: '<p>GeminiCode 1.0.0 for Mac with Apple silicon, built on Code - OSS 1.142.0 with Gemini CLI 0.64.0.</p><h2>What\'s Changed</h2><ul><li>Projects (preview): a coordinator that splits bigger work into threads</li><li>Add to Gemini and notes in the browser</li><li>Safer session approvals</li></ul><h3>Shortcuts</h3><table><thead><tr><th>Keys</th><th>What it does</th></tr></thead><tbody><tr><td><kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>Up</kbd></td><td>Jump to your previous prompt</td></tr><tr><td><kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd></td><td>Switch between Agents and Editor modes</td></tr></tbody></table><h3>Known limitations</h3><ul><li>No autocomplete.</li></ul>',
		assets: [
			{ name: 'GeminiCode-1.0.0-arm64.dmg', browser_download_url: `https://github.com/${repo}/releases/download/v1.0.0/GeminiCode-1.0.0-arm64.dmg`, size: 212_000_000 },
			{ name: 'GeminiCode-1.0.0-arm64.dmg.sha256', browser_download_url: `sample:${'0123456789abcdef'.repeat(4)}`, size: 100 },
		],
	};
}

if (import.meta.main) {
	main(process.argv[2], process.argv[3]).catch(err => {
		console.error(err);
		process.exit(1);
	});
}
