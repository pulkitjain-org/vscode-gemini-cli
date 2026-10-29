/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
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
	/** For search results and link previews: at most 160 characters. */
	readonly description: string;
	/** A few of the page's topics, for its card on the docs home. */
	readonly topics: readonly string[];
}

export const docGroups: readonly { readonly name: string; readonly pages: readonly DocPage[] }[] = [
	{
		name: 'Start here', pages: [
			{ slug: 'getting-started', title: 'Getting started', icon: 'rocket', summary: 'Install, sign in, pick a model and run your first agent.', description: 'Install GeminiCode on a Mac with Apple silicon, sign in with Google, set your Cloud project and start your first Gemini agent.', topics: ['Install', 'Sign in', 'First agent', 'Make it yours', 'Updates'] },
		],
	},
	{
		name: 'Using GeminiCode', pages: [
			{ slug: 'agents', title: 'Agents', icon: 'bot', summary: 'Agents and Editor layouts, Home, branches, forks, and the workspace index and docs agents search.', description: 'Run Gemini agents side by side in GeminiCode: Home, Agents layout, agents on their own branch, forks, and the workspace index they search.', topics: ['Home', 'Agents layout', 'Own branch', 'Fork', 'Workspace index', 'Docs'] },
			{ slug: 'chat', title: 'Chat and prompting', icon: 'message', summary: 'The + menu, context, Enhance, Plan mode and Plan Review, steering, reactions and Compact.', description: 'Prompt a Gemini agent in GeminiCode: attach context, enhance prompts, plan first and review the plan, steer or queue messages, react with emoji and compact.', topics: ['+ menu', '@ context', 'Enhance', 'Plan Review', 'Send or queue', 'Reactions', 'Compact'] },
			{ slug: 'review', title: 'Review and safety', icon: 'shield-check', summary: 'Approvals, folder trust, Keep and Undo, Rewind, inline edit and Review My Changes.', description: 'How GeminiCode keeps you in control of Gemini agents: approval modes, permission cards, Keep and Undo, Rewind, inline edit and what agents can\'t read.', topics: ['Approval modes', 'Folder trust', 'Keep and Undo', 'Rewind', 'Inline edit', 'Review My Changes'] },
			{ slug: 'terminal', title: 'Terminal', icon: 'terminal', summary: 'Each agent\'s terminal, Run on a reply\'s commands, and sending output to Gemini.', description: 'Each GeminiCode agent has its own terminal. Run the commands Gemini suggests, send terminal output to Gemini, and press ⌘I to ask for a command.', topics: ['Agent terminal', 'Run', 'Send to Gemini', '⌘I'] },
			{ slug: 'projects', title: 'Projects', icon: 'network', summary: 'A coordinator and its threads, across one or more repositories.', description: 'GeminiCode Projects: talk to a coordinator that splits work into threads, each a Gemini agent on its own branch, across one or more repositories.', topics: ['Coordinator', 'Threads', 'Try in Workspace', 'Repositories', 'Memory'] },
			{ slug: 'browser', title: 'Browser', icon: 'globe', summary: 'Add to Gemini, notes on the page, console and network.', description: 'Let Gemini agents use GeminiCode\'s browser: open your app, point at elements, pin notes on the page, and read the console and network.', topics: ['Add to Gemini', 'Notes', 'Shared pages', 'Console'] },
			{ slug: 'team-tools', title: 'Team tools', icon: 'plug', summary: 'Jira, Confluence, GitLab, SonarQube, Snyk and Figma, and the Home dashboard.', description: 'Connect Jira, Confluence, GitLab, SonarQube, Snyk and Figma to GeminiCode: start from a ticket, open and merge the merge request, and review with Gemini.', topics: ['Connections', 'Home', 'Ticket to MR', 'Ticket comments', 'Confluence', 'Review', 'Audit log'] },
		],
	},
	{
		name: 'Set up and fix', pages: [
			{ slug: 'helpers', title: 'Agent Setup', icon: 'blocks', summary: 'Four tabs: what agents load, the index and docs, connections, and storage with the audit log.', description: 'GeminiCode\'s Agent Setup: what agents load and what each model call costs, the workspace index and docs, your connections, and storage with the audit log.', topics: ['Loads', 'Index & Docs', 'Connections', 'Storage & Audit'] },
			{ slug: 'settings', title: 'Settings', icon: 'settings', summary: 'Every GeminiCode setting by area, and the ones an administrator can lock.', description: 'Every GeminiCode setting, grouped by area with its default, and the settings an administrator can lock with a policy.', topics: ['Chat', 'Agents', 'Browser', 'Team tools', 'Policies'] },
			{ slug: 'shortcuts', title: 'Keyboard shortcuts', icon: 'keyboard', summary: 'Every shortcut in one table, by area.', description: 'Every GeminiCode keyboard shortcut in one place: agents and layout, the chat, the editor, the terminal and the browser.', topics: ['Agents', 'Chat', 'Editor', 'Browser'] },
			{ slug: 'troubleshooting', title: 'Troubleshooting', icon: 'life-buoy', summary: 'Common problems, a performance trace, and how to report a bug well.', description: 'Fix common GeminiCode problems: sign-in, the Gemini CLI, folder trust, the index, slow agents, and how to report a bug.', topics: ['Common problems', 'Trace', 'Report'] },
		],
	},
];

export const docPages: readonly DocPage[] = docGroups.flatMap(group => group.pages);

export interface Feature { readonly icon: string; readonly title: string; readonly body: string; readonly href: string }

/** Every feature, by group, each linking to where its page explains it. */
export const featureIndex: readonly { readonly name: string; readonly items: readonly Feature[] }[] = [
	{
		name: 'Agents', items: [
			{ icon: 'layout-grid', title: 'Agents and Editor layouts', body: 'Agents on the left, the chat in the middle, its changes on the right. ⌥⌘M switches.', href: 'agents.html#agents-and-editor-layouts' },
			{ icon: 'sparkles', title: 'Home', body: 'Describe a task, choose Here or On a Branch, and press Return.', href: 'agents.html#home' },
			{ icon: 'bot', title: 'Agents side by side', body: 'Each agent has its own tab and chat, with a status dot.', href: 'agents.html#agents-side-by-side' },
			{ icon: 'columns-2', title: 'Files beside each agent', body: 'What an agent opens goes in a group of its own beside its chat.', href: 'agents.html#files-beside-each-agent' },
			{ icon: 'git-branch', title: 'Agents on their own branch', body: 'A copy of the repository on a new branch. Try its work in yours, then keep it.', href: 'agents.html#agents-on-their-own-branch' },
			{ icon: 'eye', title: 'Follow the agent', body: 'Each file the agent reads or edits opens at its line.', href: 'agents.html#follow-the-agent' },
			{ icon: 'split', title: 'Fork an agent', body: 'A new agent from another\'s conversation, on a branch of its own.', href: 'agents.html#fork-an-agent' },
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
			{ icon: 'list-checks', title: 'Plan, then build', body: 'Plan mode reads and plans. Approve Plan starts the work.', href: 'chat.html#plan-then-build' },
			{ icon: 'pencil', title: 'Review the plan', body: 'Edit the plan by section, comment, and send every comment at once.', href: 'chat.html#review-the-plan' },
			{ icon: 'list-tree', title: 'Folded turns and subagents', body: 'Each finished turn folds under one line, with subagents as rows.', href: 'chat.html#watching-the-agent-work' },
			{ icon: 'sigma', title: 'Replies that read well', body: 'Typeset math, coloured code, file links and spell check.', href: 'chat.html#replies' },
			{ icon: 'send', title: 'Send or queue while it works', body: 'Return steers the agent at the next safe point; ⌘Return queues for after the turn.', href: 'chat.html#sending-while-the-agent-works' },
			{ icon: 'smile', title: 'React to replies', body: '👍 go ahead, 👎 not what I meant, ❓ explain more simply, or any emoji.', href: 'chat.html#reacting-to-replies' },
			{ icon: 'minimize-2', title: 'Compact', body: 'Summarise a long chat into a smaller session that stays compacted.', href: 'chat.html#compact' },
			{ icon: 'gauge', title: 'Usage and quota', body: 'A ring shows how full the chat is; click it for today\'s quota.', href: 'chat.html#usage-and-quota' },
		],
	},
	{
		name: 'Terminal', items: [
			{ icon: 'terminal', title: 'A terminal per agent', body: 'Opened in the agent\'s folder, closed with the agent.', href: 'terminal.html#the-agents-terminal' },
			{ icon: 'play', title: 'Run a reply\'s commands', body: 'Run beside Copy; risky commands ask first in the block.', href: 'terminal.html#run-a-command-from-a-reply' },
			{ icon: 'send', title: 'Send output to Gemini', body: 'A selection or the last command, with its exit code and output.', href: 'terminal.html#send-terminal-output-to-gemini' },
			{ icon: 'wand-sparkles', title: 'Ask for a command', body: '⌘I in a terminal; nothing runs until you choose.', href: 'terminal.html#ask-for-a-command' },
		],
	},
	{
		name: 'Review and safety', items: [
			{ icon: 'shield-check', title: 'Approval modes', body: 'Every command and edit asks first. Allow once, for the session, or reject.', href: 'review.html#approval-modes' },
			{ icon: 'check', title: 'Folder trust', body: 'One question per folder, and every rule listed in Agent Setup.', href: 'review.html#folder-trust' },
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
			{ icon: 'git-merge', title: 'Try, keep or take back', body: 'Try a thread\'s changes in your checkout, then keep them or take them back.', href: 'projects.html#try-keep-or-take-back' },
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
			{ icon: 'plug', title: 'Connections', body: 'Sign in to Jira, Confluence, GitLab, SonarQube, Snyk and Figma with your own account.', href: 'team-tools.html#connect-your-tools' },
			{ icon: 'layout-dashboard', title: 'Home dashboard', body: 'Your tickets, merge requests and checks on one page.', href: 'team-tools.html#home' },
			{ icon: 'git-merge', title: 'Ticket to merge request', body: 'Start from a ticket, open the merge request, fix CI and comments.', href: 'team-tools.html#from-ticket-to-merge-request' },
			{ icon: 'message-square', title: 'Comment on a ticket', body: 'Markdown, @mentions and attachments, posted to Jira as you.', href: 'team-tools.html#comment-on-a-ticket' },
			{ icon: 'book', title: 'Draft Confluence pages', body: 'Agents draft; you keep or undo each change, then publish.', href: 'team-tools.html#draft-confluence-pages' },
			{ icon: 'plug', title: 'Several Jira sites', body: 'Tickets go to the site their link names.', href: 'team-tools.html#several-jira-sites' },
			{ icon: 'scan-search', title: 'Review a merge request', body: 'Gemini drafts the review; add your own comments, replies and suggestions, then post.', href: 'team-tools.html#review-a-merge-request' },
		],
	},
	{
		name: 'Set up', items: [
			{ icon: 'blocks', title: 'Agent Setup', body: 'Loads, Index & Docs, Connections, and Storage & Audit, in one page with tabs.', href: 'helpers.html' },
			{ icon: 'terminal', title: 'Gemini CLI inside', body: 'Your terminal\'s gemini and GeminiCode share settings and chats.', href: 'getting-started.html#set-up' },
			{ icon: 'settings', title: 'Settings', body: 'Every setting by area, and what an administrator can lock.', href: 'settings.html' },
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
	let figures = 0;
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
			out.push(renderFigure(image[1], image[2], image[3], options, !figures++));
			continue;
		}
		if (!lead && !out.length && title) {
			lead = inline(joined);
			continue;
		}
		note(plainText(joined));
		out.push(`<p>${inline(joined)}</p>`);
	}

	const html = out.join('\n').replace(/(href|src|poster|data-dark|data-light)="(__ROOT__)/g, `$1="${options.root}`).replace(/(srcset="[^"]*)/g, set => set.replace(/__ROOT__/g, options.root));
	return { title, lead: lead.replace(/__ROOT__/g, options.root), html, headings, sections };
}

/**
 * One copy of a product shot. Every shot in media/ is 2000 × 1250 (MEDIA-TODO.md), so its size
 * is known before it loads and the text below never moves; a 1000px copy beside it serves phones.
 * The page's first figure loads at once (it is usually its largest paint), the others when near.
 */
function mediaImage(file: string, alt: string, options: RenderOptions, cls: string, first: boolean): string {
	const phone = file.replace(/\.webp$/, '-1000.webp');
	const srcset = options.media.has(phone) ? ` srcset="__ROOT__media/${escapeAttr(phone)} 1000w, __ROOT__media/${escapeAttr(file)} 2000w" sizes="(max-width: 800px) calc(100vw - 48px), 720px"` : '';
	const loading = first && cls !== 'on-dark' ? ' fetchpriority="high"' : ' loading="lazy"';
	return `<img${cls ? ` class="${cls}"` : ''} src="__ROOT__media/${escapeAttr(file)}"${srcset} width="2000" height="1250" alt="${escapeAttr(alt)}"${loading} decoding="async">`;
}

function renderFigure(alt: string, src: string, title: string | undefined, options: RenderOptions, first: boolean): string {
	if (!src.startsWith(mediaPrefix)) {
		return `<figure><div class="shot"><img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy" decoding="async"></div><figcaption>${escape(alt)}</figcaption></figure>`;
	}
	const name = src.slice(mediaPrefix.length);
	const themed = /^(.*)-dark\.webp$/.exec(name);
	const pair = themed && options.media.has(`${themed[1]}-light.webp`) ? [`${themed[1]}-dark.webp`, `${themed[1]}-light.webp`] : undefined;
	const clip = title === 'clip' ? /^showcase-([\w-]+)-dark\.webp$/.exec(name) : null;
	let shot: string;
	if (clip && pair && options.media.has(`showcase-${clip[1]}-dark.mp4`) && options.media.has(`showcase-${clip[1]}-light.mp4`)) {
		// A clip shows its last frame, in the page's theme, until Play loads the video (page.mts):
		// a <video> fetches its poster even when the theme hides it, so this way only one loads.
		const stills = pair.map((file, n) => mediaImage(file, alt, options, `on-${n ? 'light' : 'dark'}`, first)).join('');
		shot = `${stills}<button type="button" class="clip-play" data-dark="__ROOT__media/showcase-${clip[1]}-dark.mp4" data-light="__ROOT__media/showcase-${clip[1]}-light.mp4" aria-label="Play the clip: ${escapeAttr(alt)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></button>`;
	} else if (pair) {
		shot = pair.map((file, n) => mediaImage(file, alt, options, `on-${n ? 'light' : 'dark'}`, first)).join('');
	} else {
		shot = mediaImage(name, alt, options, '', first);
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
