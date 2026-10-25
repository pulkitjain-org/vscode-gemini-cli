/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../../src/acp/chatTranscript';
import { buildModeAfterPlan, checkpointsFit, diffsOf, dropOldest, lastPromptAt, laterRepeats, rewindPrompts, runningStep, forkedItems, forkNote, forkPointAfter, shouldSuggestCompact, turnShape, undoNote, wasCutOff } from '../../src/acp/chatTurns';

const user = (id: string, text: string, at?: number): TranscriptItem => ({ id, kind: 'user', text, ...(at ? { at } : {}) });
const agent = (id: string, text: string): TranscriptItem => ({ id, kind: 'agent', text });
const tool = (id: string, title: string, status: 'pending' | 'in_progress' | 'completed' | 'failed', parts = 0): TranscriptItem => ({
	id, kind: 'toolCall', title, toolKind: 'read', status, locations: [], details: Array.from({ length: parts }, () => ({ type: 'text' as const, text: 'x' })),
});
const turnEnd = (id: string): TranscriptItem => ({ id, kind: 'turnEnd', durationMs: 1000 });
const notice = (id: string, severity: 'info' | 'error'): TranscriptItem => ({ id, kind: 'notice', text: 'n', severity });

describe('wasCutOff', () => {
	it('is true only when the last prompt has no turn end, cut-off card or error after it', () => {
		expect([
			wasCutOff([]),
			wasCutOff([user('u', 'hi')]),
			wasCutOff([user('u', 'hi'), agent('a', 'hello'), tool('t', 'read', 'completed')]),
			wasCutOff([user('u', 'hi'), agent('a', 'hello'), turnEnd('e')]),
			wasCutOff([user('u', 'hi'), notice('n', 'info')]),
			wasCutOff([user('u', 'hi'), notice('n', 'error')]),
			wasCutOff([user('u', 'hi'), { id: 'c', kind: 'cutOff', prompt: 'hi' }]),
		]).toEqual([false, true, true, false, true, false, false]);
	});
});

describe('turn readings', () => {
	it('finds the latest prompt time and the tool call the turn is on', () => {
		expect({
			at: lastPromptAt([user('u1', 'one', 100), turnEnd('e'), user('u2', 'two', 200), agent('a', 'x')]),
			replayed: lastPromptAt([user('u', 'replayed')]),
			running: runningStep([user('u', 'go'), tool('t1', 'Read a.ts', 'completed'), tool('t2', 'Edit b.ts', 'in_progress')]),
			finished: runningStep([user('u', 'go'), tool('t', 'Read a.ts', 'completed'), agent('a', 'done')]),
			earlierTurn: runningStep([tool('t', 'Read a.ts', 'pending'), user('u', 'go')]),
		}).toEqual({ at: 200, replayed: undefined, running: 'Edit b.ts', finished: undefined, earlierTurn: undefined });
	});

	it('describes a turn for the log without its contents', () => {
		const items: TranscriptItem[] = [
			user('u', 'secret prompt'),
			{ id: 'th', kind: 'thought', text: 'secret thought' },
			tool('t', 'browser_snapshot with a title longer than forty characters', 'completed', 2),
			{ id: 'p', kind: 'permission', title: 'Run rm', options: [], diffPaths: [], answer: { kind: 'cancelled' } },
			{ id: 'q', kind: 'permission', title: 'Run ls', options: [], diffPaths: [] },
			notice('n', 'error'),
			agent('a', 'secret reply'),
		];
		expect([turnShape(items), turnShape([])]).toEqual([
			'user, thought, tool(browser_snapshot with a title longer tha: completed, 2 parts), permission(cancelled), permission(open), notice, agent',
			'nothing',
		]);
	});
});

describe('rewind', () => {
	it('offers the prompts with text, newest first, and counts later prompts that say the same', () => {
		const items = [user('u1', 'fix  it'), agent('a', 'ok'), user('u2', '  '), user('u3', 'fix it'), user('u4', 'other'), user('u5', ' fix\nit ')];
		expect({
			prompts: rewindPrompts(items).map(item => item.id),
			first: laterRepeats(items, 0),
			last: laterRepeats(items, 5),
		}).toEqual({ prompts: ['u5', 'u4', 'u3', 'u1'], first: 2, last: 0 });
	});
});

describe('checkpoints and undo', () => {
	it('takes back saved checkpoints only when every turn they cover is shown', () => {
		const items = [user('u', 'go'), turnEnd('e1'), user('v', 'again'), turnEnd('e2')];
		const stored = (...ids: string[]) => ({ turns: ids.map(id => ({ id, before: [], undoable: true })), agentText: [] });
		expect([
			checkpointsFit(items, stored('e1', 'e2')),
			checkpointsFit(items, stored('e2')),
			checkpointsFit(items, stored('e1', 'gone')),
			checkpointsFit(items, stored()),
			checkpointsFit(items, undefined),
		]).toEqual([true, true, false, false, false]);
	});

	it('tells the agent which files were put back, relative to its folder', () => {
		const cwd = path.join(path.sep, 'w');
		expect(undoNote(cwd, [path.join(cwd, 'src', 'a.ts'), path.join(path.sep, 'elsewhere', 'b.ts')])).toBe(
			`[The user undid your file changes. These files are back to how they were before those replies, so read them again before editing them: ${path.join('src', 'a.ts')}, ${path.relative(cwd, path.join(path.sep, 'elsewhere', 'b.ts'))}]`);
	});
});

describe('buildModeAfterPlan', () => {
	it('offers Default after a plan, only in Plan mode when the agent has both', () => {
		const modes = (currentId: string, ...ids: string[]) => ({ mode: { currentId, available: ids.map(id => ({ id, name: id })) } });
		expect([
			buildModeAfterPlan(modes('plan', 'plan', 'default', 'yolo')),
			buildModeAfterPlan(modes('default', 'plan', 'default')),
			buildModeAfterPlan(modes('plan', 'plan', 'autoEdit')),
			buildModeAfterPlan({}),
		]).toEqual(['default', undefined, undefined, undefined]);
	});
});

describe('diffsOf and dropOldest', () => {
	it('keeps a tool call\'s diffs, and only the newest 200 entries', () => {
		const diff = { type: 'diff' as const, path: '/w/a.ts', oldText: 'a', newText: 'b' };
		const set = new Set(Array.from({ length: 205 }, (_, i) => i));
		dropOldest(set);
		const map = new Map([['a', 1], ['b', 2]]);
		dropOldest(map);
		expect({
			diffs: diffsOf([{ type: 'content', content: { type: 'text', text: 'x' } }, diff]),
			none: [diffsOf(undefined), diffsOf(null)],
			set: [set.size, Math.min(...set), Math.max(...set)],
			map: [...map.keys()],
		}).toEqual({ diffs: [diff], none: [[], []], set: [200, 5, 204], map: ['a', 'b'] });
	});
});

describe('shouldSuggestCompact', () => {
	it('suggests once per session past 40%, and never on a session a compact made or left', () => {
		const limit = 1000;
		expect(shouldSuggestCompact([], 's1', 399, limit)).toBe(false);
		expect(shouldSuggestCompact([], 's1', 400, limit)).toBe(true);
		expect(shouldSuggestCompact([], undefined, 900, limit)).toBe(false);
		expect(shouldSuggestCompact([{ id: 'c', kind: 'compact', state: 'suggested', percent: 41 }], 's1', 500, limit)).toBe(false);
		expect(shouldSuggestCompact([{ id: 'c', kind: 'compact', state: 'dismissed' }], 's1', 500, limit)).toBe(false);
		const done: TranscriptItem = { id: 'c', kind: 'compact', state: 'done', from: 's1', to: 's2' };
		expect([shouldSuggestCompact([done], 's2', 500, limit), shouldSuggestCompact([done], 's1', 500, limit), shouldSuggestCompact([done], 's3', 500, limit)]).toEqual([false, false, true]);
	});
});

describe('forkPointAfter', () => {
	it('stops before the next prompt, or nowhere after the last reply, and names the prompt answered', () => {
		const items = [user('u1', 'Plan refunds'), agent('a1', 'Plan'), turnEnd('e1'), user('u2', 'Do the UI'), agent('a2', 'Done'), turnEnd('e2')];
		expect([forkPointAfter(items, 'e1'), forkPointAfter(items, 'e2'), forkPointAfter(items, 'u2'), forkPointAfter(items, 'x')]).toEqual([
			{ before: 'u2', answered: 'Plan refunds' },
			{ answered: 'Do the UI' },
			undefined,
			undefined,
		]);
	});
});

describe('forkedItems', () => {
	it('copies the chat up to a prompt, with nothing left that acts on the parent', () => {
		const items: TranscriptItem[] = [
			user('u1', 'Plan refunds'),
			{ id: 'p1', kind: 'permission', title: 'Write', options: [], diffPaths: [] },
			tool('t1', 'Edit', 'in_progress'),
			{ id: 'e1', kind: 'turnEnd', durationMs: 1, undo: 'available', retry: true, files: 2 },
			{ id: 'c1', kind: 'compact', state: 'done', before: 9, after: 1, from: 's1', to: 's2', summary: 'S' },
			{ id: 'c2', kind: 'compact', state: 'suggested', percent: 45 },
			{ id: 'f1', kind: 'fork', role: 'child', agent: 'x', title: 'Other fork', context: 'whole' },
			{ id: 'k1', kind: 'cutOff', prompt: 'p' },
			user('u2', 'Do the UI'),
			agent('a2', 'Done'),
		];
		expect(forkedItems(items, 'u2')).toEqual([
			user('u1', 'Plan refunds'),
			{ id: 'p1', kind: 'permission', title: 'Write', options: [], diffPaths: [], answer: { kind: 'cancelled' } },
			{ ...tool('t1', 'Edit', 'in_progress'), status: 'failed' },
			{ id: 'e1', kind: 'turnEnd', durationMs: 1 },
			{ id: 'c1', kind: 'compact', state: 'done', before: 9, after: 1, summary: 'S' },
		]);
		expect(forkedItems(items)?.map(item => item.id).slice(-2)).toEqual(['u2', 'a2']);
		expect(forkedItems(items, 'missing')).toBeUndefined();
	});
});

describe('forkNote', () => {
	it('moves the paths to the fork\'s own folder, or warns that the folder is shared', () => {
		expect(forkNote('Refunds', '/t/refunds', '/t/refunds-fork', 'gemini/refunds-fork')).toContain('Files the earlier messages name under /t/refunds are under /t/refunds-fork now');
		expect(forkNote('Refunds', '/t/refunds', '/t/refunds', undefined)).toContain('the same folder as the other agent');
	});
});
