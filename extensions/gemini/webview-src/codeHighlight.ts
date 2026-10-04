/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Highlights finished code blocks. The highlighter (webview-src/highlight.ts)
// loads on the first code block, and blocks are highlighted when the view is
// idle, so streaming and typing never wait for it. Results are cached, so a
// block rendered again (a reply finishing, the view reloading) is coloured at
// once.

import type { TokenColors } from '../src/acp/tokenColors';

type Highlighter = { highlight(code: string, language: string): string | undefined };

const url = document.querySelector<HTMLScriptElement>('script[data-highlighter]')?.dataset.highlighter;
let loading: Promise<Highlighter | undefined> | undefined;
const queue: { code: HTMLElement; language: string }[] = [];
let scheduled = false;

/** Highlighted HTML by language and code, newest last. */
const cache = new Map<string, string | undefined>();
const maxCached = 300;

function load(): Promise<Highlighter | undefined> {
	// Loaded on demand on purpose: most replies have no code, and the chat opens faster without it.
	// eslint-disable-next-line no-restricted-syntax
	return loading ??= url ? import(/* webpackIgnore: true */ url).catch(() => undefined) : Promise.resolve(undefined);
}

/** Colours `code` (a `<code>` in a `<pre>`) as `language` soon; at once when it was coloured before. */
export function highlightCode(code: HTMLElement, language: string): void {
	// An empty block is one still streaming in (streamingReply.ts); it is highlighted once it is rendered whole.
	if (!language || !code.textContent) {
		return;
	}
	const cached = cache.get(key(language, code.textContent ?? ''));
	if (cached !== undefined) {
		apply(code, cached);
		return;
	}
	queue.push({ code, language });
	if (!scheduled) {
		scheduled = true;
		void load().then(highlighter => requestIdleCallback(deadline => run(highlighter, deadline)));
	}
}

function run(highlighter: Highlighter | undefined, deadline: IdleDeadline): void {
	while (queue.length && (deadline.timeRemaining() > 2 || deadline.didTimeout)) {
		const { code, language } = queue.shift()!;
		if (!code.isConnected || code.dataset.highlighted) {
			continue;
		}
		const text = code.textContent ?? '';
		const k = key(language, text);
		let html = cache.get(k);
		if (html === undefined && !cache.has(k)) {
			html = highlighter?.highlight(text, language);
			remember(k, html);
		}
		if (html !== undefined) {
			apply(code, html);
		}
	}
	if (queue.length) {
		requestIdleCallback(next => run(highlighter, next), { timeout: 500 });
	} else {
		scheduled = false;
	}
}

function apply(code: HTMLElement, html: string): void {
	// highlight.js escapes the code; its output is only spans with hljs-* classes.
	code.innerHTML = html;
	code.dataset.highlighted = 'true';
}

function key(language: string, text: string): string {
	return `${language}\n${text}`;
}

function remember(k: string, html: string | undefined): void {
	cache.set(k, html);
	if (cache.size > maxCached) {
		cache.delete(cache.keys().next().value!);
	}
}

/** Sets the theme's syntax colours; categories it leaves out keep the chat's own (chat.css). */
export function applyTokenColors(colors: TokenColors): void {
	const style = document.documentElement.style;
	for (let i = style.length - 1; i >= 0; i--) {
		if (style[i].startsWith('--gemini-tok-')) {
			style.removeProperty(style[i]);
		}
	}
	for (const [category, token] of Object.entries(colors)) {
		if (token?.color && /^#[\da-f]{3,8}$/i.test(token.color)) {
			style.setProperty(`--gemini-tok-${category}`, token.color);
		}
		if (token?.italic) {
			style.setProperty(`--gemini-tok-${category}-style`, 'italic');
		}
	}
}
