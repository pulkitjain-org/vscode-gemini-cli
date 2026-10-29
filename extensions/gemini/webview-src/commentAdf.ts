/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A comment written in Home's comment box, as Jira's own rich text
// (Atlassian Document Format). The box takes Markdown, parsed with the same
// markdown-it settings as its Preview (draftMarkdown.ts, whose chunk carries
// this one, so the extension's bundle has no Markdown parser), so what the
// preview shows is what Jira shows: headings, bold, italic, strikethrough,
// code, links, lists, task lists, quotes, GitHub-style callouts (as Jira
// panels), code blocks, tables and rules. People picked with @ become real
// mentions, which Jira notifies. Pure: nothing here calls Jira.

import MarkdownIt, { type Token } from 'markdown-it';
import type { AdfDocument, AdfMark, AdfNode, CommentMention } from '../src/acp/jiraAdf';

/** The panel each GitHub-style callout becomes; Jira's panels have the same five tones. */
const panelTypes: Readonly<Record<string, string>> = { note: 'info', tip: 'success', important: 'note', warning: 'warning', caution: 'error' };

let parser: MarkdownIt | undefined;

/** The Preview's settings (webview-src/draftMarkdown.ts): no raw HTML, bare links linked, single line breaks kept. */
function markdown(): MarkdownIt {
	return parser ??= new MarkdownIt({ html: false, linkify: true, breaks: true });
}

/**
 * `text`, Markdown from the comment box, as an ADF document. `mentions` are
 * the people picked with @, matched in the text by `@` and their name.
 * `newId` makes the ids task lists need.
 */
export function markdownToAdf(text: string, mentions: readonly CommentMention[] = [], newId: () => string = () => crypto.randomUUID()): AdfDocument {
	const tokens = markdown().parse(text.replace(/\r\n/g, '\n'), {});
	return { type: 'doc', version: 1, content: new AdfBuilder(tokens, mentions, newId).blocks(0, tokens.length) };
}

class AdfBuilder {
	/** Longest name first, so "@Ann Lee" wins over "@Ann". */
	private readonly mentions: readonly CommentMention[];

	constructor(private readonly tokens: readonly Token[], mentions: readonly CommentMention[], private readonly newId: () => string) {
		this.mentions = [...mentions].filter(m => m.name.trim() && m.accountId).sort((a, b) => b.name.length - a.name.length);
	}

	/** The block nodes of tokens `from` to `to`. */
	blocks(from: number, to: number): AdfNode[] {
		const nodes: AdfNode[] = [];
		let i = from;
		while (i < to) {
			const token = this.tokens[i];
			const close = token.nesting === 1 ? this.closing(i) : i;
			const node = this.block(i, close);
			if (node) {
				nodes.push(node);
			}
			i = close + 1;
		}
		return nodes;
	}

	/** The index of the token that closes the one opened at `open`. */
	private closing(open: number): number {
		let depth = 0;
		for (let i = open; i < this.tokens.length; i++) {
			depth += this.tokens[i].nesting;
			if (depth === 0) {
				return i;
			}
		}
		return this.tokens.length - 1;
	}

	private block(open: number, close: number): AdfNode | undefined {
		const token = this.tokens[open];
		switch (token.type) {
			case 'paragraph_open':
				return { type: 'paragraph', content: this.inline(this.tokens[open + 1]) };
			case 'heading_open':
				return { type: 'heading', attrs: { level: Number(token.tag.slice(1)) || 1 }, content: this.inline(this.tokens[open + 1]) };
			case 'bullet_list_open':
				return this.taskList(open, close) ?? { type: 'bulletList', content: this.items(open, close) };
			case 'ordered_list_open': {
				const start = Number(token.attrGet('start'));
				return { type: 'orderedList', ...start > 1 ? { attrs: { order: start } } : {}, content: this.items(open, close) };
			}
			case 'blockquote_open':
				return this.quote(open, close);
			case 'fence':
			case 'code_block': {
				const language = token.info.trim().split(/\s+/)[0];
				const code = token.content.replace(/\n$/, '');
				return { type: 'codeBlock', ...language ? { attrs: { language } } : {}, ...code ? { content: [{ type: 'text', text: code }] } : {} };
			}
			case 'hr':
				return { type: 'rule' };
			case 'table_open':
				return this.table(open, close);
			default:
				return undefined;
		}
	}

	/** List items: each holds its paragraphs and nested lists. */
	private items(open: number, close: number): AdfNode[] {
		const items: AdfNode[] = [];
		let i = open + 1;
		while (i < close) {
			const end = this.closing(i);
			const content = this.blocks(i + 1, end);
			// Jira's list items start with a paragraph.
			items.push({ type: 'listItem', content: content[0]?.type === 'paragraph' ? content : [{ type: 'paragraph', content: [] }, ...content] });
			i = end + 1;
		}
		return items;
	}

	/** `- [ ] a` / `- [x] b` as Jira's task list, when every item is a task with only its line (and nested tasks). */
	private taskList(open: number, close: number): AdfNode | undefined {
		const items: AdfNode[] = [];
		let i = open + 1;
		while (i < close) {
			const end = this.closing(i);
			const first = this.tokens[i + 1];
			const inline = first?.type === 'paragraph_open' ? this.tokens[i + 2] : undefined;
			const box = inline && /^\[([ xX])\]\s+/.exec(inline.content);
			if (!inline || !box) {
				return undefined;
			}
			const done = box[1] !== ' ';
			items.push({ type: 'taskItem', attrs: { localId: this.newId(), state: done ? 'DONE' : 'TODO' }, content: this.inline(inline, box[0].length) });
			// What follows the task's line: only a nested task list fits in Jira's.
			for (const nested of this.blocks(this.closing(i + 1) + 1, end)) {
				if (nested.type !== 'taskList') {
					return undefined;
				}
				items.push(nested);
			}
			i = end + 1;
		}
		return { type: 'taskList', attrs: { localId: this.newId() }, content: items };
	}

	/** A quote, or a Jira panel for a `> [!NOTE]` callout. */
	private quote(open: number, close: number): AdfNode {
		const content = this.blocks(open + 1, close);
		const inline = this.tokens[open + 1]?.type === 'paragraph_open' ? this.tokens[open + 2] : undefined;
		const callout = inline && /^\[!(note|tip|important|warning|caution)\][ \t]*(\n|$)/i.exec(inline.content);
		if (callout) {
			// The marker's line goes; the rest of its paragraph stays.
			const rest = this.inline(inline, callout[0].length);
			const body = rest.length ? [{ type: 'paragraph', content: rest }, ...content.slice(1)] : content.slice(1);
			return { type: 'panel', attrs: { panelType: panelTypes[callout[1].toLowerCase()] }, content: body.length ? body : [{ type: 'paragraph', content: [] }] };
		}
		return { type: 'blockquote', content: content.length ? content : [{ type: 'paragraph', content: [] }] };
	}

	private table(open: number, close: number): AdfNode {
		const rows: AdfNode[] = [];
		for (let i = open; i < close; i++) {
			if (this.tokens[i].type !== 'tr_open') {
				continue;
			}
			const end = this.closing(i);
			const cells: AdfNode[] = [];
			for (let j = i + 1; j < end; j++) {
				const cell = this.tokens[j];
				if (cell.type === 'th_open' || cell.type === 'td_open') {
					cells.push({ type: cell.type === 'th_open' ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph', content: this.inline(this.tokens[j + 1]) }] });
				}
			}
			rows.push({ type: 'tableRow', content: cells });
			i = end;
		}
		return { type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' }, content: rows };
	}

	/** An inline token's text nodes, with their marks, line breaks and mentions; `skip` leaves out its first characters (a task's box). */
	private inline(token: Token | undefined, skip = 0): AdfNode[] {
		const nodes: AdfNode[] = [];
		const marks: AdfMark[] = [];
		let skipping = skip;
		for (const child of token?.children ?? []) {
			switch (child.type) {
				case 'text': {
					let text = child.content;
					if (skipping) {
						const cut = Math.min(skipping, text.length);
						text = text.slice(cut);
						skipping -= cut;
					}
					this.text(nodes, text, marks);
					break;
				}
				case 'code_inline':
					// Code takes no other mark but a link.
					pushText(nodes, child.content, [{ type: 'code' }, ...marks.filter(m => m.type === 'link')]);
					break;
				case 'softbreak':
				case 'hardbreak':
					if (skipping) {
						skipping = 0;
					} else {
						nodes.push({ type: 'hardBreak' });
					}
					break;
				case 'strong_open':
					marks.push({ type: 'strong' });
					break;
				case 'em_open':
					marks.push({ type: 'em' });
					break;
				case 's_open':
					marks.push({ type: 'strike' });
					break;
				case 'link_open':
					marks.push({ type: 'link', attrs: { href: child.attrGet('href') ?? '' } });
					break;
				case 'strong_close':
				case 'em_close':
				case 's_close':
				case 'link_close': {
					const type = child.type === 'strong_close' ? 'strong' : child.type === 'em_close' ? 'em' : child.type === 's_close' ? 'strike' : 'link';
					const at = marks.map(m => m.type).lastIndexOf(type);
					if (at >= 0) {
						marks.splice(at, 1);
					}
					break;
				}
				case 'image': {
					// Jira places pictures by its media ids, which its API doesn't give: the picture is linked by its text.
					const src = child.attrGet('src') ?? '';
					pushText(nodes, child.content || src, [...marks.filter(m => m.type !== 'link'), ...src ? [{ type: 'link' as const, attrs: { href: src } }] : []]);
					break;
				}
			}
		}
		return nodes;
	}

	/** Plain text, with `@Name` of each picked person as a mention (not inside a link). */
	private text(nodes: AdfNode[], text: string, marks: readonly AdfMark[]): void {
		if (!this.mentions.length || marks.some(m => m.type === 'link')) {
			pushText(nodes, text, marks);
			return;
		}
		let rest = text;
		while (rest) {
			let found: { at: number; mention: CommentMention } | undefined;
			for (const mention of this.mentions) {
				const at = rest.indexOf(`@${mention.name}`);
				if (at >= 0 && (!found || at < found.at)) {
					found = { at, mention };
				}
			}
			if (!found) {
				pushText(nodes, rest, marks);
				return;
			}
			pushText(nodes, rest.slice(0, found.at), marks);
			nodes.push({ type: 'mention', attrs: { id: found.mention.accountId, text: `@${found.mention.name}` } });
			rest = rest.slice(found.at + found.mention.name.length + 1);
		}
	}
}

/** A text node; Jira refuses empty ones. */
function pushText(nodes: AdfNode[], text: string, marks: readonly AdfMark[]): void {
	if (text) {
		nodes.push({ type: 'text', text, ...marks.length ? { marks: [...marks] } : {} });
	}
}
