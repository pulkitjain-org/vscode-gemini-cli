/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Finds math in replies, `$...$`, `$$...$$`, `\(...\)` and `\[...\]`, and
// leaves a placeholder with the TeX source, which math.ts formats once KaTeX
// has loaded. KaTeX itself is not called while parsing, so a reply without
// math pays only a character test per text run. The dollar rules follow
// markdown-it-katex: no space just inside the dollars, and no digit right
// after the closing one, so "$5 and $10" and `$HOME` stay text; and none
// across a code span.

import type MarkdownIt from 'markdown-it';

// The parser states, as the rulers type them.
type StateInline = Parameters<Parameters<MarkdownIt['inline']['ruler']['before']>[2]>[0];
type StateBlock = Parameters<Parameters<MarkdownIt['block']['ruler']['after']>[2]>[0];

function isWhitespace(c: string | undefined): boolean {
	return c === ' ' || c === '\t' || c === '\n';
}

function inlineMath(state: StateInline, silent: boolean): boolean {
	const src = state.src;
	const start = state.pos;
	const c = src[start];
	let open: string;
	let close: string;
	if (c === '$') {
		if (src[start + 1] === '$') {
			// Display math inside a paragraph: $$x$$.
			open = '$$';
			close = '$$';
		} else {
			open = '$';
			close = '$';
		}
	} else if (c === '\\' && src[start + 1] === '(') {
		open = '\\(';
		close = '\\)';
	} else {
		return false;
	}
	const from = start + open.length;
	if (open === '$' && (isWhitespace(src[from]) || from >= state.posMax)) {
		return false;
	}
	let end = from;
	for (;;) {
		end = src.indexOf(close, end);
		if (end < 0 || end >= state.posMax) {
			return false;
		}
		// An escaped closing dollar is part of the math.
		if (close === '$' && src[end - 1] === '\\') {
			end++;
			continue;
		}
		break;
	}
	const tex = src.slice(from, end);
	// A backtick means the dollars belong to code spans, as in "$5 and `$HOME`".
	if (!tex.trim() || (open === '$' && (isWhitespace(src[end - 1]) || /\d/.test(src[end + 1] ?? '') || tex.includes('`')))) {
		return false;
	}
	if (!silent) {
		const token = state.push('math_inline', 'span', 0);
		token.content = tex;
		token.markup = open;
	}
	state.pos = end + close.length;
	return true;
}

function blockMath(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
	const lineStart = state.bMarks[startLine] + state.tShift[startLine];
	const first = state.src.slice(lineStart, state.eMarks[startLine]).trim();
	const open = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : undefined;
	if (!open || state.sCount[startLine] - state.blkIndent >= 4) {
		return false;
	}
	const close = open === '$$' ? '$$' : '\\]';
	const lines: string[] = [];
	let line = startLine;
	let rest = first.slice(open.length);
	for (;;) {
		const at = rest.indexOf(close);
		if (at >= 0) {
			lines.push(rest.slice(0, at));
			if (rest.slice(at + close.length).trim()) {
				// Text after the closing marker: not a display block.
				return false;
			}
			break;
		}
		lines.push(rest);
		line++;
		if (line >= endLine) {
			return false;
		}
		rest = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
	}
	const tex = lines.join('\n').trim();
	if (!tex) {
		return false;
	}
	if (!silent) {
		const token = state.push('math_block', 'div', 0);
		token.content = tex;
		token.block = true;
		token.map = [startLine, line + 1];
		token.markup = open;
	}
	state.line = line + 1;
	return true;
}

/** Adds the math rules to `md`. */
export function mathPlugin(md: MarkdownIt): void {
	// Before escapes, which would take `\(` as an escaped bracket.
	md.inline.ruler.before('escape', 'math_inline', inlineMath);
	md.block.ruler.after('blockquote', 'math_block', blockMath, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
	const escape = md.utils.escapeHtml;
	md.renderer.rules.math_inline = (tokens, idx) => `<span class="math" data-tex="${escape(tokens[idx].content)}">${escape(tokens[idx].markup + tokens[idx].content + (tokens[idx].markup === '\\(' ? '\\)' : tokens[idx].markup))}</span>`;
	md.renderer.rules.math_block = (tokens, idx) => `<div class="math math-display" data-tex="${escape(tokens[idx].content)}">${escape(tokens[idx].content)}</div>\n`;
}
