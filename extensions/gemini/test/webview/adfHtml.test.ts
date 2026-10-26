/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// The Review Page's editor: a Confluence page as editable HTML and back,
// keeping what the editor can't change exactly as it came.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLElement } from 'happy-dom';
import type { AdfDocument } from '../../src/acp/confluence';
import { page, startScript } from './pages';

const { document } = page;
let adfToHtml: (doc: AdfDocument, into: HTMLElement, view?: { labels?: Record<string, string> }) => void;
let htmlToAdf: (root: HTMLElement, skipped?: (element: HTMLElement, at: number) => void) => AdfDocument;

beforeAll(async () => {
	// The module is written against the DOM's types: it runs here under happy-dom, and is type-checked with the webviews.
	const module = await startScript('adfHtml');
	adfToHtml = module.adfToHtml as typeof adfToHtml;
	htmlToAdf = module.htmlToAdf as typeof htmlToAdf;
});

function roundTrip(doc: AdfDocument): { html: string; back: AdfDocument } {
	const root = document.createElement('div');
	adfToHtml(doc, root);
	return { html: root.innerHTML, back: htmlToAdf(root) };
}

describe('adfHtml', () => {
	it('round-trips text, marks, headings, lists, code and tables', () => {
		const doc: AdfDocument = {
			type: 'doc', version: 1, content: [
				{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Breakpoints' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'Built for ' }, { type: 'text', text: 'ACME-412', marks: [{ type: 'link', attrs: { href: 'https://acme.atlassian.net/browse/ACME-412' } }] }, { type: 'text', text: ', ' }, { type: 'text', text: 'all', marks: [{ type: 'strong' }] }, { type: 'text', text: ' sizes.' }] },
				{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'XS and S' }] }] }] },
				{ type: 'codeBlock', attrs: { language: 'css' }, content: [{ type: 'text', text: '@media (min-width: 992px) {}' }] },
				{ type: 'table', attrs: { layout: 'default' }, content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Size' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'M' }] }] }] }] },
				{ type: 'rule' },
			],
		};
		expect(roundTrip(doc).back).toEqual(doc);
	});

	it('keeps a macro and a mention as they came, read-only', () => {
		const macro = { type: 'extension', attrs: { extensionKey: 'toc', extensionType: 'com.atlassian.confluence.macro.core', parameters: { macroParams: {} } } };
		const mention = { type: 'mention', attrs: { id: '5b10', text: '@Sam Lee' } };
		const doc: AdfDocument = { type: 'doc', version: 1, content: [macro, { type: 'paragraph', content: [mention, { type: 'text', text: ': does it loop?' }] }] };
		const { html, back } = roundTrip(doc);
		expect([back, html.includes('contenteditable="false"')]).toEqual([doc, true]);
	});

	it('reads what the browser makes while typing: loose text, divs and bold spans', () => {
		const root = document.createElement('div');
		root.innerHTML = 'Loose<div>A <b>bold</b> line</div><p><br></p>';
		expect(htmlToAdf(root).content).toEqual([
			{ type: 'paragraph', content: [{ type: 'text', text: 'Loose' }] },
			{ type: 'paragraph', content: [{ type: 'text', text: 'A ' }, { type: 'text', text: 'bold', marks: [{ type: 'strong' }] }, { type: 'text', text: ' line' }] },
			{ type: 'paragraph' },
		]);
	});

	it('keeps the marks and attributes it has no control for, on blocks it rebuilds', () => {
		const doc: AdfDocument = {
			type: 'doc', version: 1, content: [
				{
					type: 'paragraph', attrs: { localId: 'p1' }, content: [
						{ type: 'text', text: 'commented', marks: [{ type: 'annotation', attrs: { id: 'c1', annotationType: 'inlineComment' } }] },
						{ type: 'text', text: 'red', marks: [{ type: 'textColor', attrs: { color: '#ff5630' } }] },
						{ type: 'text', text: '2', marks: [{ type: 'subsup', attrs: { type: 'sup' } }] },
						{ type: 'text', text: 'lit', marks: [{ type: 'backgroundColor', attrs: { color: '#fedec8' } }, { type: 'strong' }] },
						{ type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://acme.example/docs', title: 'Docs', __confluenceMetadata: { linkType: 'page' } } }] },
					],
				},
				{ type: 'paragraph', marks: [{ type: 'alignment', attrs: { align: 'center' } }], content: [{ type: 'text', text: 'Centered' }] },
				{ type: 'heading', attrs: { level: 2, localId: 'h1' }, marks: [{ type: 'indentation', attrs: { level: 1 } }], content: [{ type: 'text', text: 'Indented' }] },
				{ type: 'codeBlock', attrs: { language: 'ts' }, marks: [{ type: 'breakout', attrs: { mode: 'wide' } }], content: [{ type: 'text', text: 'let a;' }] },
				{ type: 'bulletList', attrs: { localId: 'l1' }, content: [{ type: 'listItem', attrs: { localId: 'i1' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item' }] }] }] },
			],
		};
		const root = document.createElement('div');
		adfToHtml(doc, root);
		// Every block touched, so each is rebuilt from its HTML rather than given back as it came.
		root.querySelectorAll('p, h2, pre, li').forEach(block => block.setAttribute('data-touched', ''));
		expect(htmlToAdf(root)).toEqual(doc);
	});

	it('gives back an untouched block as it came, and a copied id once', () => {
		const original = { type: 'paragraph', attrs: { localId: 'p1' }, content: [{ type: 'text', text: 'One' }] };
		const root = document.createElement('div');
		adfToHtml({ type: 'doc', version: 1, content: [original] }, root);
		const first = htmlToAdf(root).content[0];
		// Enter at the end of the line: the browser copies the paragraph, attributes and all.
		const copy = root.firstElementChild!.cloneNode(false) as HTMLElement;
		copy.textContent = 'Two';
		root.append(copy);
		expect([first === original, htmlToAdf(root).content]).toEqual([true, [original, { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] }]]);
	});

	it('makes what Confluence takes: no heading in a list, no other marks on code', () => {
		const root = document.createElement('div');
		root.innerHTML = '<ul><li><h2>Step</h2></li></ul><p><strong><code>run</code></strong> <a href="https://a.example"><em><code>x</code></em></a></p>';
		expect(htmlToAdf(root).content).toEqual([
			{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step', marks: [{ type: 'strong' }] }] }] }] },
			{ type: 'paragraph', content: [{ type: 'text', text: 'run', marks: [{ type: 'code' }] }, { type: 'text', text: ' ' }, { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'https://a.example' } }, { type: 'code' }] }] },
		]);
	});

	it('says where a part that isn\'t the page\'s stands, by block', () => {
		const root = document.createElement('div');
		root.innerHTML = '<p>A</p>loose<section data-skip="" data-conflict="0">box</section><p>B</p>';
		const at: number[] = [];
		const content = htmlToAdf(root, (_, index) => at.push(index)).content;
		expect([content.length, at]).toEqual([3, [2]]);
	});

	it('takes from a pasted element only marks, attributes and parts of the shape they should have', () => {
		const root = document.createElement('div');
		const mark = (value: unknown) => `data-adf-mark='${JSON.stringify(value)}'`;
		root.innerHTML = [
			`<p data-adf-attrs='${JSON.stringify({ localId: 'p9', content: [{ type: 'extension' }] })}'><span ${mark({ type: 'annotation', attrs: { id: 'c1' } })}>kept</span><span ${mark({ type: 'textColor', attrs: { color: { content: [] } } })}>plain</span></p>`,
			`<p><span data-adf='${JSON.stringify({ type: 'mention', attrs: { id: 'a1' }, script: 'x' })}'>@A</span><span data-adf='${JSON.stringify({ type: 'status', content: ['no'] })}'>S</span></p>`,
		].join('');
		expect(htmlToAdf(root).content).toEqual([
			{ type: 'paragraph', content: [{ type: 'text', text: 'kept', marks: [{ type: 'annotation', attrs: { id: 'c1' } }] }, { type: 'text', text: 'plain' }] },
			{ type: 'paragraph' },
		]);
	});

	it('names what it can\'t show with the page\'s own words', () => {
		const root = document.createElement('div');
		adfToHtml({ type: 'doc', version: 1, content: [{ type: 'mediaSingle' }, { type: 'extension', attrs: {} }, { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'a1' } }] }, { type: 'layoutSection' }] }, root, { labels: { someone: '@quelqu\'un', link: 'Lien', date: 'Date', macro: 'Macro', media: 'Image ou fichier', other: 'Contenu Confluence' } });
		expect(Array.from(root.querySelectorAll('.adf-opaque')).map(node => node.textContent)).toEqual(['Image ou fichier', 'Macro', '@quelqu\'un', 'Contenu Confluence']);
	});

	it('drops the id of a pasted copy that comes before its original', () => {
		const original = { type: 'paragraph', attrs: { localId: 'p1' }, content: [{ type: 'text', text: 'One' }] };
		const root = document.createElement('div');
		adfToHtml({ type: 'doc', version: 1, content: [original] }, root);
		const copy = root.firstElementChild!.cloneNode(false) as HTMLElement;
		copy.textContent = 'Copy';
		root.prepend(copy);
		expect(htmlToAdf(root).content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'Copy' }] }, original]);
	});
});
