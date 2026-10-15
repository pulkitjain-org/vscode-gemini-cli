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
// The landing page's sections are fixed in `renderPage` and the lists above
// it (`projectSteps`, `browserSteps`, `newCards`, `clips`, `featureGroups`);
// edit them by hand when they change. Their screenshots and clips live in
// `gemini/site/media/`, each in a -dark and a -light copy (see `mediaFiles`
// and `clips`); a missing one is left out. `landing.mts` and `landing.css`
// run the hero clip, the chapters, the clip rail and its player and the
// feature filter, and `page.mts` runs the theme switch, the particles and the
// pointer's light; the .mts files are served as plain JavaScript. The Geist
// fonts in `gemini/site/fonts/` are served with the page.
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
 * The screenshots in `media/`, taken from the app at 1440 × 900 points:
 * `<name>-dark.webp` and `<name>-light.webp`. The chapters' are 1600 × 1000,
 * the new-in-this-release cards' 1400 × 1000. The clips sit beside them as
 * `showcase-<id>-<theme>.mp4`, each with its last frame as a .webp (see
 * `clips`).
 */
const mediaFiles = {
	'project-chat': { width: 1600, height: 1000 },
	'project-threads': { width: 1600, height: 1000 },
	'project-new-thread': { width: 1600, height: 1000 },
	'project-merge': { width: 1600, height: 1000 },
	'browser-page': { width: 1600, height: 1000 },
	'browser-notes': { width: 1600, height: 1000 },
	'browser-check': { width: 1600, height: 1000 },
	files: { width: 1400, height: 1000 },
	replies: { width: 1400, height: 1000 },
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
	for (const file of ['site.css', 'landing.css']) {
		fs.copyFileSync(path.join(siteDir, file), path.join(outDir, file));
	}
	for (const script of ['page', 'landing']) {
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
	<link rel="stylesheet" href="site.css">${current === 'home' ? '\n\t<link rel="stylesheet" href="landing.css">' : ''}
	<script>try { const t = localStorage.getItem('theme'); if (t === 'dark' || t === 'light') { document.documentElement.dataset.theme = t; } } catch {}</script>
	<script src="page.js" defer></script>${current === 'home' ? '\n\t<script src="landing.js" defer></script>' : ''}
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
				<a href="${home}#projects">Projects</a>
				<a href="${home}#browser">Browser</a>
				<a href="${home}#watch">Watch</a>
				<a href="${home}#features">Features</a>
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

/** A step of a chapter: the text on one side and its screenshot on the other. */
interface Step { readonly title: string; readonly body: string; readonly media: Media; readonly alt: string }

const projectSteps: readonly Step[] = [
	{ title: 'Describe the work', body: 'Ask for a bigger change in the project chat. The coordinator plans it and never edits files itself.', media: 'project-chat', alt: 'A project chat where the coordinator answers a request with a plan of two threads' },
	{ title: 'Threads start on their own branches', body: 'Each thread is an agent in its own worktree. Its card shows the state, branch, lines changed and time, and updates as it works.', media: 'project-threads', alt: 'Thread cards in the project chat, with the side panel counting threads by state' },
	{ title: 'Start one yourself', body: 'New thread takes a title, a brief, a branch and a model. Tick Plan first and it waits for your OK.', media: 'project-new-thread', alt: 'The New thread dialog with a title, a brief, a branch and Plan first' },
	{ title: 'Merge back when it\'s right', body: 'A finished thread offers Merge back, Review changes and Undo thread. Your follow-ups go to the thread that owns the work.', media: 'project-merge', alt: 'A finished thread card with Merge back, Review changes and Undo thread' },
];

const browserSteps: readonly Step[] = [
	{ title: 'Open the page you\'re working on', body: 'Localhost, a QA site, an intranet or a page you\'re signed in to. Gemini uses GeminiCode\'s browser where web fetch can\'t reach.', media: 'browser-page', alt: 'A cart page open in GeminiCode\'s browser beside the chat, with Add to Gemini in the toolbar' },
	{ title: 'Point at what to change', body: 'Add to Gemini puts an element, a screenshot or the console in your prompt. Or pin a note on each element and send them as one list.', media: 'browser-notes', alt: 'Notes pinned on the cart page, with Send to Gemini and Discard at the bottom' },
	{ title: 'Let the agent check its work', body: 'Agents read the console and failed requests, click, answer dialogs and reload until the page is right.', media: 'browser-check', alt: 'An agent reading the page\'s console and network requests while it fixes the cart' },
];

/**
 * The clips in the "Watch it work" rail, in order. Each is
 * `media/showcase-<id>-<theme>.mp4` with its last frame as a .webp; a clip
 * missing either theme is left out, so a new one joins the rail once its
 * files are in `media/`. The first one also plays in the hero.
 */
const clips = [
	{ id: 'work', category: 'Agents', title: 'Agents at work', caption: 'Describe a task in Agent Home and press Return. The agent reads, edits and shows each change on the right.', alt: 'An agent starting on a task in Agents mode, with three other agents in the list and its changes in the Changes panel' },
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

/** What is new in this release, under the chapters. A card with a screenshot spans two columns. */
const newCards: readonly { icon: keyof typeof icons; title: string; body: string; media?: Media; alt?: string }[] = [
	{ icon: 'columns-2', title: 'Files beside each agent', body: 'What an agent opens goes in a group of its own beside its chat, with a tab row. Switch agents and each one\'s files are just as you left them.', media: 'files', alt: 'An agent\'s chat with the files it opened in a group beside it' },
	{ icon: 'zap', title: 'Ready when you are', body: 'A session is already open, so a new agent starts on your task the moment you press Return. A project\'s threads start while their branch is set up.' },
	{ icon: 'shield-check', title: 'Safer to say yes', body: 'Allow for this session covers the programs you approved and nothing they hand work to, such as <code>env</code> or <code>python -c</code>. A link can\'t lead the agent to a secret file.' },
	{ icon: 'sigma', title: 'Replies that read well', body: 'Math is typeset and code is coloured like the editor. The composers check your spelling, with suggestions on right-click, and Agent Home has Write and Preview too.', media: 'replies', alt: 'A reply with typeset math and coloured code, and a misspelt word underlined in the composer' },
];

/** Everything in GeminiCode, by group. `isNew` marks what this release added; clear it on the next one. */
const featureGroups: readonly { id: string; name: string; items: readonly { icon: keyof typeof icons; title: string; body: string; isNew?: true }[] }[] = [
	{
		id: 'agents', name: 'Agents', items: [
			{ icon: 'layout-grid', title: 'Agents and Editor modes', body: 'Agents on the left, the chat in the middle, its changes on the right. <kbd>⌥⌘M</kbd> switches to the classic layout.' },
			{ icon: 'sparkles', title: 'Agent Home', body: 'Describe a task and press Return. Every agent gets a card with its status, changes and next step.' },
			{ icon: 'bot', title: 'Agents side by side', body: 'Each agent has its own tab and chat, with a status dot: working, waiting on you, or done.' },
			{ icon: 'columns-2', title: 'Files beside each agent', body: 'What an agent opens goes in a group of its own beside its chat, just as you left it.', isNew: true },
			{ icon: 'git-branch', title: 'Agents on their own branch', body: 'A copy of the repository on a new branch, ready to run with a setup script. Merge Back when done.' },
			{ icon: 'zap', title: 'Ready when you are', body: 'A session is already open, so a new agent starts on your task the moment you press Return.', isNew: true },
			{ icon: 'bell', title: 'Know when it\'s done', body: 'A Mac notification and a Dock badge when an agent finishes or needs you.' },
			{ icon: 'blocks', title: 'Project Helpers', body: 'MCP servers, skills, hooks, extensions and memory on one page, with a switch for each.' },
			{ icon: 'terminal', title: 'Gemini CLI inside', body: 'Nothing to install. Your terminal\'s gemini and GeminiCode share settings and saved chats.' },
		],
	},
	{
		id: 'projects', name: 'Projects', items: [
			{ icon: 'network', title: 'A project chat', body: 'Describe bigger work. The coordinator splits it into threads and passes your follow-ups on.', isNew: true },
			{ icon: 'git-merge', title: 'Threads you can merge', body: 'Each thread is an agent on its own branch, shown as a card with Merge back, Review and Undo.', isNew: true },
			{ icon: 'list-checks', title: 'Plan first', body: 'Start a thread yourself and have it wait for Approve plan before it changes files.', isNew: true },
			{ icon: 'list-tree', title: 'The project at a glance', body: 'A side panel counts threads by state and shows Conductor tracks and the coordinator\'s model.', isNew: true },
		],
	},
	{
		id: 'browser', name: 'Browser', items: [
			{ icon: 'globe', title: 'A browser your agents use', body: 'Agents open the app they\'re building, then click, type and take screenshots to check their work.' },
			{ icon: 'mouse-pointer', title: 'Add to Gemini', body: 'Put an element, a screenshot or the console of a page into your prompt.', isNew: true },
			{ icon: 'sticky-note', title: 'Notes on the page', body: 'Pin a change on each element, such as "make this button primary", and send them as one list.', isNew: true },
			{ icon: 'lock', title: 'QA and intranet pages', body: 'Gemini opens private and signed-in pages in the browser, where web fetch can\'t reach.', isNew: true },
			{ icon: 'activity', title: 'Console and network', body: 'Agents read the console and failed requests, answer dialogs and find your running dev server.', isNew: true },
			{ icon: 'cookie', title: 'Sign in once', body: 'Agents can keep their sign-ins per workspace. Admins can limit them to a list of sites.', isNew: true },
		],
	},
	{
		id: 'review', name: 'Review and safety', items: [
			{ icon: 'shield-check', title: 'Ask before acting', body: 'Every command and edit asks first. Allow once, for the session, or reject.' },
			{ icon: 'shield-check', title: 'Safer session approvals', body: 'Allow for this session covers the programs you approved, never ones like <code>env</code> or <code>python -c</code>.', isNew: true },
			{ icon: 'git-compare', title: 'Review in place', body: 'Keep or Undo above each change in the file, or all at once from the Changes panel.' },
			{ icon: 'undo', title: 'Undo a reply', body: 'Each reply that changed files can be undone in one click.' },
			{ icon: 'scan-search', title: 'Review My Changes', body: 'An agent in Plan mode reads your uncommitted diff and reports findings.' },
			{ icon: 'lock', title: 'Secrets stay out', body: 'The agent can\'t read .env, private keys or git-ignored files, even through a link.' },
			{ icon: 'folder', title: 'Agents keep to their folder', body: 'In a window with several folders, each agent stays in its own folder unless you allow all.', isNew: true },
		],
	},
	{
		id: 'prompting', name: 'Prompting and chat', items: [
			{ icon: 'wand-sparkles', title: 'Enhance prompt', body: 'Plain words in, a precise prompt out. <kbd>⌥⌘E</kbd>, and nothing is sent until you press Send.' },
			{ icon: 'plus', title: 'One + menu', body: 'Mode, files, @ context, skills, Follow the agent, the model and usage, in one place.' },
			{ icon: 'at-sign', title: 'Context', body: 'Type @ for files, <kbd>⌘L</kbd> for the selection, or drop in files and images.' },
			{ icon: 'list-checks', title: 'Plan, then build', body: 'A plan ends with Build This Plan. On Auto, Gemini plans with Pro and builds with Flash.' },
			{ icon: 'eye', title: 'Follow the agent', body: 'Each file the agent reads or edits opens at its line as it works.' },
			{ icon: 'text-cursor-input', title: 'Inline edit', body: 'Select code, press <kbd>⌘I</kbd> and say what to change.' },
			{ icon: 'history', title: 'Pick up a CLI session', body: 'A new agent lists the Gemini CLI sessions saved for its folder, terminal ones too.' },
			{ icon: 'sigma', title: 'Math and code', body: 'Math is typeset and code is coloured like the editor. File names open the file.', isNew: true },
			{ icon: 'spell-check', title: 'Spell check', body: 'The composers underline misspelt words, with suggestions on right-click.', isNew: true },
			{ icon: 'gauge', title: 'Usage at a glance', body: 'A ring shows how full the chat is. Click it for today\'s quota for each model.' },
		],
	},
];

/**
 * A chapter: numbered steps beside a stage that shows each step's screenshot.
 * landing.mts moves through the steps while the chapter is on screen. Without
 * every step's screenshot, the steps are a plain list beside no stage.
 */
function chapter(id: string, steps: readonly Step[], available: ReadonlySet<string>, flip: boolean, intro: string): string {
	const staged = steps.every(step => hasMedia(step.media, available));
	const list = steps.map((step, i) => staged
		? `<li><button type="button" class="step" role="tab" id="${id}-step-${i}" aria-controls="${id}-stage" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}"><span class="step-n">${i + 1}</span><span class="step-t"><b>${text(step.title)}</b><span>${text(step.body)}</span></span><span class="step-bar" aria-hidden="true"></span></button></li>`
		: `<li class="step"><span class="step-n">${i + 1}</span><span class="step-t"><b>${text(step.title)}</b><span>${text(step.body)}</span></span></li>`).join('\n\t\t\t\t\t\t');
	const stage = staged ? `
				<div class="stage panel" id="${id}-stage" role="tabpanel" aria-labelledby="${id}-step-0">${steps.map((step, i) => `<div class="frame${i === 0 ? ' on' : ''}">${themed(step.media, available, step.alt)}</div>`).join('')}</div>` : '';
	return `
		<div class="chapter${flip ? ' flip' : ''}${staged ? '' : ' plain'}">
				<div class="ch-text">${intro}
					<ol class="ch-steps"${staged ? ` role="tablist" aria-label="Steps"` : ''}>
						${list}
					</ol>
				</div>${stage}
			</div>`;
}

function renderClips(shown: readonly Clip[]): string {
	if (!shown.length) {
		return '';
	}
	const categories = [...new Set(shown.map(clip => clip.category))];
	const chips = categories.length > 1 ? `
				<div class="chips" role="group" aria-label="Show clips about">
					<button type="button" class="chip-btn" aria-pressed="true" data-filter="">All</button>${categories.map(category => `<button type="button" class="chip-btn" aria-pressed="false" data-filter="${attr(category)}">${text(category)}</button>`).join('')}
				</div>` : '<div></div>';
	const cards = shown.map(clip => `
				<button type="button" class="clip panel lift" data-clip="${clip.id}" data-category="${attr(clip.category)}" data-title="${attr(clip.title)}" data-caption="${attr(clip.caption)}" data-alt="${attr(clip.alt)}">
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
			<div class="rail-bar">${chips}
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

function renderFeatures(): string {
	const total = featureGroups.reduce((sum, group) => sum + group.items.length, 0);
	return `
	<section id="features" class="block">
		<div class="wrap">
			<div class="head">
				<p class="eyebrow">Everything in GeminiCode</p>
				<h2 class="h2">From prompt to merge</h2>
				<p>Every feature in one place. Pick a group to narrow it down.</p>
			</div>
			<div class="chips center" role="group" aria-label="Show features about">
				<button type="button" class="chip-btn" aria-pressed="true" data-filter="">Everything</button>${featureGroups.map(group => `<button type="button" class="chip-btn" aria-pressed="false" data-filter="${group.id}">${text(group.name)}</button>`).join('')}
			</div>
			<p class="fcount" aria-live="polite"><span>${total}</span> features</p>
			${featureGroups.map(group => `<div class="fgroup" data-group="${group.id}">
				<h3>${text(group.name)} <span>${group.items.length}</span></h3>
				<div class="fgrid">${group.items.map(item => `
					<article class="feat panel lift"><div class="feat-h"><span class="ico">${icon(item.icon)}</span><h4>${text(item.title)}</h4>${item.isNew ? '<span class="new">New</span>' : ''}</div><p>${item.body}</p></article>`).join('')}
				</div>
			</div>`).join('\n\t\t\t')}
		</div>
	</section>`;
}

export function renderPage(latest: LatestRelease, repo: string, available: ReadonlySet<string> = new Set()): string {
	const c = context(latest, repo);
	const pill = c.version
		? `<a class="pill" href="notes.html"><i class="dot"></i><span>New in ${text(c.version)}: Projects, and a browser you can point at</span>${icon('arrow-right')}</a>` : '';
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
	const crop = (media: Media | undefined, alt = '') => {
		const shot = media ? themed(media, available, alt) : '';
		return shot ? `<div class="crop">${shot}</div>` : '';
	};
	const cards = newCards.map(card => {
		const shot = crop(card.media, card.alt);
		const words = `<div class="ico">${icon(card.icon)}</div><h3>${text(card.title)}</h3><p>${card.body}</p>`;
		return shot
			? `<article class="card wide panel lift"><div>${words}</div>${shot}</article>`
			: `<article class="card panel lift">${words}</article>`;
	}).join('\n\t\t\t\t');

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

	<section id="projects" class="block">
		<div class="wrap">${chapter('projects', projectSteps, available, false, `
					<p class="ch-badge"><span class="ico">${icon('network')}</span>Projects<span class="tag">Preview</span></p>
					<h2>Hand a project to a team of agents.</h2>
					<p>A project chat takes the bigger jobs. Its coordinator splits the work into threads, each an agent on its own branch, and keeps track of them so you don't have to.</p>`)}
		</div>
	</section>

	<section id="browser" class="block">
		<div class="wrap">${chapter('browser', browserSteps, available, true, `
					<p class="ch-badge"><span class="ico">${icon('globe')}</span>Browser</p>
					<h2>Show Gemini the page you mean.</h2>
					<p>GeminiCode's browser is shared with your agents. Point at an element, pin notes where things should change, and let the agent check its own work in the console and network.</p>`)}
		</div>
	</section>

	<section id="new" class="block">
		<div class="wrap">
			<div class="head">
				<p class="eyebrow">${c.version ? `Also new in ${text(c.version)}` : 'Also new'}</p>
				<h2 class="h2">Faster to start, safer to say yes</h2>
				<a class="more" href="notes.html">Read the release notes ${icon('arrow-right')}</a>
			</div>
			<div class="bento">
				${cards}
			</div>
		</div>
	</section>
${renderClips(shownClips)}
${renderFeatures()}

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
		tag_name: 'v1.0.0',
		name: 'GeminiCode 1.0.0',
		html_url: `https://github.com/${repo}/releases/tag/v1.0.0`,
		published_at: '2026-10-16T12:00:00Z',
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
