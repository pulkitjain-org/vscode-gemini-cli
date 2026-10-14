/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A message's Markdown as the chat shows it: markdown-it with the user
// message settings, GitHub-style callouts and tables that scroll on their
// own. The chat bundles it (markdownExtras.ts adds file links); Agent Home,
// whose startup script is tiny, loads it as media/draftMarkdown.js the first
// time the user is likely to want Preview.

import MarkdownIt from 'markdown-it';

export const calloutIcons: Readonly<Record<string, string>> = {
	note: 'info',
	tip: 'lightbulb',
	important: 'report',
	warning: 'warning',
	caution: 'error',
};

/** Turns `> [!NOTE]` quotes in `root` into callouts titled `label(kind)`. */
export function addCallouts(root: ParentNode, label: (kind: string) => string): void {
	for (const quote of root.querySelectorAll('blockquote')) {
		const first = quote.firstElementChild;
		const text = first?.tagName === 'P' ? first.firstChild : undefined;
		const match = text?.nodeType === Node.TEXT_NODE ? /^\[!(\w+)\][ \t]*\n?/.exec(text.textContent ?? '') : undefined;
		const kind = match?.[1].toLowerCase();
		const iconName = kind ? calloutIcons[kind] : undefined;
		if (!text || !match || !kind || !iconName) {
			continue;
		}
		text.textContent = (text.textContent ?? '').slice(match[0].length);
		// With line breaks kept (a user's message), the marker's line ends in a <br>.
		if (!text.textContent && text.nextSibling?.nodeName === 'BR') {
			text.nextSibling.remove();
		}
		if (!first!.textContent?.trim()) {
			first!.remove();
		}
		quote.classList.add('callout', `callout-${kind}`);
		const title = document.createElement('div');
		title.className = 'callout-title';
		const icon = document.createElement('i');
		icon.className = `codicon codicon-${iconName}`;
		icon.setAttribute('aria-hidden', 'true');
		const name = document.createElement('span');
		name.textContent = label(kind);
		title.append(icon, name);
		quote.prepend(title);
	}
}

/** Puts each table in `root` in a wrapper that scrolls sideways. */
export function wrapTables(root: ParentNode): void {
	for (const table of root.querySelectorAll('table')) {
		const wrap = document.createElement('div');
		wrap.className = 'table-wrap';
		table.replaceWith(wrap);
		wrap.append(table);
	}
}

let draftMarkdown: MarkdownIt | undefined;

/** A draft as it will show once sent, for Agent Home's Preview. */
export function renderDraft(text: string, calloutLabel: (kind: string) => string): Node[] {
	const node = document.createElement('div');
	draftMarkdown ??= new MarkdownIt({ html: false, linkify: true, breaks: true });
	node.innerHTML = draftMarkdown.render(text);
	addCallouts(node, calloutLabel);
	wrapTables(node);
	return [...node.childNodes];
}
