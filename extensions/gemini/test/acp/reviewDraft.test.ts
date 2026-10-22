/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
	commentableRanges, commentBody, DraftComment, editableText, fileLabels, foldFields, inOneHunk, lineInDiff, mergeFindings, moveDraft, parseHunks,
	postItems, relocate, ReviewDraft, shortPath, splitSuggestion, threadPlace, withoutPosted,
} from '../../src/acp/reviewDraft';

// Lines 10 to 14 of the new version: 10 and 11 unchanged, 12 and 13 added, 14 unchanged; old line 12 removed.
const diff = [
	'@@ -10,4 +10,5 @@ export function checkout() {',
	' const a = 1;',
	' const b = 2;',
	'-const c = 3;',
	'+const c = 4;',
	'+const d = 5;',
	' return a;',
	'@@ -40,2 +41,0 @@',
	'-gone();',
	'-gone();',
].join('\n');

describe('review draft', () => {
	it('reads the diff: which new lines take a comment, and their old lines', () => {
		const hunks = parseHunks(diff);
		expect({
			ranges: commentableRanges(hunks),
			added: lineInDiff(hunks, 12),
			unchanged: lineInDiff(hunks, 14),
			outside: lineInDiff(hunks, 30),
			oneHunk: [inOneHunk(hunks, 12, 13), inOneHunk(hunks, 13, 20)],
		}).toEqual({
			ranges: [{ start: 10, end: 14 }],
			added: { added: true },
			unchanged: { added: false, oldLine: 13 },
			outside: undefined,
			oneHunk: [true, false],
		});
	});

	it('keeps the user\'s comments and Gemini\'s edited ones when Gemini reads its review again', () => {
		const draft: ReviewDraft = {
			comments: [
				{ id: 'f1-0', by: 'gemini', kind: 'bug', file: 'a.ts', line: 3, title: 'Old', comment: 'Untouched', checked: true },
				{ id: 'f1-1', by: 'gemini', kind: 'nit', file: 'a.ts', line: 9, title: 'Kept', comment: 'Edited by me', checked: true, edited: true },
				{ id: 'y1', by: 'you', comment: 'Mine', checked: true },
			],
			replies: [{ id: 'g', discussion: 'd1', by: 'gemini', text: 'Old reply', resolve: false, checked: false }],
		};
		const merged = mergeFindings(draft, [
			{ kind: 'nit', file: 'a.ts', line: 9, title: 'Kept', comment: 'Repeats the edited one' },
			{ kind: 'nit', file: 'b.ts', line: 4, endLine: 5, title: 'New', comment: 'Rename it', suggestion: 'const total = 1;' },
			{ kind: 'question', title: 'Reply', comment: 'Agreed with Tom.', discussion: 'd1' },
		], 'f2', (file, line) => `${file}:${line}`);
		expect(merged).toEqual({
			comments: [
				draft.comments[1],
				draft.comments[2],
				{ id: 'f2-1', by: 'gemini', kind: 'nit', file: 'b.ts', line: 4, endLine: 5, title: 'New', comment: 'Rename it', checked: false, suggestion: { text: 'const total = 1;', by: 'gemini', include: true }, anchor: 'b.ts:4' },
			],
			replies: [{ id: 'f2-2', discussion: 'd1', by: 'gemini', text: 'Agreed with Tom.', resolve: false, checked: false }],
		});
	});

	it('takes in what the user typed and ticked on the page', () => {
		const draft: ReviewDraft = {
			comments: [{ id: 'c', by: 'gemini', kind: 'bug', comment: 'Before', checked: true, file: 'a.ts', line: 2, suggestion: { text: 'x', by: 'gemini', include: true } }],
			replies: [{ id: 'r', discussion: 'd', by: 'you', text: '', resolve: false, checked: true }],
		};
		const fields = new Map<string, unknown>([['comment:c', 'After'], ['check:c', false], ['include:c', false], ['reply:r', 'Done in 4f2a'], ['resolve:r', true]]);
		expect(foldFields(draft, name => fields.get(name))).toEqual({
			comments: [{ id: 'c', by: 'gemini', kind: 'bug', comment: 'After', checked: false, file: 'a.ts', line: 2, suggestion: { text: 'x', by: 'gemini', include: false }, edited: true }],
			replies: [{ id: 'r', discussion: 'd', by: 'you', text: 'Done in 4f2a', resolve: true, checked: true }],
		});
	});

	it('writes a suggestion as GitLab\'s block over the comment\'s lines, and reads it back from the editor', () => {
		const comment: DraftComment = { id: 'c', by: 'you', file: 'a.ts', line: 12, endLine: 13, comment: 'Use the constant.', checked: true, suggestion: { text: 'const c = LIMIT;\nconst d = `x`;', by: 'you', include: true } };
		expect(commentBody(comment)).toBe('Use the constant.\n\n```suggestion:-0+1\nconst c = LIMIT;\nconst d = `x`;\n```');
		expect(commentBody({ ...comment, suggestion: { text: 'a ``` b', by: 'you', include: true } })).toBe('Use the constant.\n\n````suggestion:-0+1\na ``` b\n````');
		expect(commentBody({ ...comment, suggestion: { ...comment.suggestion!, include: false } })).toBe('Use the constant.');
		expect(splitSuggestion(editableText(comment))).toEqual({ comment: 'Use the constant.', suggestion: 'const c = LIMIT;\nconst d = `x`;' });
		expect(splitSuggestion('Just a comment.')).toEqual({ comment: 'Just a comment.' });
	});

	it('shortens long paths and tells files with the same name apart', () => {
		expect(shortPath('cms-vca-ui/apps/i18n/fea/myaccount/en.xml')).toBe('…/fea/myaccount/en.xml');
		expect(shortPath('src/a.ts')).toBe('src/a.ts');
		const labels = fileLabels(['ui/fea/myaccount/.content.xml', 'ui/components/myaccount/.content.xml', 'ui/myaccount-title-revamp/.content.xml', 'ui/en.xml']);
		expect([...labels.values()]).toEqual([
			{ dir: 'fea/myaccount/', name: '.content.xml' },
			{ dir: 'components/myaccount/', name: '.content.xml' },
			{ dir: 'myaccount-title-revamp/', name: '.content.xml' },
			{ dir: '', name: 'en.xml' },
		]);
	});

	it('follows a comment\'s line to a newer commit, and flags it when the line changed', () => {
		const lines = ['import x;', '', 'const a = 1;', 'const b = 2;'];
		expect([relocate(1, 'const a = 1;', lines), relocate(3, 'const a = 1;', lines), relocate(2, 'const z = 9;', lines)]).toEqual([
			{ line: 3, changed: false },
			{ line: 3, changed: false },
			{ line: 2, changed: true },
		]);
		const draft: ReviewDraft = {
			comments: [
				{ id: 'moved', by: 'you', file: 'a.ts', line: 1, endLine: 2, anchor: 'const a = 1;', comment: 'x', checked: true },
				{ id: 'changed', by: 'you', file: 'a.ts', line: 4, anchor: 'const b = 3;', comment: 'y', checked: true },
			],
			replies: [],
		};
		expect(moveDraft(draft, () => lines).comments).toEqual([
			{ id: 'moved', by: 'you', file: 'a.ts', line: 3, endLine: 4, anchor: 'const a = 1;', comment: 'x', checked: true },
			{ id: 'changed', by: 'you', file: 'a.ts', line: 4, anchor: 'const b = 3;', comment: 'y', checked: false, lineChanged: true },
		]);
	});

	it('posts ticked comments on their lines, then replies, and drops what was posted', () => {
		const hunks = parseHunks(diff);
		const draft: ReviewDraft = {
			comments: [
				{ id: 'added', by: 'you', file: 'a.ts', line: 12, comment: 'On an added line', checked: true },
				{ id: 'context', by: 'gemini', file: 'a.ts', line: 14, comment: 'On an unchanged line', checked: true },
				{ id: 'outside', by: 'you', file: 'a.ts', line: 30, comment: 'Not in the diff', checked: true },
				{ id: 'general', by: 'you', comment: 'Overall fine', checked: true },
				{ id: 'unticked', by: 'gemini', comment: 'Nit', checked: false },
			],
			replies: [
				{ id: 'r1', discussion: 'd1', by: 'you', text: 'Fixed', resolve: true, checked: true },
				{ id: 'r2', discussion: 'd2', by: 'you', text: '', resolve: true, checked: true },
				{ id: 'r3', discussion: 'd3', by: 'gemini', text: 'Maybe', resolve: false, checked: false },
			],
		};
		const items = postItems(draft, file => file === 'a.ts' ? hunks : undefined);
		expect(items).toEqual([
			{ kind: 'comment', id: 'added', file: 'a.ts', line: 12, text: 'On an added line' },
			{ kind: 'comment', id: 'context', file: 'a.ts', line: 14, oldLine: 13, text: 'On an unchanged line' },
			{ kind: 'comment', id: 'outside', text: '**a.ts:30**\n\nNot in the diff' },
			{ kind: 'comment', id: 'general', text: 'Overall fine' },
			{ kind: 'reply', id: 'r1', discussion: 'd1', text: 'Fixed', resolve: true },
			{ kind: 'resolve', id: 'r2', discussion: 'd2' },
		]);
		expect(withoutPosted(draft, new Set(['added', 'context', 'r1']))).toEqual({ comments: draft.comments.slice(2), replies: draft.replies.slice(1) });
	});

	it('places a thread on its line only when it was written on the shown version', () => {
		expect([
			threadPlace({ path: 'a.ts', line: 12, headSha: 'abc' }, 'abc'),
			threadPlace({ path: 'a.ts', line: 12, headSha: 'old' }, 'abc'),
			threadPlace({ path: 'a.ts', oldLine: 12, headSha: 'abc' }, 'abc'),
			threadPlace({}, 'abc'),
		]).toEqual([
			{ file: 'a.ts', line: 12 },
			{ file: 'a.ts', line: 12, outdated: true },
			{ file: 'a.ts', removedLine: true },
			{},
		]);
	});
});
