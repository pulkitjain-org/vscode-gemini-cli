/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds the download page for GitHub Pages from the latest GitHub Release:
// `index.html` with the version, download button and release notes baked in,
// and `latest.json`, which the app's update notice reads. Run on every
// release and on changes to this folder (.github/workflows/gemini-pages.yml).
//
//   node gemini/site/build.mts <out-dir>            # needs GITHUB_REPOSITORY, uses GITHUB_TOKEN if set
//   node gemini/site/build.mts <out-dir> --sample   # a made-up release, to preview the page
//   node gemini/site/build.mts <out-dir> --none     # the page before the first release

import * as fs from 'node:fs';
import * as path from 'node:path';

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
	readonly name: string | null;
	readonly html_url: string;
	readonly published_at: string;
	readonly body_html?: string;
	readonly assets: readonly GitHubAsset[];
}

const siteDir = import.meta.dirname;
const dmgPattern = /^GeminiCode-.+-arm64(-unsigned)?\.dmg$/;

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
	fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(latest, null, '\t') + '\n');
	fs.writeFileSync(path.join(outDir, 'index.html'), renderPage(latest, notesHtml, repo));
	fs.copyFileSync(path.join(siteDir, 'site.css'), path.join(outDir, 'site.css'));
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
	return await response.json() as GitHubRelease;
}

// Images pasted into release notes come back in `body_html` as
// private-user-images.githubusercontent.com links whose token expires five
// minutes later, so the page would show broken images from then on. Copy each
// one next to the page while its link still works and point the notes at the
// copy. If a copy fails, use the image's permanent
// github.com/user-attachments link, which GitHub redirects to a fresh one.
const privateImagePattern = /(<img\b[^>]*?\ssrc=")(https:\/\/private-user-images\.githubusercontent\.com\/[^"]+)(")/g;
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

export function renderPage(latest: LatestRelease, notesHtml: string, repo: string): string {
	const repoUrl = `https://github.com/${repo}`;
	const dmg = latest.downloads['darwin-arm64'];
	const released = latest.publishedAt ? new Date(latest.publishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : undefined;

	const download = latest.version && dmg ? `
			<a class="download" href="${attr(dmg.url)}">
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0-5-5m5 5 5-5M5 21h14" /></svg>
				Download for Mac (Apple silicon)
			</a>
			<p class="meta">Version ${text(latest.version)}${released ? ` · ${text(released)}` : ''} · ${(dmg.size / 1024 / 1024).toFixed(0)} MB · macOS 12 or later</p>`
		: `
			<p class="download disabled" aria-disabled="true">No release yet</p>
			<p class="meta">The first build is on its way. <a href="${attr(repoUrl)}/releases">Check GitHub Releases</a>.</p>`;

	const unsignedNote = latest.version && latest.signed === false ? `
		<aside class="note">
			<h2>This build is not signed by Apple yet</h2>
			<p>macOS blocks it the first time. After dragging GeminiCode to Applications, open it once and choose <b>Done</b>. Then open <b>System Settings → Privacy &amp; Security</b> and choose <b>Open Anyway</b> next to GeminiCode.</p>
			<p>Or run this in Terminal: <code>xattr -dr com.apple.quarantine /Applications/GeminiCode.app</code></p>
		</aside>` : '';

	const notes = latest.version && notesHtml.trim() ? `
		<section id="release-notes">
			<h2>What's new in ${text(latest.version)}</h2>
			<div class="notes">${notesHtml}</div>
			<p><a href="${attr(latest.notesUrl ?? `${repoUrl}/releases`)}">See this release on GitHub</a></p>
		</section>` : '';

	const checksum = dmg?.sha256 ? `
			<p class="checksum">SHA-256 of ${text(dmg.name)}: <code>${text(dmg.sha256)}</code></p>` : '';

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>GeminiCode</title>
	<meta name="description" content="GeminiCode is a code editor with the Gemini CLI built in. Download it for Mac.">
	<link rel="icon" href="icon.svg" type="image/svg+xml">
	<link rel="stylesheet" href="site.css">
</head>
<body>
	<main>
		<header class="hero">
			<img class="logo" src="icon.svg" alt="" width="96" height="96">
			<h1>GeminiCode</h1>
			<p class="tagline">A full code editor with the Gemini CLI as its agent.</p>
${download}
			<p class="platforms">Mac with Apple silicon (M1 or later). Windows comes later.</p>
		</header>
${unsignedNote}
		<section>
			<h2>Install</h2>
			<ol class="steps">
				<li><b>Open the .dmg</b> and drag GeminiCode to Applications.</li>
				<li><b>Open GeminiCode.</b> The Get Started walkthrough opens. The Gemini CLI comes with the app.</li>
				<li><b>Sign in with Google</b>, with the account that holds your Gemini Code Assist license.</li>
				<li><b>Check your Google Cloud project</b>, if your organisation does not set it for you.</li>
				<li><b>Start an agent</b> from the Agents pane.</li>
			</ol>
			<p>When a newer GeminiCode is out, the app tells you and links back here. <a href="${attr(repoUrl)}/blob/main/gemini/docs/USING.md">Read the user guide</a>.</p>
		</section>
${notes}
		<footer>
${checksum}
			<p><a href="${attr(repoUrl)}/releases">All releases</a> · <a href="${attr(repoUrl)}">Source</a> · <a href="${attr(repoUrl)}/issues">Report a problem</a></p>
		</footer>
	</main>
</body>
</html>
`;
}

function text(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attr(value: string): string {
	return text(value).replace(/"/g, '&quot;');
}

function sampleRelease(repo: string): GitHubRelease {
	return {
		tag_name: 'v0.1.0',
		name: 'GeminiCode 0.1.0 (unsigned)',
		html_url: `https://github.com/${repo}/releases/tag/v0.1.0`,
		published_at: '2026-10-03T12:00:00Z',
		body_html: '<p>GeminiCode 0.1.0 for Mac with Apple silicon, built on Code - OSS 1.141.0 with Gemini CLI 0.62.0.</p><h2>What\'s Changed</h2><ul><li>Bundle a known-good Gemini CLI with the app</li><li>Tell users when a newer GeminiCode is out</li></ul>',
		assets: [
			{ name: 'GeminiCode-0.1.0-arm64-unsigned.dmg', browser_download_url: `https://github.com/${repo}/releases/download/v0.1.0/GeminiCode-0.1.0-arm64-unsigned.dmg`, size: 212_000_000 },
			{ name: 'GeminiCode-0.1.0-arm64-unsigned.dmg.sha256', browser_download_url: `sample:${'0123456789abcdef'.repeat(4)}`, size: 100 },
		],
	};
}

if (import.meta.main) {
	main(process.argv[2], process.argv[3]).catch(err => {
		console.error(err);
		process.exit(1);
	});
}
