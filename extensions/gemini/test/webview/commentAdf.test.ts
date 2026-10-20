/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { markdownToAdf } from '../../webview-src/commentAdf';

/** Ids in order, so task lists compare. */
function ids(): () => string {
	let next = 0;
	return () => `id-${++next}`;
}

const text = (value: string, ...marks: object[]) => ({ type: 'text', text: value, ...marks.length ? { marks } : {} });
const paragraph = (...content: object[]) => ({ type: 'paragraph', content });

describe('markdownToAdf', () => {
	it('keeps inline formatting, links, line breaks and the people picked with @', () => {
		const doc = markdownToAdf('Hi @Ann Lee and @Ann, see **bold _both_** ~~old~~ `a.ts` [the MR](https://git.example/1)\nand https://jira.example/x', [
			{ accountId: 'a1', name: 'Ann' },
			{ accountId: 'a2', name: 'Ann Lee' },
		]);
		expect(doc).toEqual({
			type: 'doc', version: 1, content: [paragraph(
				text('Hi '),
				{ type: 'mention', attrs: { id: 'a2', text: '@Ann Lee' } },
				text(' and '),
				{ type: 'mention', attrs: { id: 'a1', text: '@Ann' } },
				text(', see '),
				text('bold ', { type: 'strong' }),
				text('both', { type: 'strong' }, { type: 'em' }),
				text(' '),
				text('old', { type: 'strike' }),
				text(' '),
				text('a.ts', { type: 'code' }),
				text(' '),
				text('the MR', { type: 'link', attrs: { href: 'https://git.example/1' } }),
				{ type: 'hardBreak' },
				text('and '),
				text('https://jira.example/x', { type: 'link', attrs: { href: 'https://jira.example/x' } }),
			)],
		});
	});

	it('writes headings, lists, task lists, quotes, callouts as panels, code, rules and tables', () => {
		const markdown = [
			'## Steps',
			'1. Open the cart',
			'   - with two items',
			'2. Pay',
			'',
			'- [ ] Check staging',
			'- [x] Write the test',
			'',
			'> Seen on Safari',
			'',
			'> [!WARNING]',
			'> Only on staging',
			'',
			'```ts',
			'const total = 1;',
			'```',
			'',
			'---',
			'',
			'| Step | Result |',
			'| --- | --- |',
			'| Pay | **fails** |',
		].join('\n');
		expect(markdownToAdf(markdown, [], ids()).content).toEqual([
			{ type: 'heading', attrs: { level: 2 }, content: [text('Steps')] },
			{
				type: 'orderedList', content: [
					{ type: 'listItem', content: [paragraph(text('Open the cart')), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('with two items'))] }] }] },
					{ type: 'listItem', content: [paragraph(text('Pay'))] },
				],
			},
			{
				type: 'taskList', attrs: { localId: 'id-3' }, content: [
					{ type: 'taskItem', attrs: { localId: 'id-1', state: 'TODO' }, content: [text('Check staging')] },
					{ type: 'taskItem', attrs: { localId: 'id-2', state: 'DONE' }, content: [text('Write the test')] },
				],
			},
			{ type: 'blockquote', content: [paragraph(text('Seen on Safari'))] },
			{ type: 'panel', attrs: { panelType: 'warning' }, content: [paragraph(text('Only on staging'))] },
			{ type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const total = 1;')] },
			{ type: 'rule' },
			{
				type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' }, content: [
					{ type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph(text('Step'))] }, { type: 'tableHeader', content: [paragraph(text('Result'))] }] },
					{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(text('Pay'))] }, { type: 'tableCell', content: [paragraph(text('fails', { type: 'strong' }))] }] },
				],
			},
		]);
	});

	it('keeps a list with other content than tasks a plain list', () => {
		expect(markdownToAdf('- [ ] a\n- plain', [], ids()).content).toEqual([
			{ type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('[ ] a'))] }, { type: 'listItem', content: [paragraph(text('plain'))] }] },
		]);
	});
});
