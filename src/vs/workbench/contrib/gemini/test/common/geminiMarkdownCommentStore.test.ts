/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: tests for common/geminiMarkdownCommentStore.ts.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { GeminiMarkdownCommentStore } from '../../common/geminiMarkdownCommentStore.js';

const report = 'file:///work/shop/review_report.md';
const range = { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 9 };

suite('GeminiMarkdownCommentStore', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('takes comments only on files an agent wrote, keeps them across a reload, and puts back what did not go', () => {
		const store = new GeminiMarkdownCommentStore();
		const before = { accepts: store.accepts(report), added: store.add(report, { id: 'a', range, body: 'too vague' }) };
		store.allow(report, 'agent-1');
		store.add(report, { id: 'a', range, body: 'too vague' });
		store.add(report, { id: 'b', range, body: 'name the file' });
		store.delete(report, 'b');
		const reloaded = new GeminiMarkdownCommentStore(store.serialize());
		const taken = reloaded.take(report);
		reloaded.add(report, { id: 'c', range, body: 'added while sending' });
		const whileSending = reloaded.comments(report).map(comment => comment.id);
		reloaded.restore(report, taken!.comments);
		assert.deepStrictEqual({
			before,
			agent: reloaded.agentOf(report),
			taken: taken!.comments.map(comment => comment.id),
			whileSending,
			after: reloaded.comments(report).map(comment => comment.id),
			commented: reloaded.commented(),
			nothingToTake: new GeminiMarkdownCommentStore().take(report),
		}, {
			before: { accepts: false, added: false },
			agent: 'agent-1',
			taken: ['a'],
			whileSending: ['c'],
			after: ['a', 'c'],
			commented: [report],
			nothingToTake: undefined,
		});
	});

	test('drops what is malformed in saved state, and a comment without a whole range', () => {
		const saved = JSON.stringify({
			[report]: { agent: 'agent-1', comments: [{ id: 'ok', range, body: 'fine' }, { id: 'bad', range: { startLineNumber: 0 }, body: 'x' }, 'text'] },
			'file:///work/no-agent.md': { comments: [] },
		});
		const store = new GeminiMarkdownCommentStore(saved);
		const added = store.add(report, { id: 'partial', range: { ...range, endColumn: 0 }, body: 'x' });
		assert.deepStrictEqual({
			comments: store.comments(report).map(comment => comment.id),
			noAgent: store.accepts('file:///work/no-agent.md'),
			added,
			garbage: new GeminiMarkdownCommentStore('{not json').commented(),
		}, { comments: ['ok'], noAgent: false, added: false, garbage: [] });
	});
});
