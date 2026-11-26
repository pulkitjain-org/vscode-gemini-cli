/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// KaTeX, a bundle of its own (media/katex.js and katex.css) that the chat
// loads the first time a reply has math (math.ts).

import katex from 'katex';

/** `tex` as HTML; KaTeX shows what it can't parse in red rather than throwing. */
export function renderTex(tex: string, display: boolean): string {
	// HTML only, about half the elements of HTML with MathML; the source is the accessible label.
	return katex.renderToString(tex, { displayMode: display, output: 'html', throwOnError: false, strict: 'ignore', trust: false, maxExpand: 1000, maxSize: 50 });
}
