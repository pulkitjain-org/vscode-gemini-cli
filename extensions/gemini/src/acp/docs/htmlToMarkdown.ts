/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A documentation page's main content as Markdown: headings, paragraphs,
// lists, code blocks, tables and links, without the site's navigation,
// header, footer, sidebars or scripts. A small tolerant parser rather than a
// library: it runs in the indexer process on pages it fetched, and only
// needs the structure, not a browser's rendering. Nothing in a page runs.

interface Element {
	readonly tag: string;
	readonly attrs: Readonly<Record<string, string>>;
	readonly children: Node[];
	parent: Element | undefined;
}
type Node = Element | string;

export interface ConvertedPage {
	readonly title: string;
	readonly markdown: string;
	/** Links on the page, absolute, without fragments, for crawling. */
	readonly links: readonly string[];
}

const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Content that is never documentation. */
const droppedTags = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'form', 'button', 'select', 'textarea', 'dialog']);
/** Page furniture around the content. */
const chromeTags = new Set(['nav', 'header', 'footer', 'aside']);
const chromeHint = /(?:^|[\s_-])(?:nav|navbar|sidebar|side-bar|menu|breadcrumbs?|footer|header|toc|table-of-contents|cookie|banner|skip-link|edit-page|pagination|feedback)(?:$|[\s_-])/i;
/** Tags that close an open `<p>` or `<li>` when they start, as browsers do. */
const blockTags = new Set(['p', 'div', 'ul', 'ol', 'li', 'table', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'dl', 'dt', 'dd', 'hr']);
const rawTextTags = new Set(['script', 'style', 'textarea', 'title']);

export function htmlToMarkdown(html: string, pageUrl: string): ConvertedPage {
	const root = parse(html);
	const title = text(find(root, e => e.tag === 'title') ?? find(root, e => e.tag === 'h1')).trim().replace(/\s+/g, ' ');
	const links = collectLinks(root, pageUrl);
	const main = find(root, e => e.tag === 'main') ?? find(root, e => e.attrs.role === 'main') ?? find(root, e => e.tag === 'article') ?? find(root, e => e.tag === 'body') ?? root;
	const markdown = new Renderer(pageUrl).block(main).replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
	return { title, markdown, links };
}

function parse(html: string): Element {
	const root: Element = { tag: '#root', attrs: {}, children: [], parent: undefined };
	let current = root;
	const tagPattern = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/?([A-Za-z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
	let at = 0;
	let match: RegExpExecArray | null;
	while ((match = tagPattern.exec(html))) {
		if (match.index > at) {
			current.children.push(decode(html.slice(at, match.index)));
		}
		at = tagPattern.lastIndex;
		const name = match[1]?.toLowerCase();
		if (!name) {
			continue;
		}
		if (match[0][1] === '/') {
			// Close the nearest open element with this name, if any.
			for (let open: Element | undefined = current; open && open !== root; open = open.parent) {
				if (open.tag === name) {
					current = open.parent ?? root;
					break;
				}
			}
			continue;
		}
		if (blockTags.has(name)) {
			for (let open: Element | undefined = current; open && open !== root; open = open.parent) {
				if (open.tag === 'p' || (name === 'li' && open.tag === 'li') || ((name === 'dt' || name === 'dd') && (open.tag === 'dt' || open.tag === 'dd'))) {
					current = open.parent ?? root;
					break;
				}
				if (open.tag !== 'p' && blockTags.has(open.tag) && open.tag !== 'li') {
					break;
				}
			}
		}
		const element: Element = { tag: name, attrs: parseAttrs(match[2] ?? ''), children: [], parent: current };
		current.children.push(element);
		if (rawTextTags.has(name)) {
			const end = html.toLowerCase().indexOf(`</${name}`, at);
			const stop = end < 0 ? html.length : end;
			if (name === 'title' || name === 'textarea') {
				element.children.push(decode(html.slice(at, stop)));
			}
			at = stop;
			tagPattern.lastIndex = stop;
			continue;
		}
		if (!voidTags.has(name) && !match[3]) {
			current = element;
		}
	}
	if (at < html.length) {
		current.children.push(decode(html.slice(at)));
	}
	return root;
}

function parseAttrs(source: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const match of source.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
		attrs[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? '');
	}
	return attrs;
}

const namedEntities: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', laquo: '\u00ab', raquo: '\u00bb', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', times: '\u00d7', rarr: '\u2192', larr: '\u2190', middot: '\u00b7', bull: '\u2022' };

function decode(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
		if (body[0] === '#') {
			const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : entity;
		}
		return namedEntities[body.toLowerCase()] ?? entity;
	});
}

function find(node: Element, predicate: (element: Element) => boolean): Element | undefined {
	for (const child of node.children) {
		if (typeof child !== 'string') {
			if (predicate(child)) {
				return child;
			}
			const found = find(child, predicate);
			if (found) {
				return found;
			}
		}
	}
	return undefined;
}

function text(node: Node | undefined): string {
	if (!node) {
		return '';
	}
	return typeof node === 'string' ? node : node.children.map(text).join('');
}

function isChrome(element: Element): boolean {
	return droppedTags.has(element.tag) || chromeTags.has(element.tag)
		|| element.attrs.hidden !== undefined || element.attrs['aria-hidden'] === 'true'
		|| element.attrs.role === 'navigation' || element.attrs.role === 'banner' || element.attrs.role === 'contentinfo'
		|| chromeHint.test(`${element.attrs.class ?? ''} ${element.attrs.id ?? ''}`) && !/\b(?:content|article|main)\b/i.test(element.attrs.class ?? '');
}

function collectLinks(root: Element, pageUrl: string): string[] {
	const links = new Set<string>();
	const visit = (element: Element) => {
		if (element.tag === 'a' && element.attrs.href) {
			const absolute = absoluteUrl(element.attrs.href, pageUrl);
			if (absolute) {
				links.add(absolute.split('#')[0]);
			}
		}
		for (const child of element.children) {
			if (typeof child !== 'string') {
				visit(child);
			}
		}
	};
	visit(root);
	return [...links];
}

function absoluteUrl(href: string, base: string): string | undefined {
	try {
		const url = new URL(href, base);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
	} catch {
		return undefined;
	}
}

class Renderer {

	constructor(private readonly pageUrl: string) { }

	block(element: Element, listDepth = 0): string {
		let out = '';
		for (const child of element.children) {
			if (typeof child === 'string') {
				out += collapse(child);
				continue;
			}
			if (isChrome(child)) {
				continue;
			}
			out += this.element(child, listDepth);
		}
		return out;
	}

	private element(element: Element, listDepth: number): string {
		const tag = element.tag;
		const heading = /^h([1-6])$/.exec(tag);
		if (heading) {
			const content = this.inline(element).trim();
			return content ? `\n\n${'#'.repeat(Number(heading[1]))} ${content}\n\n` : '';
		}
		switch (tag) {
			case 'p':
			case 'div':
			case 'section':
			case 'article':
			case 'main':
			case 'body':
			case 'figure':
			case 'details':
			case 'summary':
			case 'center':
				return `\n\n${this.block(element, listDepth).trim()}\n\n`;
			case 'br':
				return '\n';
			case 'hr':
				return '\n\n---\n\n';
			case 'pre':
				return this.pre(element);
			case 'blockquote':
				return `\n\n${this.block(element, listDepth).trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
			case 'ul':
			case 'ol':
				return this.list(element, tag === 'ol', listDepth);
			case 'table':
				return this.table(element);
			case 'dl':
				return `\n\n${element.children.filter((c): c is Element => typeof c !== 'string' && (c.tag === 'dt' || c.tag === 'dd')).map(c => c.tag === 'dt' ? `**${this.inline(c).trim()}**` : `: ${this.inline(c).trim()}`).join('\n')}\n\n`;
			case 'img':
				return element.attrs.alt ? element.attrs.alt : '';
			default:
				return this.inlineElement(element);
		}
	}

	private inline(element: Element): string {
		let out = '';
		for (const child of element.children) {
			if (typeof child === 'string') {
				out += collapse(child);
			} else if (!isChrome(child)) {
				out += /^(?:p|div|ul|ol|pre|table|blockquote|h[1-6])$/.test(child.tag) ? ` ${this.element(child, 0).trim()} ` : this.inlineElement(child);
			}
		}
		return out;
	}

	private inlineElement(element: Element): string {
		switch (element.tag) {
			case 'code':
			case 'kbd':
			case 'samp': {
				const code = text(element).replace(/\s+/g, ' ');
				return code ? `\`${code.replace(/`/g, '\\`')}\`` : '';
			}
			case 'strong':
			case 'b': {
				const inner = this.inline(element).trim();
				return inner ? `**${inner}**` : '';
			}
			case 'em':
			case 'i': {
				const inner = this.inline(element).trim();
				return inner ? `_${inner}_` : '';
			}
			case 'a': {
				const inner = this.inline(element).trim();
				const href = element.attrs.href ? absoluteUrl(element.attrs.href, this.pageUrl) : undefined;
				return inner && href && !href.startsWith(`${this.pageUrl.split('#')[0]}#`) ? `[${inner}](${href})` : inner;
			}
			case 'br':
				return '\n';
			case 'img':
				return element.attrs.alt ?? '';
			default:
				return this.inline(element);
		}
	}

	private pre(element: Element): string {
		const code = find(element, e => e.tag === 'code');
		const classes = `${code?.attrs.class ?? ''} ${element.attrs.class ?? ''}`;
		const language = /(?:language|lang)-([\w+#-]+)/.exec(classes)?.[1] ?? element.attrs['data-language'] ?? '';
		const body = text(element).replace(/^\n+|\s+$/g, '');
		return body ? `\n\n\`\`\`${language}\n${body}\n\`\`\`\n\n` : '';
	}

	private list(element: Element, ordered: boolean, depth: number): string {
		const indent = '  '.repeat(depth);
		let index = 1;
		const items: string[] = [];
		for (const child of element.children) {
			if (typeof child === 'string' || child.tag !== 'li' || isChrome(child)) {
				continue;
			}
			const nested: string[] = [];
			const own: Element = { ...child, children: child.children.filter(c => {
				if (typeof c !== 'string' && (c.tag === 'ul' || c.tag === 'ol')) {
					nested.push(this.list(c, c.tag === 'ol', depth + 1).replace(/^\n+|\n+$/g, ''));
					return false;
				}
				return true;
			}) };
			const content = this.block(own, depth + 1).replace(/\s*\n\s*\n\s*/g, ' ').trim();
			items.push(`${indent}${ordered ? `${index++}.` : '-'} ${content}${nested.length ? `\n${nested.join('\n')}` : ''}`);
		}
		return items.length ? `\n\n${items.join('\n')}\n\n` : '';
	}

	private table(element: Element): string {
		const rows: string[][] = [];
		const visit = (node: Element) => {
			for (const child of node.children) {
				if (typeof child === 'string') {
					continue;
				}
				if (child.tag === 'tr') {
					rows.push(child.children.filter((c): c is Element => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th')).map(c => this.inline(c).trim().replace(/\|/g, '\\|').replace(/\s+/g, ' ')));
				} else if (child.tag !== 'table') {
					visit(child);
				}
			}
		};
		visit(element);
		if (!rows.length) {
			return '';
		}
		const width = Math.max(...rows.map(r => r.length));
		const pad = (row: string[]) => `| ${[...row, ...Array(width - row.length).fill('')].join(' | ')} |`;
		return `\n\n${[pad(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(pad)].join('\n')}\n\n`;
	}
}

function collapse(value: string): string {
	return value.replace(/\s+/g, ' ');
}
