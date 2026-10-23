/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The docs: which pages there are (one Markdown file each in gemini/docs/guide/),
// the feature index on the docs home, and a small Markdown renderer for the
// subset the pages use. build.mts lays the pages out. Pages are written to be
// read on GitHub too, so images point at gemini/site/media/ and links at the
// other .md files; the renderer maps both to the site.
//
// Markdown the renderer understands: # to ### headings, paragraphs, - and 1.
// lists (one level), | tables |, ``` code blocks, > [!NOTE] / [!TIP] /
// [!IMPORTANT] / [!WARNING] callouts (an icon and a title), a paragraph that is only an image, and
// inline `code`, **bold**, [links](x.md#y) and <kbd>. An image ending in
// -dark.webp shows its -light.webp copy on a light page; an image titled "clip"
// whose name is showcase-<id>-dark.webp plays that clip.

export interface DocPage {
	readonly slug: string;
	readonly title: string;
	readonly icon: string;
	readonly summary: string;
	/** A few of the page's topics, for its card on the docs home. */
	readonly topics: readonly string[];
}

export const docGroups: readonly { readonly name: string; readonly pages: readonly DocPage[] }[] = [
	{
		name: 'Start here', pages: [
			{ slug: 'getting-started', title: 'Getting started', icon: 'rocket', summary: 'Install, sign in, pick a model and run your first agent.', topics: ['Install', 'Sign in', 'First agent', 'Make it yours', 'Updates'] },
		],
	},
	{
		name: 'Using GeminiCode', pages: [
			{ slug: 'agents', title: 'Agents', icon: 'bot', summary: 'Agents and Editor modes, Home, branches, files beside each agent, and the workspace index and docs they search.', topics: ['Home', 'Agents mode', 'Own branch', 'Follow the agent', 'Workspace index', 'Docs'] },
			{ slug: 'chat', title: 'Chat and prompting', icon: 'message', summary: 'The + menu, context, slash commands, Enhance, Plan mode and replies.', topics: ['+ menu', '@ context', 'Slash commands', 'Enhance', 'Plan mode', 'Usage'] },
			{ slug: 'review', title: 'Review and safety', icon: 'shield-check', summary: 'Approvals, Keep and Undo, Rewind, inline edit and Review My Changes.', topics: ['Approval modes', 'Keep and Undo', 'Rewind', 'Inline edit', 'Review My Changes'] },
			{ slug: 'projects', title: 'Projects', icon: 'network', summary: 'A coordinator and its threads, across one or more repositories.', topics: ['Coordinator', 'Threads', 'Plan first', 'Repositories', 'Memory'] },
			{ slug: 'browser', title: 'Browser', icon: 'globe', summary: 'Add to Gemini, notes on the page, console and network.', topics: ['Add to Gemini', 'Notes', 'Shared pages', 'Console'] },
			{ slug: 'team-tools', title: 'Team tools', icon: 'plug', summary: 'Jira, GitLab, SonarQube, Snyk and Figma, and the Home dashboard.', topics: ['Connections', 'Home', 'Ticket to MR', 'Ticket comments', 'Review', 'Audit log'] },
		],
	},
	{
		name: 'Set up and fix', pages: [
			{ slug: 'helpers', title: 'Project Helpers and settings', icon: 'blocks', summary: 'Context per model call, MCP servers, skills, hooks, extensions, memory, rules and settings.', topics: ['Context cost', 'MCP servers', 'Skills', 'Hooks', 'Memory', 'Settings'] },
			{ slug: 'shortcuts', title: 'Keyboard shortcuts', icon: 'keyboard', summary: 'Every shortcut in one table, by area.', topics: ['Agents', 'Chat', 'Editor', 'Browser'] },
			{ slug: 'troubleshooting', title: 'Troubleshooting', icon: 'life-buoy', summary: 'Common problems, a performance trace, and how to report a bug well.', topics: ['Common problems', 'Trace', 'Report'] },
		],
	},
];

export const docPages: readonly DocPage[] = docGroups.flatMap(group => group.pages);

export interface Feature { readonly icon: string; readonly title: string; readonly body: string; readonly href: string }

/** Every feature, by group, each linking to where its page explains it. */
export const featureIndex: readonly { readonly name: string; readonly items: readonly Feature[] }[] = [
	{
		name: 'Agents', items: [
			{ icon: 'layout-grid', title: 'Agents and Editor modes', body: 'Agents on the left, the chat in the middle, its changes on the right. ⌥⌘M switches.', href: 'agents.html#agents-and-editor-modes' },
			{ icon: 'sparkles', title: 'Home', body: 'Describe a task and press Return. See what needs you across agents and tools.', href: 'agents.html#home' },
			{ icon: 'bot', title: 'Agents side by side', body: 'Each agent has its own tab and chat, with a status dot.', href: 'agents.html#agents-side-by-side' },
			{ icon: 'columns-2', title: 'Files beside each agent', body: 'What an agent opens goes in a group of its own beside its chat.', href: 'agents.html#files-beside-each-agent' },
			{ icon: 'git-branch', title: 'Agents on their own branch', body: 'A copy of the repository on a new branch. Merge Back when done.', href: 'agents.html#agents-on-their-own-branch' },
			{ icon: 'eye', title: 'Follow the agent', body: 'Each file the agent reads or edits opens at its line.', href: 'agents.html#follow-the-agent' },
			{ icon: 'scan-search', title: 'Workspace index', body: 'Agents find code, symbols and related files in one step, from a local index.', href: 'agents.html#workspace-index-and-docs' },
			{ icon: 'book', title: 'Attach documentation', body: 'Agents search a library\'s docs you attach instead of the web.', href: 'agents.html#attach-documentation' },
			{ icon: 'history', title: 'Pick up a CLI session', body: 'Continue a Gemini CLI session, terminal ones too.', href: 'agents.html#pick-up-a-gemini-cli-session' },
			{ icon: 'bell', title: 'Notifications', body: 'A Mac notification and a Dock badge when an agent needs you.', href: 'agents.html#notifications-and-keeping-awake' },
		],
	},
	{
		name: 'Chat and prompting', items: [
			{ icon: 'plus', title: 'The + menu', body: 'Mode, files, context, skills, model and usage, in one place.', href: 'chat.html#the--menu' },
			{ icon: 'at-sign', title: 'Context', body: 'Type @ for files, ⌘L for the selection, or drop in files and images.', href: 'chat.html#attaching-context' },
			{ icon: 'terminal', title: 'Slash commands and skills', body: 'Team commands, skills and the CLI\'s own, from /.', href: 'chat.html#slash-commands-and-skills' },
			{ icon: 'wand-sparkles', title: 'Enhance prompt', body: 'Plain words in, a precise prompt out. ⌥⌘E.', href: 'chat.html#enhance-prompt' },
			{ icon: 'list-checks', title: 'Plan, then build', body: 'Plan mode reads and plans. Build This Plan starts the work.', href: 'chat.html#plan-then-build' },
			{ icon: 'list-tree', title: 'Folded turns and subagents', body: 'Each finished turn folds under one line, with subagents as rows.', href: 'chat.html#watching-the-agent-work' },
			{ icon: 'sigma', title: 'Replies that read well', body: 'Typeset math, coloured code, file links and spell check.', href: 'chat.html#replies' },
			{ icon: 'gauge', title: 'Usage and quota', body: 'A ring shows how full the chat is; click it for today\'s quota.', href: 'chat.html#usage-and-quota' },
		],
	},
	{
		name: 'Review and safety', items: [
			{ icon: 'shield-check', title: 'Approval modes', body: 'Every command and edit asks first. Allow once, for the session, or reject.', href: 'review.html#approval-modes' },
			{ icon: 'git-compare', title: 'Keep and Undo in place', body: 'Review each change in the file, or all at once from Changes.', href: 'review.html#review-changes-in-place' },
			{ icon: 'undo', title: 'Undo or retry a reply', body: 'Each reply that changed files can be undone in one click.', href: 'review.html#undo-or-retry-a-reply' },
			{ icon: 'history', title: 'Rewind', body: 'Go back to before any message, files included.', href: 'review.html#rewind' },
			{ icon: 'text-cursor-input', title: 'Inline edit and commit messages', body: 'Select code, press ⌘I and say what to change.', href: 'review.html#inline-edit' },
			{ icon: 'scan-search', title: 'Review My Changes', body: 'An agent reads your uncommitted diff and reports findings.', href: 'review.html#review-my-changes' },
			{ icon: 'lock', title: 'Secrets stay out', body: 'Agents can\'t read .env, private keys or git-ignored files.', href: 'review.html#what-agents-cant-reach' },
		],
	},
	{
		name: 'Projects', items: [
			{ icon: 'network', title: 'A project chat', body: 'The coordinator splits bigger work into threads.', href: 'projects.html#talk-to-the-coordinator' },
			{ icon: 'git-merge', title: 'Threads you can merge', body: 'Each thread is an agent on its own branch, with Merge back.', href: 'projects.html#merge-back-review-or-undo' },
			{ icon: 'list-checks', title: 'Plan first', body: 'A thread can wait for Approve plan before it changes files.', href: 'projects.html#start-a-thread-yourself' },
			{ icon: 'folder', title: 'Several repositories', body: 'A thread gets a worktree of each repository it needs.', href: 'projects.html#several-repositories' },
			{ icon: 'book', title: 'Project settings and memory', body: 'Defaults, instructions and context files every thread reads.', href: 'projects.html#project-settings-and-memory' },
		],
	},
	{
		name: 'Browser', items: [
			{ icon: 'globe', title: 'A browser your agents use', body: 'Agents open your app, click, type and take screenshots.', href: 'browser.html#let-an-agent-open-your-app' },
			{ icon: 'mouse-pointer', title: 'Add to Gemini', body: 'Put an element, a screenshot or the console into your prompt.', href: 'browser.html#point-at-what-to-change' },
			{ icon: 'sticky-note', title: 'Notes on the page', body: 'Pin a change on each element and send them as one list.', href: 'browser.html#leave-notes-on-the-page' },
			{ icon: 'activity', title: 'Console and network', body: 'Agents read the console and failed requests.', href: 'browser.html#console-and-network' },
			{ icon: 'cookie', title: 'Sign in once', body: 'Keep sign-ins per workspace; admins can limit sites.', href: 'browser.html#sign-in-once' },
		],
	},
	{
		name: 'Team tools', items: [
			{ icon: 'plug', title: 'Connections', body: 'Sign in to Jira, GitLab, SonarQube, Snyk and Figma with your own account.', href: 'team-tools.html#connect-your-tools' },
			{ icon: 'layout-dashboard', title: 'Home dashboard', body: 'Your tickets, merge requests and checks on one page.', href: 'team-tools.html#home' },
			{ icon: 'git-merge', title: 'Ticket to merge request', body: 'Start from a ticket, open the merge request, fix CI and comments.', href: 'team-tools.html#from-ticket-to-merge-request' },
			{ icon: 'message-square', title: 'Comment on a ticket', body: 'Markdown, @mentions and attachments, posted to Jira as you.', href: 'team-tools.html#comment-on-a-ticket' },
			{ icon: 'scan-search', title: 'Review a merge request', body: 'Gemini drafts the review; add your own comments, replies and suggestions, then post.', href: 'team-tools.html#review-a-merge-request' },
		],
	},
	{
		name: 'Set up', items: [
			{ icon: 'blocks', title: 'Project Helpers', body: 'MCP servers, skills, hooks, extensions and memory, each with a switch.', href: 'helpers.html' },
			{ icon: 'terminal', title: 'Gemini CLI inside', body: 'Your terminal\'s gemini and GeminiCode share settings and chats.', href: 'getting-started.html#set-up-with-get-started' },
			{ icon: 'sparkles', title: 'Make it yours', body: 'Theme, code font and file icons.', href: 'getting-started.html#make-it-yours' },
			{ icon: 'download', title: 'Updates', body: 'Check for Updates, and a notice when a new build is out.', href: 'getting-started.html#updates' },
		],
	},
];

// ---- Markdown ----

export interface Heading { readonly level: number; readonly id: string; readonly text: string }

export interface RenderedDoc {
	readonly title: string;
	/** The paragraph under the title, as HTML. */
	readonly lead: string;
	/** Everything after the lead. */
	readonly html: string;
	readonly headings: readonly Heading[];
	/** Each section's heading and its first words, for search. */
	readonly sections: readonly { readonly id: string; readonly heading: string; readonly text: string }[];
}

export interface RenderOptions {
	/** The site's root from the page, such as `../`. */
	readonly root: string;
	/** File names in the site's media folder, including `docs/<name>`. */
	readonly media: ReadonlySet<string>;
}

const mediaPrefix = '../../site/media/';
const calloutKinds: Record<string, string> = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };

/** The callout's icon (Lucide, ISC License): an i in a circle, or a triangle for anything to take care with. */
function calloutIcon(kind: string): string {
	const warn = /^(WARNING|CAUTION|IMPORTANT)$/.test(kind);
	const body = warn
		? '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'
		: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>';
	return `<svg class="i co" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

/** GitHub's heading anchors, so links work on the site and on GitHub alike. */
export function slugify(heading: string): string {
	return heading.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
}

export function renderMarkdown(source: string, options: RenderOptions): RenderedDoc {
	const lines = source.replace(/\r\n/g, '\n').split('\n');
	const out: string[] = [];
	const headings: Heading[] = [];
	const sections: { id: string; heading: string; text: string }[] = [];
	let title = '';
	let lead = '';
	let i = 0;
	const inline = (value: string) => renderInline(value);
	const note = (plain: string) => {
		const last = sections[sections.length - 1];
		if (last && last.text.length < 160) {
			last.text = `${last.text} ${plain}`.trim();
		}
	};

	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			i++;
			continue;
		}
		const fence = /^```(\w*)/.exec(line);
		if (fence) {
			const body: string[] = [];
			for (i++; i < lines.length && !lines[i].startsWith('```'); i++) {
				body.push(lines[i]);
			}
			i++;
			out.push(`<pre tabindex="0"><code${fence[1] ? ` class="language-${fence[1]}"` : ''}>${escape(body.join('\n'))}</code></pre>`);
			continue;
		}
		const heading = /^(#{1,3})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			i++;
			if (level === 1) {
				title = heading[2].trim();
				continue;
			}
			const id = slugify(heading[2]);
			headings.push({ level, id, text: plainText(heading[2]) });
			sections.push({ id, heading: plainText(heading[2]), text: '' });
			out.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`);
			continue;
		}
		if (line.startsWith('>')) {
			const quoted: string[] = [];
			for (; i < lines.length && lines[i].startsWith('>'); i++) {
				quoted.push(lines[i].replace(/^>\s?/, ''));
			}
			const kind = /^\[!(\w+)\]\s*$/.exec(quoted[0]);
			const body = (kind ? quoted.slice(1) : quoted).join(' ').trim();
			note(plainText(body));
			out.push(kind
				? `<div class="callout ${kind[1].toLowerCase()}" role="note">${calloutIcon(kind[1])}<div><p class="callout-t">${calloutKinds[kind[1]] ?? kind[1]}</p><p>${inline(body)}</p></div></div>`
				: `<blockquote><p>${inline(body)}</p></blockquote>`);
			continue;
		}
		if (line.startsWith('|') && lines[i + 1]?.match(/^\|[\s:|-]+\|$/)) {
			const cells = (row: string) => row.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
			const head = cells(line);
			const rows: string[][] = [];
			for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) {
				rows.push(cells(lines[i]));
			}
			out.push(`<div class="table"><table><thead><tr>${head.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
			continue;
		}
		const listItem = /^(-|\d+\.)\s+/;
		if (listItem.test(line)) {
			const ordered = /^\d/.test(line);
			const items: string[] = [];
			for (; i < lines.length && (listItem.test(lines[i]) || /^\s{2,}\S/.test(lines[i])); i++) {
				if (listItem.test(lines[i])) {
					items.push(lines[i].replace(listItem, ''));
				} else {
					items[items.length - 1] += ` ${lines[i].trim()}`;
				}
			}
			note(plainText(items[0]));
			const tag = ordered ? 'ol' : 'ul';
			out.push(`<${tag}>${items.map(item => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
			continue;
		}
		const paragraph: string[] = [];
		for (; i < lines.length && lines[i].trim() && !/^(#|```|>|\||-\s|\d+\.\s)/.test(lines[i]); i++) {
			paragraph.push(lines[i].trim());
		}
		if (!paragraph.length) {
			// A line no rule took, such as a stray "|": keep it as text rather than loop.
			paragraph.push(lines[i++].trim());
		}
		const joined = paragraph.join(' ');
		const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/.exec(joined);
		if (image) {
			out.push(renderFigure(image[1], image[2], image[3], options));
			continue;
		}
		if (!lead && !out.length && title) {
			lead = inline(joined);
			continue;
		}
		note(plainText(joined));
		out.push(`<p>${inline(joined)}</p>`);
	}

	const html = out.join('\n').replace(/(href|src|poster)="(__ROOT__)/g, `$1="${options.root}`);
	return { title, lead: lead.replace(/__ROOT__/g, options.root), html, headings, sections };
}

function renderFigure(alt: string, src: string, title: string | undefined, options: RenderOptions): string {
	if (!src.startsWith(mediaPrefix)) {
		return `<figure><div class="shot"><img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy" decoding="async"></div><figcaption>${escape(alt)}</figcaption></figure>`;
	}
	const name = src.slice(mediaPrefix.length);
	const themed = /^(.*)-dark\.webp$/.exec(name);
	const pair = themed && options.media.has(`${themed[1]}-light.webp`) ? [`${themed[1]}-dark.webp`, `${themed[1]}-light.webp`] : undefined;
	const clip = title === 'clip' ? /^showcase-([\w-]+)-dark\.webp$/.exec(name) : null;
	let shot: string;
	if (clip && pair && options.media.has(`showcase-${clip[1]}-dark.mp4`) && options.media.has(`showcase-${clip[1]}-light.mp4`)) {
		// The clips have no speech; the empty captions track says so (build.mts writes it).
		shot = ['dark', 'light'].map(theme => `<video class="on-${theme}" src="__ROOT__media/showcase-${clip[1]}-${theme}.mp4" poster="__ROOT__media/showcase-${clip[1]}-${theme}.webp" controls muted playsinline preload="none" aria-label="${escapeAttr(alt)}"><track kind="captions" srclang="en" label="No speech" src="__ROOT__media/silent.vtt"></video>`).join('');
	} else if (pair) {
		shot = pair.map((file, n) => `<img class="on-${n ? 'light' : 'dark'}" src="__ROOT__media/${file}" alt="${escapeAttr(alt)}" loading="lazy" decoding="async">`).join('');
	} else {
		shot = `<img src="__ROOT__media/${escapeAttr(name)}" alt="${escapeAttr(alt)}" loading="lazy" decoding="async">`;
	}
	return `<figure${clip ? ' class="clip"' : ''}><div class="shot">${shot}</div><figcaption>${escape(alt)}</figcaption></figure>`;
}

/** `code`, **bold**, [links](...) and <kbd>; everything else is text. */
function renderInline(value: string): string {
	return value.split(/(`[^`]+`)/).map(part => {
		if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
			return `<code>${escape(part.slice(1, -1))}</code>`;
		}
		return escape(part)
			.replace(/&lt;(\/?)kbd&gt;/g, '<$1kbd>')
			.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
			.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => `<a href="${linkHref(href.replace(/&amp;/g, '&'))}">${label}</a>`);
	}).join('');
}

/** Another guide page becomes its .html page; anything else stays as written. */
function linkHref(href: string): string {
	const page = /^([\w-]+)\.md(#.*)?$/.exec(href);
	return escapeAttr(page ? `${page[1]}.html${page[2] ?? ''}` : href);
}

function plainText(value: string): string {
	return value.replace(/<[^>]+>/g, '').replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
}

/**
 * The page as Markdown to paste elsewhere: links and images point at the site,
 * and <kbd> keys are plain text.
 */
export function markdownForCopy(source: string, siteUrl: string): string {
	return source
		.replace(/\]\(\.\.\/\.\.\/site\/media\/([^)\s]+)(?:\s+"clip")?\)/g, `](${siteUrl}media/$1)`)
		.replace(/\]\(([\w-]+)\.md(#[^)]*)?\)/g, (_, page: string, hash: string | undefined) => `](${siteUrl}docs/${page}.html${hash ?? ''})`)
		.replace(/<\/?kbd>/g, '')
		.trim() + '\n';
}

function escape(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
	return escape(value).replace(/"/g, '&quot;');
}
