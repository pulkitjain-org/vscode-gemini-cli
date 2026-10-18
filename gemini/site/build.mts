/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds the download page for GitHub Pages from the latest GitHub Release:
// `index.html` (the landing page), `notes.html` (the release notes, rendered
// from the markdown written in the release, with `notes.md` beside it),
// `docs/` (the user docs, from gemini/docs/guide/, see docs.mts), and
// `latest.json`, which the app's update notice reads. Run on every release and
// on changes to this folder or the guide (.github/workflows/gemini-pages.yml).
//
// The landing page's sections are fixed in `renderPage` and the lists above
// it (`tiles`, `clips`); edit them by hand when they change. Their screenshots
// and clips live in `gemini/site/media/`, each in a -dark and a -light copy
// (see `mediaFiles` and `clips`); a missing one is left out. `landing.mts` and
// `landing.css` run the hero clip and the clip rail and its player,
// `docs-page.mts` and `docs.css` the docs' search, Copy as Markdown and
// "On this page", and `page.mts` the theme switch, the particles and the
// pointer's light; the .mts files are served as plain JavaScript. The Geist
// fonts in `gemini/site/fonts/` are served with the page. Each docs page and
// the release notes are also written as Markdown, which Copy as Markdown copies.
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
 * The landing page's screenshots in `media/`, taken from the app at 1440 × 900
 * points: `<name>-dark.webp` and `<name>-light.webp`. The clips sit beside them
 * as `showcase-<id>-<theme>.mp4`, each with its last frame as a .webp (see
 * `clips`). The docs' images are in `media/` and `media/docs/`, named by the
 * guide's Markdown.
 */
const mediaFiles = {
	'project-threads': { width: 1600, height: 1000 },
	'browser-notes': { width: 1600, height: 1000 },
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
	fs.copyFileSync(path.join(siteDir, '..', 'branding', 'icon.svg'), path.join(outDir, 'icon.svg'));
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
	'network': '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
	'columns-2': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
	'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
	'sigma': '<path d="M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2"/>',
	'folder': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
	'play': '<polygon points="6 3 20 12 6 21 6 3"/>',
	'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
	'chevron-left': '<path d="m15 18-6-6 6-6"/>',
	'chevron-right': '<path d="m9 18 6-6-6-6"/>',
	'mouse-pointer': '<path d="M4.04 4.04 10.3 20l2.25-6.45L19 11.3z"/>',
	'sticky-note': '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>',
	'activity': '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
	'lock': '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
	'undo': '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
	'at-sign': '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
	'cookie': '<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01M16 15.5v.01M12 12v.01M11 17v.01M7 14v.01"/>',
	'git-merge': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
	'list-tree': '<path d="M21 12h-8M21 6H8M21 18h-8M3 6v4c0 1.1.9 2 2 2h3M3 10v6c0 1.1.9 2 2 2h3"/>',
	'spell-check': '<path d="m6 16 6-12 6 12"/><path d="M8 12h8"/><path d="m16 20 2 2 4-4"/>',
	'search': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	'book': '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>',
	'rocket': '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
	'message': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
	'plug': '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
	'life-buoy': '<circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/><circle cx="12" cy="12" r="4"/>',
	'keyboard': '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
	'layout-dashboard': '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
	'chevrons-up-down': '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
	'copy': '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
};

function sprite(): string {
	return `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${Object.entries(icons).map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`).join('')}</svg>`;
}

function icon(name: keyof typeof icons, cls = ''): string {
	return `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

type PageKind = 'home' | 'notes' | 'docs';

/**
 * The page around `body`. `root` leads from the page to the site's root,
 * `../` for the docs. The docs leave out the particles and the pointer's
 * light, which would only get in the way of reading.
 */
function layout(title: string, body: string, c: Context, current: PageKind, root = '', description = 'GeminiCode is a code editor with the Gemini CLI built in. Start Gemini agents side by side and review every change they make. Download it for Mac.'): string {
	const home = current === 'home' ? '' : `${root}./`;
	const get = c.dmg
		? `<a class="get" href="${attr(c.dmg.url)}">${icon('download')}<span>Download<span class="long"> for Mac</span></span></a>`
		: `<a class="get" href="${attr(c.repoUrl)}/releases">Releases</a>`;
	const style = { home: 'landing.css', notes: 'docs.css', docs: 'docs.css' }[current];
	const script = { home: 'landing.js', notes: 'docs-page.js', docs: 'docs-page.js' }[current];
	const effects = current === 'docs' ? '' : `
	<canvas class="particles" aria-hidden="true"></canvas>
	<div class="spotlight" aria-hidden="true"></div>`;
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${text(title)}</title>
	<meta name="description" content="${attr(description)}">
	<link rel="icon" href="${root}icon.svg" type="image/svg+xml">
	<link rel="preload" href="${root}fonts/geist-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
	<link rel="stylesheet" href="${root}site.css">
	<link rel="stylesheet" href="${root}${style}">
	<script>try { const t = localStorage.getItem('theme'); if (t === 'dark' || t === 'light') { document.documentElement.dataset.theme = t; } } catch {}</script>
	<script src="${root}page.js" defer></script>
	<script src="${root}${script}" defer></script>
</head>
<body>
	${sprite()}
	<div class="backdrop" aria-hidden="true"></div>${effects}
	<header class="top">
		<div class="wrap">
			<a class="brand" href="${root}./"><img src="${root}icon.svg" alt=""><span>GeminiCode</span>${c.version ? `<span class="chip">v${text(c.version)}</span>` : ''}</a>
			<nav aria-label="Site">
				<a href="${home}#tour">Features</a>
				<a href="${home}#watch">Watch</a>
				<a href="${home}#install">Install</a>
				<a href="${root}docs/"${current === 'docs' ? ' aria-current="page"' : ''}>Docs</a>
				<a href="${root}notes.html"${current === 'notes' ? ' aria-current="page"' : ''}>Release notes</a>
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
			<a class="brand" href="${root}./"><img src="${root}icon.svg" alt=""><span>GeminiCode</span></a>
			<div class="spacer"></div>
			<a href="${root}docs/">Docs</a>
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
	if (!hasMedia(media, available)) {
		return '';
	}
	const { width, height } = mediaFiles[media];
	return ['dark', 'light'].map(theme => `<img class="on-${theme}" src="media/${media}-${theme}.webp" width="${width}" height="${height}" alt="${attr(alt)}" loading="lazy" decoding="async">`).join('');
}

function hasMedia(media: Media, available: ReadonlySet<string>): boolean {
	return available.has(`${media}-dark.webp`) && available.has(`${media}-light.webp`);
}

// ---- Landing page ----

/** The "What it does" tiles: each leads to its docs page. */
const tiles: readonly { id: string; icon: keyof typeof icons; label: string; title: string; body: string; media: Media; alt: string; page: string }[] = [
	{ id: 'agents', icon: 'bot', label: 'Agents', title: 'Agents side by side', body: 'Describe a task and press Return. Each agent has its own chat, files and changes, and every edit waits for your Keep or Undo.', media: 'files', alt: 'An agent\'s chat with the files it opened in a group beside it', page: 'agents' },
	{ id: 'projects', icon: 'network', label: 'Projects', title: 'A team for the bigger jobs', body: 'A coordinator splits the work into threads, each on its own branch, across one or more repositories. Merge back when it\'s right.', media: 'project-threads', alt: 'Thread cards in a project chat, with the side panel counting threads by state', page: 'projects' },
	{ id: 'browser', icon: 'globe', label: 'Browser', title: 'Show Gemini the page you mean', body: 'Point at an element, pin notes where things should change, and let the agent check the console until the page is right.', media: 'browser-notes', alt: 'Notes pinned on a cart page in GeminiCode\'s browser', page: 'browser' },
];

/**
 * The clips in the "Watch it work" rail, in order. Each is
 * `media/showcase-<id>-<theme>.mp4` with its last frame as a .webp; a clip
 * missing either theme is left out, so a new one joins the rail once its
 * files are in `media/`. The first one also plays in the hero.
 */
const clips = [
	{ id: 'work', category: 'Agents', title: 'Agents at work', caption: 'Describe a task and press Return. The agent reads, edits and shows each change on the right.', alt: 'An agent starting on a task in Agents mode, with three other agents in the list and its changes in the Changes panel' },
	{ id: 'projects', category: 'Projects', title: 'A project splits the work', caption: 'The coordinator starts threads on their own branches, and each card updates as its agent works.', alt: 'A project chat where the coordinator starts two threads and their cards update as they work' },
	{ id: 'notes', category: 'Browser', title: 'Leave notes on the page', caption: 'Pin a change on each element of your page, then send them to Gemini as one list.', alt: 'Notes pinned on elements of a page in GeminiCode\'s browser and sent to Gemini' },
	{ id: 'wait', category: 'Review', title: 'Waiting on you', caption: 'The agent asks before it runs a command. Allow it once and watch the tests run, or reject it.', alt: 'An agent asking to run npm test, the test run after Allow once, and its summary of the fix' },
	{ id: 'review', category: 'Review', title: 'Review the diff', caption: 'Open a changed file and keep or undo each edit in place, or all of them from the Changes panel.', alt: 'Keeping an agent\'s edits one by one in total.ts, with Keep and Undo above each change' },
	{ id: 'thread', category: 'Projects', title: 'Start a thread yourself', caption: 'Give it a title, a brief and a branch. With Plan first it waits for your OK before it changes files.', alt: 'Starting a thread from the New thread dialog and approving its plan' },
	{ id: 'console', category: 'Browser', title: 'Agents check the console', caption: 'An agent opens your page, reads the console and the failed requests, and fixes the cause.', alt: 'An agent reading a page\'s console errors in GeminiCode\'s browser and fixing the code' },
	{ id: 'plan', category: 'Prompting', title: 'Plan first', caption: 'In Plan mode the agent reads and plans without changing anything. Build This Plan starts the work.', alt: 'An agent in Plan mode writing a numbered plan that ends with Build This Plan' },
	{ id: 'enhance', category: 'Prompting', title: 'Enhance your prompt', caption: 'Write what you want in plain words. Enhance rewrites it as a precise prompt, and Revert brings yours back.', alt: 'A short request in the composer rewritten by Enhance into a precise prompt' },
] as const;

type Clip = typeof clips[number];

/** Each clip's video and last frame, in both themes. */
function hasClip(clip: Clip, available: ReadonlySet<string>): boolean {
	return ['dark', 'light'].every(theme => available.has(`showcase-${clip.id}-${theme}.mp4`) && available.has(`showcase-${clip.id}-${theme}.webp`));
}

function renderClips(shown: readonly Clip[]): string {
	if (!shown.length) {
		return '';
	}
	const cards = shown.map(clip => `
				<button type="button" class="clip panel lift" data-clip="${clip.id}" data-title="${attr(clip.title)}" data-caption="${attr(clip.caption)}" data-alt="${attr(clip.alt)}">
					<span class="clip-media">${['dark', 'light'].map(theme => `<img class="on-${theme}" src="media/showcase-${clip.id}-${theme}.webp" width="2000" height="1250" alt="" loading="lazy" decoding="async">`).join('')}<video muted playsinline loop preload="none" aria-hidden="true"></video><span class="clip-play">${icon('play')}</span></span>
					<span class="clip-text"><span class="clip-cat">${text(clip.category)}</span><b>${text(clip.title)}</b><span class="clip-cap">${text(clip.caption)}</span></span>
				</button>`).join('');
	return `
	<section id="watch" class="block">
		<div class="wrap">
			<div class="head">
				<p class="eyebrow">Watch it work</p>
				<h2 class="h2">Short clips, straight from the app</h2>
				<p>Point at a clip to preview it, or open it to watch in Dark or Light.</p>
			</div>
			<div class="rail-bar"><div></div>
				<div class="rail-nav"><button type="button" class="icon-btn" data-scroll="-1" aria-label="Earlier clips">${icon('chevron-left')}</button><button type="button" class="icon-btn" data-scroll="1" aria-label="More clips">${icon('chevron-right')}</button></div>
			</div>
			<div class="rail">${cards}
			</div>
		</div>
		<dialog class="player panel" aria-labelledby="player-title">
			<div class="player-stage"></div>
			<div class="player-foot">
				<div class="player-text"><b id="player-title"></b><span class="player-cap"></span></div>
				<div class="seg" role="group" aria-label="App theme"><button type="button" data-theme="dark" aria-pressed="true">Dark</button><button type="button" data-theme="light" aria-pressed="false">Light</button></div>
				<button type="button" class="icon-btn" data-step="-1" aria-label="Previous clip">${icon('chevron-left')}</button>
				<button type="button" class="icon-btn" data-step="1" aria-label="Next clip">${icon('chevron-right')}</button>
				<button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button>
			</div>
		</dialog>
	</section>`;
}

export function renderPage(latest: LatestRelease, repo: string, available: ReadonlySet<string> = new Set()): string {
	const c = context(latest, repo);
	const pill = c.version
		? `<a class="pill" href="notes.html"><i class="dot"></i><span>New in ${text(c.version)}: Team tools, and Projects across repositories</span>${icon('arrow-right')}</a>` : '';
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
	const shownClips = clips.filter(clip => hasClip(clip, available));
	const hero = shownClips[0];
	// Without JavaScript the hero shows the first clip's last frame; landing.js plays it while it is on screen.
	const heroShot = hero ? `
			<div class="hero-shot panel">
				${['dark', 'light'].map(theme => `<img class="on-${theme}" src="media/showcase-${hero.id}-${theme}.webp" width="2000" height="1250" alt="${attr(hero.alt)}" fetchpriority="high" decoding="async">`).join('')}
				<video muted playsinline loop preload="none" aria-hidden="true" data-clip="${hero.id}"></video>
				<button type="button" class="play-all" data-open="${hero.id}">${icon('play')}Watch ${text(hero.title.toLowerCase())}</button>
			</div>` : '';
	// Each tile keeps the id of the section it replaced, so old links to #projects and #browser still land on it.
	const tileCards = tiles.map(tile => `
				<a class="tile panel lift" id="${tile.id}" href="docs/${tile.page}.html">
					<span class="shot">${themed(tile.media, available, tile.alt)}</span>
					<span class="txt"><span class="k"><span class="ico">${icon(tile.icon)}</span>${text(tile.label)}</span><h3>${text(tile.title)}</h3><p>${text(tile.body)}</p><span class="go">Read how it works ${icon('arrow-right')}</span></span>
				</a>`).join('');

	const body = `
	<section class="hero">
		<div class="wrap">
			${pill}
			<h1>Code with Gemini agents.<br><span class="grad">Review every change they make.</span></h1>
			<p class="sub">GeminiCode is a full code editor, built on the open-source core of VS&nbsp;Code, with the Gemini CLI inside. Hand a project to a team of agents, show them the page you mean, and keep or undo every edit they make.</p>
			<div class="actions">${download('Download for Mac', c.dmg ? `Apple silicon · ${c.sizeMb} MB` : '')}
				<a class="ghost" href="#watch">${icon('play')}Watch it work</a>
			</div>
			<p class="meta">${meta}</p>${heroShot}
		</div>
	</section>

	<section id="tour" class="block">
		<div class="wrap">
			<div class="head">
				<p class="eyebrow">What it does</p>
				<h2 class="h2">Agents that do the work, and you stay in charge</h2>
			</div>
			<div class="tiles">${tileCards}
			</div>
			<a class="tools panel lift" href="docs/team-tools.html">
				<span class="ico">${icon('plug')}</span>
				<span><b>Works with your team's tools</b><span class="d">Tickets, merge requests, CI, quality checks and designs, with your own account.</span></span>
				<span class="names"><span>Jira</span><span>GitLab</span><span>SonarQube</span><span>Snyk</span><span>Figma</span></span>
				<span class="go">Set up ${icon('arrow-right')}</span>
			</a>
			<p class="all-docs">Every feature, from Enhance prompt to Rewind, is explained in the <a href="docs/">docs</a>.</p>
		</div>
	</section>
${renderClips(shownClips)}

	<section id="install" class="block">
		<div class="wrap">
			<div class="install panel">
				<div class="head">
					<p class="eyebrow">Install</p>
					<h2 class="h2">Up and running in three steps</h2>
					<p>The Gemini CLI comes with the app. All you need is a Google account with a Gemini Code Assist license.</p>
				</div>${unsignedNote(latest)}
				<ol class="steps three">
					<li><span class="n">01</span><div><b>Install</b><span>Open the .dmg and drag GeminiCode to Applications.</span></div></li>
					<li><span class="n">02</span><div><b>Sign in with Google</b><span>The Get Started walkthrough takes you through it.</span></div></li>
					<li><span class="n">03</span><div><b>Start an agent</b><span>Describe a task on Home and press Return.</span></div></li>
				</ol>
				<div class="actions">${download('Download for Mac', c.version ? `GeminiCode ${text(c.version)}` : '')}
					<a class="ghost" href="docs/getting-started.html">Full setup guide ${icon('arrow-right')}</a>
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
		<div class="aside">
			<a class="back" href="./">← Back</a>
			<div><p class="eyebrow">Release notes</p><h1>No release yet</h1></div>
		</div>
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
		<div class="aside">
			<a class="back" href="./">← Back</a>
			<div>
				<p class="eyebrow">Release notes</p>
				<h1>GeminiCode ${text(c.version)}</h1>
				${c.releasedLong ? `<p class="date">${text(c.releasedLong)}</p>` : ''}
			</div>
			<div>
				<a class="dl" href="${attr(c.dmg.url)}">${icon('download')}Download ${text(c.version)}</a>
				<small>Apple silicon · ${c.sizeMb} MB · macOS 12 or later</small>
				${copyButton('notes.md')}
			</div>${toc}${sha}
		</div>
		<div>${unsignedNote(latest)}
			<div class="notes panel">${html.trim() ? html : '<p>No notes for this release.</p>'}</div>
			<a class="more" href="${attr(latest.notesUrl ?? `${c.repoUrl}/releases`)}">See this release on GitHub ↗</a>
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

function copyButton(file: string, label = 'Copy as Markdown'): string {
	return `<button type="button" class="copy-md" data-copy-md="${attr(file)}" title="Copy this page as Markdown, to paste into a chat or a document">${icon('copy')}<span class="copy-label">${text(label)}</span></button>`;
}

function searchBox(big = false): string {
	const placeholder = big ? 'Search features, settings and shortcuts' : 'Search the docs';
	return `<div class="search${big ? ' big' : ''}">${icon('search')}<input type="search" placeholder="${placeholder}" aria-label="Search the docs" autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list"><kbd>/</kbd><div class="results" role="listbox" hidden></div></div>`;
}

/** The list of pages: every group, with the current page's sections under it. */
function docsSidebar(current: DocPage | undefined, rendered?: RenderedDoc): string {
	const subs = rendered?.headings.filter(h => h.level === 2) ?? [];
	const groups = docGroups.map(group => `
				<h2>${text(group.name)}</h2>
				<ul>${group.pages.map(page => `
					<li><a href="${page.slug}.html"${page === current ? ' aria-current="page"' : ''}>${icon(page.icon as keyof typeof icons)}${text(page.title)}</a>${page === current && subs.length ? `
						<div class="subs">${subs.map(h => `<a href="#${attr(h.id)}">${text(h.text)}</a>`).join('')}</div>` : ''}</li>`).join('')}
				</ul>`).join('');
	return `
		<aside class="side" data-docs-root="" aria-label="Documentation pages">
			<button type="button" class="picker" aria-expanded="false"><span><small>Docs</small>${text(current?.title ?? 'Overview')}</span>${icon('chevrons-up-down')}</button>
			${searchBox()}
			<div class="groups">
				<ul><li><a href="./"${current ? '' : ' aria-current="page"'}>${icon('book')}Overview</a></li></ul>${groups}
			</div>
		</aside>`;
}

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
	<div class="wrap docs">${docsSidebar(page, doc)}
		<article class="doc">
			<div class="doc-top">
				<p class="crumbs"><a href="./">Docs</a>${icon('chevron-right')}<span>${text(group.name)}</span></p>
				${copyButton(`${page.slug}.md`)}
			</div>
			<h1>${text(doc.title)}</h1>
			${doc.lead ? `<p class="lead">${doc.lead}</p>` : ''}
${doc.html}
			<nav class="pager" aria-label="Pages">${previous ? `<a href="${previous.slug}.html"><small>Previous</small><b>${text(previous.title)}</b></a>` : ''}${next ? `<a class="next" href="${next.slug}.html"><small>Next</small><b>${text(next.title)}</b></a>` : ''}</nav>
			<p class="edit"><span>${c.version ? `Up to date with GeminiCode ${text(c.version)}` : ''}</span><a href="${attr(c.repoUrl)}/blob/main/gemini/docs/guide/${page.slug}.md">Edit this page on GitHub</a></p>
		</article>${onPage.length >= 2 ? `
		<aside class="onpage" aria-label="On this page">
			<h2>On this page</h2>
			<nav>${onPage.map(h => `<a href="#${attr(h.id)}">${text(h.text)}</a>`).join('')}</nav>
		</aside>` : ''}
	</div>`;
		fs.writeFileSync(path.join(docsDir, `${page.slug}.html`), layout(`${doc.title} · GeminiCode docs`, body, c, 'docs', '../', page.summary));
		const markdown = markdownForCopy(source, pageUrl);
		fs.writeFileSync(path.join(docsDir, `${page.slug}.md`), markdown);
		copies.push(markdown);
		search.push({ page: page.title, heading: '', text: page.summary, url: `${page.slug}.html` });
		for (const section of doc.sections) {
			search.push({ page: page.title, heading: section.heading, text: section.text, url: `${page.slug}.html#${section.id}` });
		}
	});

	const guides = docPages.filter(page => page.topics.length).map(page => `
				<a class="guide panel lift" href="${page.slug}.html"><span class="ico">${icon(page.icon as keyof typeof icons)}</span><b>${text(page.title)}</b><p>${text(page.summary)}</p><span class="topics">${page.topics.map(topic => `<span>${text(topic)}</span>`).join('')}</span></a>`).join('');
	const total = featureIndex.reduce((sum, group) => sum + group.items.length, 0);
	const features = featureIndex.map(group => `
				<div class="fg">
					<h3>${text(group.name)} <span>${group.items.length}</span></h3>
					<ul class="fl">${group.items.map(item => `
						<li><a href="${attr(item.href)}">${icon(item.icon as keyof typeof icons)}<span><b>${text(item.title)}</b><span>${text(item.body)}</span></span>${icon('arrow-right', 'go')}</a></li>`).join('')}
					</ul>
				</div>`).join('');
	for (const group of featureIndex) {
		for (const item of group.items.filter(item => !search.some(entry => entry.url === item.href))) {
			search.push({ page: group.name, heading: item.title, text: item.body, url: item.href });
		}
	}
	const home = `
	<div class="wrap docs home">${docsSidebar(undefined)}
		<div class="doc" style="max-width:none">
			<div class="dhero">
				<div class="doc-top"><p class="eyebrow">Documentation</p>${copyButton('all.md', 'Copy all as Markdown')}</div>
				<h1>Everything GeminiCode does, and how to use it</h1>
				<p>Start with <a href="getting-started.html">Getting started</a>, or jump to a feature below. Screenshots follow the theme you're reading in.</p>
				${searchBox(true)}
			</div>
			<div class="guides">${guides}
			</div>
			<section class="allf">
				<h2 id="all-features">All features</h2>
				<p>${total} features. Each one links to where it's explained, and <a href="shortcuts.html">Keyboard shortcuts</a> lists every key.</p>${features}
			</section>
		</div>
	</div>`;
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
		tag_name: 'v1.0.0',
		name: 'GeminiCode 1.0.0',
		html_url: `https://github.com/${repo}/releases/tag/v1.0.0`,
		published_at: '2026-10-16T12:00:00Z',
		body: 'GeminiCode 1.0.0 for Mac with Apple silicon, built on Code - OSS 1.141.0 with Gemini CLI 0.64.0.\n\n## What\'s Changed\n\n- Projects (preview): a coordinator that splits bigger work into threads\n- Add to Gemini and notes in the browser\n- Safer session approvals\n\n### Known limitations\n\n- No autocomplete.',
		body_html: '<p>GeminiCode 1.0.0 for Mac with Apple silicon, built on Code - OSS 1.141.0 with Gemini CLI 0.64.0.</p><h2>What\'s Changed</h2><ul><li>Projects (preview): a coordinator that splits bigger work into threads</li><li>Add to Gemini and notes in the browser</li><li>Safer session approvals</li></ul><h3>Shortcuts</h3><table><thead><tr><th>Keys</th><th>What it does</th></tr></thead><tbody><tr><td><kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>Up</kbd></td><td>Jump to your previous prompt</td></tr><tr><td><kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd></td><td>Switch between Agents and Editor modes</td></tr></tbody></table><h3>Known limitations</h3><ul><li>No autocomplete.</li></ul>',
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
