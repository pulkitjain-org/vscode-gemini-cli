/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { AdfNode } from '../../src/acp/confluence';
import { markdownToAdf } from '../../webview-src/commentAdf';
import { blockChanges, type BlockPart } from '../../src/acp/blockMerge';
import { confluenceSafe, holdBlocks, keepAllKeys, keepEdits, lostKinds, markdownCarries, publishBlocks, rewritesHeld, takeRewrite, undecided, undoBlocks } from '../../src/acp/draftReview';

const p = (text: string): AdfNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const macro: AdfNode = { type: 'extension', attrs: { extensionKey: 'toc' } };
const table: AdfNode = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p('Size')] }] }] };
const mention: AdfNode = { type: 'paragraph', content: [{ type: 'mention', attrs: { id: '5b10', text: '@Sam' } }, { type: 'text', text: ' owns it' }] };
const commented: AdfNode = { type: 'paragraph', content: [{ type: 'text', text: 'Shipped', marks: [{ type: 'annotation', attrs: { id: 'c1', annotationType: 'inlineComment' } }] }] };
const name = (node: AdfNode) => node.type === 'paragraph' ? node.content?.map(n => n.text ?? n.type).join('') : node.type;
const keys = (parts: readonly BlockPart[]) => parts.flatMap(part => part.kind === 'change' ? [part.key] : []);

describe('draftReview', () => {
	it('tells what the agent\'s Markdown can write from what it can\'t', () => {
		expect([p('Plain'), { type: 'paragraph', content: [{ type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://a' } }, { type: 'strong' }] }] }, macro, table, mention, commented, { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'textColor', attrs: { color: '#f00' } }] }] }].map(markdownCarries))
			.toEqual([true, true, false, false, false, false, false]);
	});

	it('puts back what the agent\'s Markdown dropped or rewrote, and Keep All keeps it', () => {
		// The page: a macro, an intro, a table, a mention and a commented line. The agent rewrote it all in Markdown.
		const base = [macro, p('Intro'), table, mention, commented, p('End')];
		const draft = [p('Intro, rewritten'), p('Size | M'), p('@Sam owns it'), p('Shipped'), p('End')];
		const held = holdBlocks(base, draft);
		const parts = blockChanges(base, held.content);
		const rewrite = parts.find(part => rewritesHeld(part, held.held))!;
		expect({
			// The page's part as it was, then the agent's version of it.
			draft: held.content.map(name),
			held: held.held,
			keepAll: publishBlocks(parts, new Set(keepAllKeys(parts, held.held))).map(name),
			left: undecided(parts, new Set(), held.held),
			lost: lostKinds(base.slice(0, 5)),
			taken: takeRewrite(parts, held.held, (rewrite as { key: string }).key),
		}).toEqual({
			draft: ['extension', 'Intro', 'table', 'mention owns it', 'Shipped', 'Intro, rewritten', 'Size | M', '@Sam owns it', 'Shipped', 'End'],
			held: [0, 1, 2, 3, 4],
			keepAll: ['extension', 'Intro', 'table', 'mention owns it', 'Shipped', 'End'],
			left: 0,
			lost: ['extension', 'table', 'mention', 'annotation'],
			taken: { content: draft, held: [], from: 0 },
		});
	});

	it('keeps one paragraph with its mention when Keep All meets the agent\'s rewrite of it', () => {
		const bob: AdfNode = { type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }, { type: 'mention', attrs: { id: 'b0b', text: '@Bob' } }] };
		const held = holdBlocks([bob], [p('Hi @Bob, welcome')]);
		const parts = blockChanges([bob], held.content);
		expect(publishBlocks(parts, new Set(keepAllKeys(parts, held.held)))).toEqual([bob]);
	});

	it('makes what Confluence takes from the agent\'s Markdown: no heading in a list, no other marks on code', () => {
		const step: AdfNode = { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Step' }] }] }] };
		const code: AdfNode = { type: 'paragraph', content: [{ type: 'text', text: 'run', marks: [{ type: 'strong' }, { type: 'code' }] }] };
		// As the Review Page makes a draft from `- # Step` (webview-src/commentAdf.ts, through draftMarkdown.js).
		const fromMarkdown = confluenceSafe(markdownToAdf('- # Step').content);
		expect(fromMarkdown).toEqual([step].map(() => ({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step', marks: [{ type: 'strong' }] }] }] }] })));
		expect(confluenceSafe([step, code])).toEqual([
			{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step', marks: [{ type: 'strong' }] }] }] }] },
			{ type: 'paragraph', content: [{ type: 'text', text: 'run', marks: [{ type: 'code' }] }] },
		]);
	});

	it('publishes only the kept changes, and undoes one', () => {
		const base = [p('A'), p('B'), p('C'), p('D')];
		const parts = blockChanges(base, [p('A2'), p('B'), p('C2'), p('D'), p('E')]);
		const [first, second, third] = keys(parts);
		expect({
			left: undecided(parts, new Set([first])),
			published: publishBlocks(parts, new Set([first, third])).map(name),
			undone: undoBlocks(parts, second).map(name),
		}).toEqual({ left: 2, published: ['A2', 'B', 'C', 'D', 'E'], undone: ['A2', 'B', 'C', 'D', 'E'] });
	});

	it('keeps the user\'s own edits, but not one that runs into a change they haven\'t decided on', () => {
		const base = [p('A'), p('B'), p('C'), p('D'), p('E')];
		const before = blockChanges(base, [p('A2'), p('B'), p('C'), p('D'), p('E')]);
		// In Edit, the user rewrote D (far from the undecided change to A) and B (next to it).
		const after = blockChanges(base, [p('A2'), p('B mine'), p('C'), p('D mine'), p('E')]);
		const kept = keepEdits(before, after, new Set());
		expect(after.filter(part => part.kind === 'change').map(part => kept.has((part as { key: string }).key))).toEqual([false, true]);
	});
});
