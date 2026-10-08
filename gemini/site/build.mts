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
// hand when they change. Their screenshots live in `gemini/site/images/`
// (hero.webp, agents.webp and review.webp at 2000 × 1250, chat.webp at
// 1620 × 1168); a missing image is left out. The Geist fonts in `gemini/site/fonts/` are served with the page.
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
const images = ['hero.webp', 'agents.webp', 'review.webp', 'chat.webp'] as const;
type Image = typeof images[number];
const imageSizes: Record<Image, readonly [number, number]> = { 'hero.webp': [2000, 1250], 'agents.webp': [2000, 1250], 'review.webp': [2000, 1250], 'chat.webp': [1620, 1168] };

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
	const available = new Set<Image>();
	for (const image of images) {
		const source = path.join(siteDir, 'images', image);
		if (fs.existsSync(source)) {
			fs.mkdirSync(path.join(outDir, 'images'), { recursive: true });
			fs.copyFileSync(source, path.join(outDir, 'images', image));
			available.add(image);
		}
	}
	fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(latest, null, '\t') + '\n');
	fs.writeFileSync(path.join(outDir, 'index.html'), renderPage(latest, repo, available));
	fs.writeFileSync(path.join(outDir, 'notes.html'), renderNotesPage(latest, notesHtml, repo));
	fs.copyFileSync(path.join(siteDir, 'site.css'), path.join(outDir, 'site.css'));
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

function layout(title: string, body: string, c: Context, current: 'home' | 'notes'): string {
	const get = c.dmg
		? `<a class="get" href="${attr(c.dmg.url)}">Download</a>`
		: `<a class="get" href="${attr(c.repoUrl)}/releases">Releases</a>`;
	const home = current === 'home' ? '' : './';
	const cta = c.dmg ? `
	<section class="cta wrap">
		<div>
			<div>
				<h2>Try GeminiCode ${text(c.version!)}</h2>
				<p>Free download for Macs with Apple silicon.</p>
			</div>
			<a class="btn small" href="${attr(c.dmg.url)}">Download for Mac</a>
		</div>
	</section>` : '';
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${text(title)}</title>
	<meta name="description" content="GeminiCode is a code editor with the Gemini CLI built in. Download it for Mac.">
	<link rel="icon" href="icon.svg" type="image/svg+xml">
	<link rel="preload" href="fonts/geist-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
	<link rel="stylesheet" href="site.css">
</head>
<body>
	<header class="top">
		<div class="wrap">
			<a class="brand" href="${home || './'}"><img src="icon.svg" alt=""><span>GeminiCode</span></a>
			<nav>
				<a class="dim wide" href="${home}#install">Install</a>
				<a class="dim" href="notes.html"${current === 'notes' ? ' aria-current="page"' : ''}>Release notes</a>
				<a class="dim wide" href="${attr(c.repoUrl)}/blob/main/gemini/docs/USING.md">Guide</a>
			</nav>
			<div class="spacer"></div>
			<a class="dim wide" href="${attr(c.repoUrl)}">GitHub</a>
			${get}
		</div>
	</header>
	<main>
${body}
	</main>
${cta}
	<footer class="foot">
		<div class="wrap">
			<span><img src="icon.svg" alt="">GeminiCode</span>
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

// ---- Landing page ----

export function renderPage(latest: LatestRelease, repo: string, available: ReadonlySet<Image> = new Set()): string {
	const c = context(latest, repo);
	// The hero shows straight away; the rest load as they scroll into view.
	const figure = (image: Image, alt: string, cls: string) => available.has(image)
		? `<div class="${cls}"><img src="images/${image}" alt="${attr(alt)}" width="${imageSizes[image][0]}" height="${imageSizes[image][1]}" ${image === 'hero.webp' ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"></div>` : '';

	const pill = c.version
		? `<a class="pill" href="notes.html"><b>New in ${text(c.version)}</b><span>See what's new →</span></a>` : '';
	const download = c.dmg ? `
				<a class="btn" href="${attr(c.dmg.url)}"><b>Download for Mac</b><span>Apple silicon · ${c.sizeMb} MB</span></a>`
		: `
				<span class="btn disabled"><b>No release yet</b><span>The first build is on its way</span></span>`;
	const meta = c.version
		? `v${text(c.version)}${c.releasedShort ? ` · ${text(c.releasedShort)}` : ''} · macOS 12+ · M1 or later`
		: `<a href="${attr(c.repoUrl)}/releases">Check GitHub Releases</a> · Mac with Apple silicon`;
	const hero = figure('hero.webp', 'GeminiCode in Agents mode with Glass Light: agents on the left, an agent at work in the middle, its changes on the right', 'shot');

	const body = `
	<section class="hero">
		<div class="wrap${hero ? '' : ' no-shot'}">
			${pill}
			<h1>Watch your agents work. Keep only what you want.</h1>
			<p class="sub">A full code editor with Gemini as its agent. Run agents side by side, see what each one is doing as it works, and review every change before you keep it. The Gemini CLI is built in.</p>
			<div class="actions">${download}
				<a class="ghost" href="#install">How to install</a>
			</div>
			<p class="meta">${meta}</p>
			${hero}
		</div>
	</section>

	<section class="highlights wrap">
		<div class="row">
			<div>
				<p class="eyebrow">New in 0.4.0</p>
				<h2 class="h2">Glass, a browser for your agents, and long tasks that keep going</h2>
			</div>
			<a href="notes.html">Read the release notes →</a>
		</div>
		<article class="feature">
			<div>
				<p class="eyebrow">Glass Light and Glass Dark</p>
				<h2 class="h2">A calmer window that stays out of the way.</h2>
				<p class="lede">The new default themes take after macOS Liquid Glass. The side bars are glass over an aurora wallpaper, the chat scrolls on under a glass composer, and tabs and the Agents | Editor switch sit in the title bar. Each agent's row shows a status dot and a short note, such as how long it has worked or that it's waiting for you.</p>
			</div>
			${figure('agents.webp', 'Glass Dark: the agent list, a chat with a test run and the Changes panel', 'frame')}
		</article>
		<article class="feature flip">
			<div>
				<p class="eyebrow">Every turn</p>
				<h2 class="h2">See what the agent is doing right now.</h2>
				<p class="lede">A strip above the composer shows how long the agent has worked and its current step, such as a test run, or that it's waiting for you. A ring turns round Stop while it works. Write and Preview tabs show your message as it will look once sent.</p>
			</div>
			${figure('chat.webp', 'A test run in the chat, with the working strip and the Stop button', 'frame')}
		</article>
		<div class="cards">
			<div class="card"><h3>A browser your agents can use</h3><p>Agents open the app they're building in the built-in browser, then read, click, type and take screenshots to check their work. Local pages open freely; other sites ask you first. Let Gemini Use This Page hands over a page you opened.</p></div>
			<div class="card"><h3>Keep the Mac awake</h3><p>While any agent works, the Mac doesn't go to sleep, so a long task carries on when you step away. The display can still sleep.</p></div>
			<div class="card"><h3>Follow the agent</h3><p>Click the eye in the composer and each file the agent reads or edits opens at the line it's on. Focus stays in the chat.</p></div>
			<div class="card"><h3>Find your way in long chats</h3><p>Point at the outline of your prompts down the chat's edge to jump back, or press ⌥⌘↑ and ⌥⌘↓. Open Chat as Markdown gives you the whole conversation as one file.</p></div>
			<div class="card"><h3>Project Helpers</h3><p>One page for what every agent loads: MCP servers, skills, hooks, Gemini CLI extensions and memory, with switches for servers, hooks and extensions. Skills show in the / menu too.</p></div>
			<div class="card"><h3>Branches ready to run</h3><p>Set a setup command, or commit <code>.gemini/worktree-setup.sh</code>, and it runs in each new agent branch before the agent starts.</p></div>
		</div>
	</section>

	<section class="highlights earlier wrap">
		<div class="row">
			<div>
				<p class="eyebrow">Also in GeminiCode</p>
				<h2 class="h2">Agents, review and chat</h2>
			</div>
		</div>
		<article class="feature">
			<div>
				<p class="eyebrow">Review</p>
				<h3 class="h3">Keep or undo every change.</h3>
				<p class="lede">The Changes panel lists everything an agent edited, with Keep, Undo and Commit. Open a changed file to review each edit in place. Any reply that touched files can be undone.</p>
			</div>
			${figure('review.webp', 'Reviewing an agent\'s changes in a file, with Keep and Undo above each one', 'frame')}
		</article>
		<div class="cards compact">
			<div class="card"><h3>Agents mode</h3><p>Describe a task in Agent Home and press Return. Each agent gets a card with its status, changes and next step. ⌥⌘M switches to the classic editor layout.</p></div>
			<div class="card"><h3>Agents on their own branch</h3><p>Tick On its own branch and the agent works in a Git worktree of its own, away from your files. Merge Back when it's done.</p></div>
			<div class="card"><h3>Enhance your prompt</h3><p>Write what you want in plain words and press Enhance, or ⌥⌘E. Gemini rewrites it as a clear prompt, and nothing is sent until you press Send.</p></div>
			<div class="card"><h3>Pick up a CLI session</h3><p>A new agent lists the Gemini CLI sessions saved for its folder, including ones you started in the terminal. Click Restore to carry on.</p></div>
			<div class="card"><h3>Inline edit</h3><p>Select code, press ⌘I and say what to change. Gemini rewrites just those lines. The sparkle in Source Control writes your commit message.</p></div>
			<div class="card"><h3>Review My Changes</h3><p>An agent in Plan mode reads your uncommitted diff and reports findings without editing anything.</p></div>
			<div class="card"><h3>Know when it's done</h3><p>A Mac notification and a Dock badge when an agent finishes or needs you, so you can work on something else.</p></div>
			<div class="card"><h3>Make it yours</h3><p>Glass Light and Glass Dark, or Dark, Midnight, Dusk and Light. Accent colours, chat text size, and JetBrains Mono and Geist Mono included.</p></div>
		</div>
	</section>

	<section id="install" class="install wrap">
		<div class="row">
			<div>
				<p class="eyebrow">Install</p>
				<h2 class="h2">Up and running in five steps</h2>
			</div>
			<a href="${attr(c.repoUrl)}/blob/main/gemini/docs/USING.md">Read the user guide →</a>
		</div>${unsignedNote(latest)}
		<ol class="steps">
			<li><span class="n">01</span><b>Open the .dmg</b><span>Drag GeminiCode to Applications.</span></li>
			<li><span class="n">02</span><b>Launch GeminiCode</b><span>The Get Started walkthrough opens. The Gemini CLI comes with the app.</span></li>
			<li><span class="n">03</span><b>Sign in with Google</b><span>Use the account that holds your Gemini Code Assist license.</span></li>
			<li><span class="n">04</span><b>Check your Cloud project</b><span>Only if your organisation doesn't set it for you.</span></li>
			<li><span class="n">05</span><b>Start an agent</b><span>Describe a task in Agent Home and press Return.</span></li>
		</ol>
		<p class="fine">GeminiCode tells you when an update is out and links back here.</p>
	</section>`;
	return layout('GeminiCode', body, c, 'home');
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
		<div class="notes"><p>The first build is on its way. <a href="${attr(c.repoUrl)}/releases">Check GitHub Releases</a>.</p></div>
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
			<div class="dl">
				<a class="btn small" href="${attr(c.dmg.url)}">Download ${text(c.version)}</a>
				<small>Apple silicon · ${c.sizeMb} MB · macOS 12 or later</small>
			</div>${toc}${sha}
		</aside>
		<div>${unsignedNote(latest)}
			<div class="notes">${html.trim() ? html : '<p>No notes for this release.</p>'}</div>
			<a class="more" href="${attr(latest.notesUrl ?? `${c.repoUrl}/releases`)}">See this release on GitHub ↗</a>
		</div>
	</section>`;
	return layout(`GeminiCode ${c.version} release notes`, body, c, 'notes');
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
