/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The feature pages, features/<slug>.html: one page per large part of
// GeminiCode, between the landing page and the docs. Each shows the feature
// working (a clip or screenshots from the real app, in media/), says what it
// does and how it works in a few steps, and links into the guide. build.mts
// lays them out; this file holds what they say and renders their body.
//
// Text is plain, with **bold** and `code`. A media name is a pair in media/,
// <name>-dark.webp and <name>-light.webp; a clip also has <name>-dark.mp4 and
// <name>-light.mp4 and plays with its .webp as the poster. A missing file
// leaves a labelled placeholder, as on the landing page.

export interface FeatureMedia {
	readonly name: string;
	readonly alt: string;
	readonly clip?: boolean;
}

export interface FeatureSection {
	readonly title: string;
	readonly body: readonly string[];
	readonly media?: FeatureMedia;
}

export interface FeaturePage {
	readonly slug: string;
	/** In the nav, the footer and the pager. */
	readonly name: string;
	/** One line under the name in the Features menu. */
	readonly summary: string;
	/** The headline, with its second half in italics. */
	readonly headline: readonly [string, string];
	readonly lead: string;
	readonly preview?: boolean;
	readonly hero: FeatureMedia;
	readonly steps: readonly { readonly title: string; readonly body: string }[];
	readonly sections: readonly FeatureSection[];
	readonly notes: readonly string[];
	readonly docs: readonly { readonly href: string; readonly label: string }[];
}

export const featurePages: readonly FeaturePage[] = [
	{
		slug: 'agents',
		name: 'Agents',
		summary: 'Several agents side by side, and the index they find code with.',
		headline: ['Run agents side by side.', 'They find the code in one step.'],
		lead: 'Each agent is a tab with its own chat, files and changes, in the folder it works in or on a branch of its own. A local index of every workspace lets agents go straight to the code that matters, instead of reading file by file.',
		hero: { name: 'showcase-work', alt: 'An agent at work in Agents mode: the agent list on the left, its chat in the middle and its changes on the right', clip: true },
		steps: [
			{ title: 'Describe the task', body: 'Type it on Home and press Return. Tick **On its own branch** to give the agent a copy of the repository on a new branch.' },
			{ title: 'Watch, or step away', body: 'A status dot per agent: a spinner while it works, amber when it waits for you, green when done. A Mac notification says when one needs you.' },
			{ title: 'Review its changes', body: 'Every file it changed is in Changes, beside its chat. Keep or undo each change in the file, or all at once.' },
			{ title: 'Bring the work back', body: '**Merge Back** merges an agent\'s branch into yours, and offers to remove the agent with its branch and folder.' },
		],
		sections: [
			{
				title: 'Files beside each agent',
				body: ['What an agent opens, files, diffs and pages, goes in a group of its own beside its chat. Switch agents and each one\'s files are where you left them. Turn on **Follow the agent** to watch each file it reads or edits open at its line.'],
				media: { name: 'files', alt: 'An agent\'s chat with the files it opened in a group beside it' },
			},
			{
				title: 'The workspace index',
				body: [
					'Each workspace keeps an index of its code on your Mac, built in a separate process at low priority and kept current as you save, switch branches and as agents edit. Agents ask it in one step: `code_search` for code by words or a description, `find_symbol` for where something is defined and used, `related_files` for imports, tests and files changed together, and `repo_map` for an outline of the repository.',
					'Attach a library\'s documentation and agents search it with `docs_search` instead of the web. GeminiCode suggests the docs for the dependencies your project names, at the versions you use.',
				],
				media: { name: 'index-page', alt: 'The Index page with two indexed workspaces and attached documentation' },
			},
			{
				title: 'Fork an agent',
				body: ['When an agent\'s work splits in two, fork it. The fork starts from the same conversation, so it already knows what was read, decided and planned, and works on its part while the agent carries on. Take the whole session, a compacted copy or just the conversation, on a new branch with the agent\'s uncommitted changes or in the same folder. **Fork** at the end of any reply forks from that point.'],
				media: { name: 'fork-dialog', alt: 'The Fork dialog with Whole session, Compacted and Conversation only, and a new branch or the same folder' },
			},
			{
				title: 'Pick up where the terminal left off',
				body: ['A new agent lists the sessions the Gemini CLI saved for its folder, including ones started with `gemini` in the terminal. Pick one and the conversation carries on in the chat.'],
			},
		],
		notes: [
			'Agents keep to the folder they work in, and can\'t read secret files such as `.env`, private keys or git-ignored files.',
			'The index never leaves your Mac. Secret files, binaries and git-ignored files are never indexed.',
			'While any agent works, the Mac doesn\'t go to sleep.',
		],
		docs: [
			{ href: 'agents.html', label: 'Agents' },
			{ href: 'agents.html#fork-an-agent', label: 'Fork an agent' },
			{ href: 'agents.html#workspace-index-and-docs', label: 'Workspace index and docs' },
			{ href: 'terminal.html', label: 'Terminal' },
			{ href: 'shortcuts.html', label: 'Keyboard shortcuts' },
		],
	},
	{
		slug: 'chat-and-review',
		name: 'Chat and review',
		summary: 'Prompting, Plan mode, reactions, approvals, and Keep, Undo and Rewind.',
		headline: ['Ask in plain words.', 'Review every change.'],
		lead: 'The chat holds everything a prompt needs: files and context, the model, the approval mode and your slash commands. Every command asks before it runs, and every change an agent makes can be kept, undone or rewound.',
		hero: { name: 'showcase-review', alt: 'Keeping an agent\'s edits one by one, with Keep and Undo above each change', clip: true },
		steps: [
			{ title: 'Write the prompt', body: '`@` adds files, ⌘L the selection, and you can drop in files, images and PDFs. **Enhance prompt** turns plain words into a precise prompt.' },
			{ title: 'Plan first, if you like', body: 'In Plan mode the agent reads and writes a plan, and changes nothing until you press **Build This Plan**.' },
			{ title: 'Approve what runs', body: 'A command or an edit shows a card first: allow it once, for the session, or reject it. Pick a looser mode when you trust the task.' },
			{ title: 'Keep or undo', body: 'Each change shows in its file with **Keep** and **Undo** above it. A reply that changed files undoes in one click, and **Rewind** goes back to before any message.' },
		],
		sections: [
			{
				title: 'The + menu',
				body: ['The approval mode, files, context, Follow the agent, the model, usage and your skills and slash commands are in one menu, so the composer stays small: the input, Write and Preview, the model and Send.'],
				media: { name: 'docs/plus-menu', alt: 'The composer\'s + menu with the mode, files, context, Follow the agent, the model, usage and skills' },
			},
			{
				title: 'Enhance prompt',
				body: ['Write what you want in plain words and press ⌥⌘E. Gemini rewrites it as a precise prompt for you to review, and **Revert** puts your words back.'],
				media: { name: 'showcase-enhance', alt: 'A short request rewritten by Enhance into a precise prompt', clip: true },
			},
			{
				title: 'Steer it while it works',
				body: ['Spot the agent heading the wrong way? Type while it works and press Return: the chat stops between steps, never mid-command, and the agent carries on with your message. ⌘Return queues a message for after the turn instead, and each waiting message can be sent now, edited or removed.'],
				media: { name: 'queue', alt: 'The composer while an agent runs a command, with one message sending after the current step and another queued for after the turn' },
			},
			{
				title: 'Answer with an emoji',
				body: ['Some replies only need a nod. React with 👍 and the agent goes ahead, 👎 and it stops to ask what you meant, ❓ and it explains more simply. ❤️ just says thanks. Any other emoji works too: Gemini says how it read it before it does anything.'],
				media: { name: 'reactions', alt: 'The reaction bar on a reply, with Go ahead, Not what I meant, Explain more simply and Thanks' },
			},
			{
				title: 'Run what it suggests',
				body: ['A shell command in a reply has **Run** beside **Copy**. It runs in the agent\'s own terminal, in its folder, and the block shows how it ended. When it fails, **Send Output to Gemini** hands the exit code and output straight back. Commands that delete work, force-push or write outside the folder ask first.'],
				media: { name: 'run-command', alt: 'A reply\'s shell command with Run beside Copy, and a failed run with its exit code and Send Output to Gemini' },
			},
			{
				title: 'Compact long chats',
				body: ['Type `/compact`, or choose **Compact** in the usage popover. Gemini summarizes the work so far and the chat moves to a session made of that summary and your latest messages, so each turn sends less. It stays compacted when the chat is reopened, and **Undo** goes back to the full session.'],
				media: { name: 'compact-line', alt: 'A chat after /compact, with the Compacted line showing the tokens before and after, View Summary and Undo' },
			},
			{
				title: 'Plan mode',
				body: ['The agent reads the code and writes a plan that ends with **Build This Plan**. Nothing changes until you press it.'],
				media: { name: 'showcase-plan', alt: 'An agent in Plan mode writing a plan that ends with Build This Plan', clip: true },
			},
			{
				title: 'Asks first',
				body: ['Commands, edits outside the agent\'s folder and writes to your team\'s tools show a permission card with exactly what will run. The actions that are hard to take back ask every time.'],
				media: { name: 'showcase-wait', alt: 'An agent asking to run npm test, the test run after Allow once, and its summary', clip: true },
			},
		],
		notes: [
			'**Review My Changes** has an agent read your uncommitted diff and report findings, without changing anything.',
			'Select code and press ⌘I to change it in place, or let Gemini write the commit message.',
			'Replies colour code like the editor and typeset math.',
			'Right-click in any terminal for **Send to Gemini**, or press ⌘I there to ask Gemini for a command.',
		],
		docs: [
			{ href: 'chat.html', label: 'Chat and prompting' },
			{ href: 'review.html', label: 'Review and safety' },
			{ href: 'terminal.html', label: 'Terminal' },
		],
	},
	{
		slug: 'projects',
		name: 'Projects',
		summary: 'A coordinator that splits larger work into threads.',
		headline: ['One chat for the whole job.', 'Threads you can merge.'],
		lead: 'Describe larger work in a project chat. Its coordinator splits it into threads, each an agent on its own branch, passes your follow-ups to the right one, and keeps track of where each stands.',
		hero: { name: 'showcase-projects', alt: 'The coordinator starting two threads, whose cards update as they work', clip: true },
		steps: [
			{ title: 'Describe the work', body: 'The coordinator answers with a plan of threads, or starts them straight away.' },
			{ title: 'Threads work side by side', body: 'Each thread is an agent on a new branch in a worktree of its own, with its card in the project chat updating as it works.' },
			{ title: 'Plan first, when it matters', body: 'A thread can wait for your **Approve plan** before it changes a file.' },
			{ title: 'Merge, review or undo', body: 'A finished card has **Merge back**, **Review changes** and **Undo thread**.' },
		],
		sections: [
			{
				title: 'Thread cards',
				body: ['The project chat shows every thread as a card, and the side panel counts them by state. Open a thread to talk to its agent directly; anything it needs from you stays in that thread.'],
				media: { name: 'project-threads', alt: 'Thread cards in the project chat, with the side panel counting threads by state' },
			},
			{
				title: 'Start a thread yourself',
				body: ['**New thread** takes a title, a brief, a branch, the model and Plan first. The thread starts at once, and the coordinator hears about it afterwards.'],
				media: { name: 'project-new-thread', alt: 'The New thread dialog with a title, a brief, a branch and Plan first' },
			},
			{
				title: 'Merge back',
				body: ['When a thread is done, **Merge back** brings its branch into yours, **Review changes** opens its diff, and **Undo thread** throws its work away.'],
				media: { name: 'project-merge', alt: 'A finished thread card with Merge back, Review changes and Undo thread' },
			},
		],
		notes: [
			'A project can span several repositories: a thread gets a worktree of each one it needs.',
			'Project instructions and context files are read by the coordinator and every thread.',
			'Write to the coordinator while it works: your message goes when its turn ends. A thread shows the coordinator\'s notes the same way.',
			'**Fork Agent** on a thread starts a new thread from its conversation, on a branch of its own.',
			'Projects are on by default. Turn them off with `gemini.projects.enabled`.',
		],
		docs: [
			{ href: 'projects.html', label: 'Projects' },
		],
	},
	{
		slug: 'browser',
		name: 'Browser',
		summary: 'A browser your agents can use, beside the chat.',
		headline: ['A browser your agents use.', 'Point at what to change.'],
		lead: 'GeminiCode has a browser of its own. Agents open your app in it, click, type, take screenshots and read the console. You point at an element, or pin notes on the page, and send them to an agent.',
		hero: { name: 'browser-page', alt: 'A cart page open in GeminiCode\'s browser beside the chat, with Add to Gemini in the toolbar' },
		steps: [
			{ title: 'Open your app', body: 'The globe in the title bar opens the browser, or an agent opens the page itself.' },
			{ title: 'Point at it', body: '**Add to Gemini** puts an element, a screenshot or the console into your prompt.' },
			{ title: 'Leave notes', body: 'Pin a note on each element that should change, and send them as one list.' },
			{ title: 'Let the agent check', body: 'The agent reloads the page, reads the console and failed requests, and checks its own fix.' },
		],
		sections: [
			{
				title: 'Notes on the page',
				body: ['Pin notes on the elements you want changed, as you would on a design review, then send them to the agent as one list.'],
				media: { name: 'showcase-notes', alt: 'Notes pinned on elements of a page and sent to Gemini', clip: true },
			},
			{
				title: 'Console and network',
				body: ['Agents read the page\'s console errors and failed requests, so a bug report can be just "the cart is broken".'],
				media: { name: 'showcase-console', alt: 'An agent reading a page\'s console errors and fixing the code', clip: true },
			},
		],
		notes: [
			'**Let Gemini Use This Page** hands one of your own tabs to an agent.',
			'Sign-ins are kept per workspace, and an administrator can limit the sites agents may open.',
		],
		docs: [
			{ href: 'browser.html', label: 'Browser' },
		],
	},
	{
		slug: 'team-tools',
		name: 'Connected tools',
		summary: 'Jira, GitLab, SonarQube, Snyk and Figma, from ticket to merge.',
		headline: ['From ticket to merge request.', 'Without leaving the editor.'],
		lead: 'Connect Jira, GitLab, SonarQube, Snyk and Figma with your own account. Home shows your tickets and merge requests. Start an agent from a ticket, open its merge request, fix the pipeline and the comments, review a teammate\'s work with Gemini, and merge when GitLab\'s checks pass.',
		hero: { name: 'showcase-mr-review', alt: 'Gemini\'s review of a merge request, a comment of your own with a suggested change, and the review posted', clip: true },
		steps: [
			{ title: 'Connect', body: 'Paste a token per tool in **Connections**. A checked-in `.gemini/geminicode-tools.json` fills in the addresses for your team.' },
			{ title: 'Start from a ticket', body: 'The agent gets its own branch named after the ticket, reads it, plans, and offers to move it to In Progress.' },
			{ title: 'Open and fix the merge request', body: 'Pick the target from a searchable list. Failed jobs, the quality gate and review threads come back to the agent with **Fix**.' },
			{ title: 'Merge', body: '**Merge…** turns on only when GitLab\'s own checks all pass, and GitLab checks again as it merges.' },
		],
		sections: [
			{
				title: 'Home',
				body: ['**Needs you** lists what waits on you across the tools: an agent asking permission, a failed pipeline, a merge request that can merge, a review request. Below it, your tickets by sprint and your merge requests with their pipelines and approvals.'],
				media: { name: 'home', alt: 'Home with the Start Agent composer, Needs you, My tickets and Merge requests' },
			},
			{
				title: 'Review a merge request',
				body: [
					'Gemini reviews a teammate\'s merge request against its ticket and drafts the comments. In the diff you add your own on any line or range, reply to and resolve the merge request\'s threads, and attach suggested changes the author applies with one click.',
					'The draft is saved as you go and reopens from Home. Post it in one go, approve, or request changes.',
				],
				media: { name: 'mr-review-diff', alt: 'A merge request\'s diff with Gemini\'s comments on their lines, a comment of yours with a suggested change, and an open thread' },
			},
			{
				title: 'Comment on a ticket',
				body: ['Write a Jira comment in Markdown, mention people with @, drop in screenshots and choose who can see it. It is posted as you, with Jira\'s own formatting.'],
				media: { name: 'jira-comment', alt: 'A Jira comment with formatting, a mention and an attached screenshot' },
			},
		],
		notes: [
			'Tokens stay in the macOS keychain; agents never see them. Every call runs from your Mac, over your VPN.',
			'Moving a ticket, logging time, opening a merge request and merging ask every time.',
			'Every write to Jira or GitLab, by an agent or by you, is recorded in an audit log on your Mac.',
		],
		docs: [
			{ href: 'team-tools.html', label: 'Team tools' },
			{ href: 'team-tools.html#review-a-merge-request', label: 'Review a merge request' },
			{ href: 'team-tools.html#connect-your-tools', label: 'Connect your tools' },
		],
	},
];

/** The media every feature page uses, by name, for the capture list and the build's checks. */
export function featureMedia(): FeatureMedia[] {
	return featurePages.flatMap(page => [page.hero, ...page.sections.flatMap(section => section.media ? [section.media] : [])]);
}

function escape(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain text with **bold** and `code`. */
export function inlineText(value: string): string {
	return escape(value).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * A screenshot or clip in both themes, the page's theme showing one. `root`
 * leads to the site's root; `available` lists the files in media/.
 */
export function featureFigure(media: FeatureMedia, root: string, available: ReadonlySet<string>, eager = false): string {
	const has = (theme: string, ext: string) => available.has(`${media.name}-${theme}.${ext}`);
	const themes = ['light', 'dark'] as const;
	const frame = themes.map(theme => {
		const poster = `${root}media/${media.name}-${theme}.webp`;
		if (media.clip && has(theme, 'mp4') && has(theme, 'webp')) {
			return `<video class="on-${theme}" src="${root}media/${media.name}-${theme}.mp4" poster="${poster}" controls muted playsinline preload="none" aria-label="${escape(media.alt)}"><track kind="captions" srclang="en" label="No speech" src="${root}media/silent.vtt"></video>`;
		}
		if (has(theme, 'webp')) {
			return `<img class="on-${theme}" src="${poster}" width="2000" height="1250" alt="${escape(media.alt)}"${eager && theme === 'light' ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
		}
		return `<span class="ph on-${theme}"><b>${media.clip ? 'Clip' : 'Screenshot'} still to come</b><span>media/${escape(media.name)}-${theme}.${media.clip ? 'mp4' : 'webp'}, 2000 × 1250</span></span>`;
	}).join('');
	return `<figure class="fshot${media.clip ? ' clip' : ''}"><span class="shot" style="--ar: 2000 / 1250">${frame}</span><figcaption>${escape(media.alt)}</figcaption></figure>`;
}

/** The body of a feature page: hero, steps, sections, good to know, and where to read more. */
export function renderFeature(page: FeaturePage, root: string, available: ReadonlySet<string>, arrow: string): string {
	const index = featurePages.indexOf(page);
	const next = featurePages[(index + 1) % featurePages.length];
	const steps = page.steps.map((step, i) => `
				<li><span class="n">${String(i + 1).padStart(2, '0')}</span><h3>${inlineText(step.title)}</h3><p>${inlineText(step.body)}</p></li>`).join('');
	const sections = page.sections.map((section, i) => `
		<section class="fsec${section.media ? '' : ' plain'}${i % 2 ? ' flip' : ''}" aria-labelledby="${page.slug}-s${i}">
			<div class="ftxt">
				<h2 class="serif" id="${page.slug}-s${i}">${inlineText(section.title)}</h2>
				${section.body.map(p => `<p>${inlineText(p)}</p>`).join('\n\t\t\t\t')}
			</div>${section.media ? `
			${featureFigure(section.media, root, available)}` : ''}
		</section>`).join('');
	return `
	<article class="feature">
		<section class="fhero wrap" aria-labelledby="feature-h">
			<span class="label">${page.preview ? 'Preview · ' : ''}${escape(page.name)}</span>
			<h1 class="serif" id="feature-h">${escape(page.headline[0])}<br><em>${escape(page.headline[1])}</em></h1>
			<p class="flead">${inlineText(page.lead)}</p>
			${featureFigure(page.hero, root, available, true)}
		</section>
		<section class="wrap fsteps" aria-labelledby="${page.slug}-how">
			<h2 class="label" id="${page.slug}-how">How it works</h2>
			<ol>${steps}
			</ol>
		</section>
		<div class="wrap">${sections}
		</div>
		<section class="wrap fnotes" aria-labelledby="${page.slug}-good">
			<div>
				<h2 class="serif" id="${page.slug}-good">Good to know</h2>
				<ul>${page.notes.map(note => `<li>${inlineText(note)}</li>`).join('')}</ul>
			</div>
			<div class="fdocs">
				<span class="label">In the docs</span>
				${page.docs.map(doc => `<a href="${root}docs/${escape(doc.href)}">${escape(doc.label)} ${arrow}</a>`).join('\n\t\t\t\t')}
			</div>
		</section>
		<nav class="wrap fnext" aria-label="Next feature">
			<a href="${next.slug}.html"><small>Next feature</small><b>${escape(next.name)} ${arrow}</b><span>${escape(next.summary)}</span></a>
		</nav>
	</article>`;
}
