/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The rich editor parses any `$...$` pair as inline math, so prose about prices,
// "takes $5 off, never below $0", rendered as a garbled KaTeX formula. This
// follows pandoc's rule for dollar math: content that starts or ends with a
// space is not math. Such a node is drawn as its source text, dollars included,
// and maps back to the source character for character, so the caret and
// comments land where they would in plain text. Real inline math, `$x^2$`, and
// `$$...$$` blocks keep their KaTeX rendering.

import type { MathRendering, MathRenderRequest } from '@vscode/markdown-editor';
import { isDollarProse } from './geminiDollarProse';

/** For the editor's `renderMath`: dollar prose as plain text; undefined keeps the default rendering. */
export function renderDollarProse(request: MathRenderRequest): MathRendering | undefined {
	if (!isDollarProse(request.latex, request.displayMode)) {
		return undefined;
	}
	const dom = document.createElement('span');
	dom.className = request.className;
	const text = document.createTextNode(`$${request.latex}$`);
	dom.appendChild(text);
	return { dom, segments: text.length === request.nodeLength ? [{ dom: text, start: 0, length: request.nodeLength }] : [] };
}
