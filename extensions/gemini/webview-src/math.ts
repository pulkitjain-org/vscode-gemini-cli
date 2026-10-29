/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Formats the math placeholders mathRule.ts leaves. KaTeX (media/katex.js)
// loads the first time a reply has math and stays loaded; until then, and
// if it can't load, the TeX source shows in a quiet style. Results are
// cached by source, so a reply finishing or the view reloading costs nothing.

import { applyInlineStyles } from './inlineStyles';

type Katex = { renderTex(tex: string, display: boolean): string };

const script = document.querySelector<HTMLScriptElement>('script[data-katex]');
const url = script?.dataset.katex;
const styleUrl = script?.dataset.katexStyle;
let loading: Promise<Katex | undefined> | undefined;

const cache = new Map<string, string>();
const maxCached = 500;

function load(): Promise<Katex | undefined> {
	if (!loading) {
		if (styleUrl) {
			const link = document.createElement('link');
			link.rel = 'stylesheet';
			link.href = styleUrl;
			document.head.append(link);
		}
		// Loaded on demand on purpose: most replies have no math.
		// eslint-disable-next-line no-restricted-syntax
		loading = url ? import(/* webpackIgnore: true */ url).catch(() => undefined) : Promise.resolve(undefined);
	}
	return loading;
}

/** Formats the math in `root` now when it was formatted before, else once KaTeX has loaded. */
export function renderMath(root: ParentNode): void {
	const nodes = [...root.querySelectorAll<HTMLElement>('.math[data-tex]')];
	if (!nodes.length) {
		return;
	}
	const waiting = nodes.filter(node => !apply(node));
	if (waiting.length) {
		void load().then(katex => {
			for (const node of waiting) {
				if (katex) {
					const display = node.classList.contains('math-display');
					const tex = node.dataset.tex ?? '';
					remember(key(tex, display), katex.renderTex(tex, display));
					apply(node);
				}
			}
		});
	}
}

/** Puts the cached formula in `node`; false when there is none yet. */
function apply(node: HTMLElement): boolean {
	const tex = node.dataset.tex ?? '';
	const html = cache.get(key(tex, node.classList.contains('math-display')));
	if (html === undefined) {
		return false;
	}
	// KaTeX escapes the source; with trust off its output is only spans and SVG.
	node.innerHTML = html;
	applyInlineStyles(node);
	node.setAttribute('role', 'math');
	node.setAttribute('aria-label', tex);
	node.removeAttribute('data-tex');
	node.dataset.formatted = 'true';
	return true;
}

function key(tex: string, display: boolean): string {
	return `${display ? 'D' : 'I'}${tex}`;
}

function remember(k: string, html: string): void {
	if (cache.size >= maxCached) {
		cache.delete(cache.keys().next().value!);
	}
	cache.set(k, html);
}
