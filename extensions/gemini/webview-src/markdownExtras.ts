/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the chat adds to rendered Markdown: GitHub-style callouts
// (> [!NOTE]), tables that scroll on their own, and file names in `code` that
// open the file.

import { fileReference } from './chatLogic';
import { el, icon } from './dom';
import { strings, vscode } from './view';

const callouts: Record<string, { icon: string; label: () => string }> = {
	note: { icon: 'info', label: () => strings.calloutNote },
	tip: { icon: 'lightbulb', label: () => strings.calloutTip },
	important: { icon: 'report', label: () => strings.calloutImportant },
	warning: { icon: 'warning', label: () => strings.calloutWarning },
	caution: { icon: 'error', label: () => strings.calloutCaution },
};

/** Adds callouts, table wrappers and file links to rendered Markdown in `root`. */
export function enhanceMarkdown(root: HTMLElement): void {
	for (const quote of root.querySelectorAll('blockquote')) {
		toCallout(quote);
	}
	for (const table of root.querySelectorAll('table')) {
		const wrap = el('div', 'table-wrap');
		table.replaceWith(wrap);
		wrap.append(table);
	}
	for (const code of root.querySelectorAll('code')) {
		if (!code.closest('pre')) {
			toFileLink(code);
		}
	}
}

function toCallout(quote: HTMLQuoteElement): void {
	const first = quote.firstElementChild;
	const text = first?.tagName === 'P' ? first.firstChild : undefined;
	const match = text?.nodeType === Node.TEXT_NODE ? /^\[!(\w+)\][ \t]*\n?/.exec(text.textContent ?? '') : undefined;
	const kind = match?.[1].toLowerCase();
	const callout = kind ? callouts[kind] : undefined;
	if (!text || !match || !kind || !callout) {
		return;
	}
	text.textContent = (text.textContent ?? '').slice(match[0].length);
	if (!first!.textContent?.trim()) {
		first!.remove();
	}
	quote.classList.add('callout', `callout-${kind}`);
	const title = el('div', 'callout-title');
	title.append(icon(callout.icon), el('span', undefined, callout.label()));
	quote.prepend(title);
}

function toFileLink(code: HTMLElement): void {
	const reference = fileReference(code.textContent ?? '');
	if (!reference) {
		return;
	}
	code.classList.add('file-link');
	code.tabIndex = 0;
	code.setAttribute('role', 'link');
	code.title = strings.openFile;
	const open = () => vscode.postMessage({ type: 'openPath', path: reference.path, ...(reference.line ? { line: reference.line } : {}) });
	code.addEventListener('click', open);
	code.addEventListener('keydown', e => {
		if (e.key === 'Enter') {
			e.preventDefault();
			open();
		}
	});
}
