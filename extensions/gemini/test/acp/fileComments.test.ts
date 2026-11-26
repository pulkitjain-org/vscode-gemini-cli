/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { fileCommentsMessage, quoteOf, validComments } from '../../src/acp/fileComments';

const words = { intro: 'Revise {0} using my comments.', comments: 'Comments:', onText: 'On "{0}" (line {1})', onLine: 'At line {0}' };
const report = '# Code Review\n\n## Issues\n\n- Hardcoded value (1) provides no dynamic calculation.\n- Lacks input validation.\n';
const at = (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) => ({ startLineNumber, startColumn, endLineNumber, endColumn });

describe('fileCommentsMessage', () => {
	it('lists the comments in the file\'s order, each with the text it is on and its line', () => {
		const message = fileCommentsMessage('review_report.md', report, [
			{ range: at(6, 3, 6, 26), body: 'Say which inputs.' },
			{ range: at(5, 3, 5, 22), body: ' Name the constant. ' },
			{ range: at(3, 1, 3, 1), body: 'Add a severity column.' },
		], words);
		expect(message).toEqual([
			'Revise review_report.md using my comments.',
			'',
			'Comments:',
			'1. At line 3: Add a severity column.',
			'2. On "Hardcoded value (1)" (line 5): Name the constant.',
			'3. On "Lacks input validation." (line 6): Say which inputs.',
		].join('\n'));
	});

	it('sends nothing without comments', () => {
		expect(fileCommentsMessage('a.md', report, [], words)).toBeUndefined();
	});
});

describe('quoteOf', () => {
	it('joins a quote across lines and cuts a long one', () => {
		const long = `${'word '.repeat(30)}end`;
		expect([quoteOf(report, at(5, 3, 6, 8)), quoteOf(long, at(1, 1, 1, long.length + 1)).length, quoteOf(long, at(1, 1, 1, long.length + 1)).endsWith('…')]).toEqual([
			'Hardcoded value (1) provides no dynamic calculation. - Lacks', 80, true,
		]);
	});
});

describe('validComments', () => {
	it('keeps only comments with a body and a whole range', () => {
		expect(validComments([
			{ range: at(1, 1, 1, 5), body: 'ok' },
			{ range: at(0, 1, 1, 5), body: 'line 0' },
			{ range: at(1, 1, 1, 5), body: '   ' },
			{ range: { startLineNumber: 1 }, body: 'partial' },
			'text',
		]).map(comment => comment.body)).toEqual(['ok']);
		expect(validComments('nope')).toEqual([]);
	});
});
