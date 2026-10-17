/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { ToolCallDetail, TranscriptItem } from '../../src/acp/chatTranscript';
import { foldGroups, runId, runPeek, thoughtSummary, turnLayout, turnOf, turnStarts, workSummary } from '../../webview-src/workFold';

type ToolCall = Extract<TranscriptItem, { kind: 'toolCall' }>;

let next = 0;

function call(toolKind: string | undefined, title: string, options: { status?: ToolCall['status']; paths?: string[]; details?: ToolCallDetail[] } = {}): ToolCall {
	return {
		id: `t${next++}`, kind: 'toolCall', title, toolKind, status: options.status ?? 'completed',
		locations: (options.paths ?? []).map(path => ({ path })), details: options.details ?? [],
	};
}

function text(kind: 'user' | 'agent' | 'thought', value: string): TranscriptItem {
	return { id: `x${next++}`, kind, text: value };
}

const ids = (items: readonly TranscriptItem[]) => items.map(item => item.id);

describe('turnLayout', () => {
	it('folds the steps and what was said between them, and keeps the answer after the fold', () => {
		const thought = text('thought', '**Looking**');
		const search = call('search', '\'cart-empty\'');
		const remark = text('agent', 'The button uses the outline variant.');
		const edit = call('edit', 'Edit empty.tsx');
		const answer = text('agent', 'Done.');
		const end: TranscriptItem = { id: 'end', kind: 'turnEnd', durationMs: 1000 };
		const layout = turnLayout([thought, search, remark, edit, answer, end]);
		expect(ids(layout.folded)).toEqual(ids([thought, search, remark, edit]));
		expect(ids(layout.after)).toEqual(ids([answer, end]));
	});

	it('keeps a waiting question, the plan and notices out of the fold, and folds answered questions', () => {
		const asked: TranscriptItem = { id: 'p1', kind: 'permission', title: 'Run npm test?', options: [], diffPaths: [] };
		const answered: TranscriptItem = { ...asked, id: 'p0', answer: { kind: 'selected', name: 'Allow' } };
		const plan: TranscriptItem = { id: 'plan', kind: 'plan', entries: [] };
		const notice: TranscriptItem = { id: 'n', kind: 'notice', text: 'Quota used up', severity: 'error' };
		const before = call('read', 'Read a.ts');
		const after = call('execute', 'npm test');
		const layout = turnLayout([plan, before, answered, after, asked, notice]);
		expect(ids(layout.folded)).toEqual(ids([before, answered, after]));
		expect(ids(layout.after)).toEqual(ids([plan, asked, notice]));
	});

	it('folds nothing in a turn with no steps', () => {
		const answer = text('agent', 'Hello.');
		expect(turnLayout([answer])).toEqual({ folded: [], after: [answer] });
	});

	it('moves a remark into the fold once a step follows it', () => {
		const remark = text('agent', 'I\'ll look.');
		expect(ids(turnLayout([remark]).after)).toEqual(ids([remark]));
		expect(ids(turnLayout([remark, call('read', 'Read a.ts')]).folded)).toEqual([remark.id, expect.any(String)]);
	});
});

describe('foldGroups', () => {
	it('makes a run of two or more calls of one kind in a row', () => {
		const searches = [call('search', 'a'), call('search', 'b'), call('search', 'c')];
		const read = call('read', 'Read x.ts');
		const thought = text('thought', 'hmm');
		const commands = [call('execute', 'ls'), call('execute', 'cat x')];
		const groups = foldGroups([...searches, read, thought, ...commands]);
		expect(groups.map(group => group.kind === 'run' ? `${group.step}:${group.calls.length}` : group.item.id)).toEqual(['search:3', read.id, thought.id, 'execute:2']);
	});

	it('keeps a failed call and a subagent on their own, so they stay in sight', () => {
		const failed = call('execute', 'npm test', { status: 'failed' });
		const subagent = call('think', 'Delegating to agent \'codebase_investigator\'');
		const groups = foldGroups([call('execute', 'ls'), failed, call('execute', 'ls'), subagent, call('think', 'x'), call('think', 'y')]);
		expect(groups.map(group => group.kind)).toEqual(['item', 'item', 'item', 'item', 'run']);
		expect(groups[1]).toEqual({ kind: 'item', item: failed });
	});

	it('names a run by its first call, so the id holds as the run grows', () => {
		const first = call('read', 'Read a.ts');
		const [two] = foldGroups([first, call('read', 'Read b.ts')]);
		const [three] = foldGroups([first, call('read', 'Read b.ts'), call('read', 'Read c.ts')]);
		expect(two.kind === 'run' && three.kind === 'run' && runId(two) === runId(three)).toBe(true);
	});
});

describe('workSummary', () => {
	it('counts files read and edited, and other steps by call', () => {
		const summary = workSummary([
			call('read', 'Read a.ts', { paths: ['/w/a.ts'] }),
			call('read', 'Read a.ts', { paths: ['/w/a.ts'] }),
			call('read', 'ReadManyFiles', { paths: ['/w/b.ts', '/w/c.ts'] }),
			call('search', 'x'),
			call('execute', 'ls'),
			call('execute', 'cat a.ts'),
			call('edit', 'Edit a.ts', { details: [{ type: 'diff', path: '/w/a.ts', added: 2, removed: 1 }] }),
			call('edit', 'Edit a.ts', { details: [{ type: 'diff', path: '/w/a.ts', added: 3, removed: 0 }] }),
			call('fetch', 'https://example.com'),
			call(undefined, 'mystery'),
			text('thought', 'not a step that counts'),
		]);
		expect(summary.counts).toEqual({ read: 3, search: 1, execute: 2, edit: 1, fetch: 1, other: 1 });
		expect(summary.changes).toEqual([{ path: '/w/a.ts', added: 5, removed: 1, itemId: expect.any(String) }]);
	});

	it('opens the last edit of a file from its chip', () => {
		const last = call('edit', 'Edit a.ts', { details: [{ type: 'diff', path: '/w/a.ts', added: 1, removed: 0 }] });
		const summary = workSummary([call('edit', 'Edit a.ts', { details: [{ type: 'diff', path: '/w/a.ts', added: 1, removed: 0 }] }), last]);
		expect(summary.changes[0].itemId).toBe(last.id);
	});

	it('lists failures, and which ones the same call got through later', () => {
		const flaky = call('execute', 'npm test', { status: 'failed' });
		const broken = call('execute', 'npm run lint', { status: 'failed' });
		const summary = workSummary([flaky, broken, call('execute', 'npm test')]);
		expect(summary.failed).toEqual([flaky, broken]);
		expect([...summary.recovered]).toEqual([flaky.id]);
	});
});

describe('runPeek', () => {
	it('names files, patterns and commands, once each', () => {
		expect(runPeek([call('read', 'Read a.ts', { paths: ['/w/src/a.ts'] }), call('read', 'Read b.ts', { paths: ['/w/b.ts'] }), call('read', 'Read a.ts', { paths: ['/w/src/a.ts'] })])).toEqual(['a.ts', 'b.ts']);
		expect(runPeek([call('search', '\'cart-empty\' in *.tsx'), call('search', 'apps/**/*Cart*')])).toEqual(['\'cart-empty\' in *.tsx', 'apps/**/*Cart*']);
		expect(runPeek([call('execute', 'grep -r x src'), call('execute', 'ls -la'), call('execute', 'grep y')])).toEqual(['grep', 'ls']);
	});

	it('stops at the limit', () => {
		expect(runPeek([call('execute', 'a'), call('execute', 'b'), call('execute', 'c')], 2)).toEqual(['a', 'b']);
	});
});

describe('thoughtSummary', () => {
	it('takes the first bold heading, as Gemini writes them, else the first line', () => {
		expect(thoughtSummary('**Finding the button**\nIt has a test id.\n\n**Checking colours**\n')).toBe('Finding the button');
		expect(thoughtSummary('\nLook for the test id first.\nThen the label.')).toBe('Look for the test id first.');
		expect(thoughtSummary('')).toBe('');
	});
});

describe('turnStarts and turnOf', () => {
	it('finds the prompt whose turn an item is in', () => {
		const items = [text('agent', 'notice before any prompt'), text('user', 'one'), text('agent', 'a'), text('user', 'two'), text('agent', 'b'), text('agent', 'c')];
		const starts = turnStarts(items);
		expect(starts).toEqual([1, 3]);
		expect([0, 1, 2, 3, 4, 5].map(index => turnOf(starts, index))).toEqual([-1, 1, 1, 3, 3, 3]);
		expect(turnOf([], 4)).toBe(-1);
	});
});
