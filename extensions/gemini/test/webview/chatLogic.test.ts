/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../../src/acp/chatTranscript';
import {
	acceptsEnhanceReply, attachmentIcon, carriesFiles, codeLanguage, composerHeightLimit, currentActivity, currentPrompt, promptStep, formatClock, turnStart, draggedHeight, emptyFence, enhanceButtonPlacement, enhanceOriginal, type EnhancePhase, enhancePhaseAfterInput, enhanceShortcutLabel, enhanceText, fileReference, fileUris, folderOf, format, formatDuration, formatSentAt, isEnhanceShortcut,
	imageName, indexOfItem, isNearBottom, matchCommands, mentionAt, mentionInsertion, permissionDefaults, planIcon, replyBefore, restoredHeight,
	formatTokens, resetsIn, sameAttachment, slashQuery, thoughtSeconds, toolKindIcon, withAppended, withoutMention, wrapIndex,
} from '../../webview-src/chatLogic';

describe('format', () => {
	it('fills in the placeholder', () => {
		expect(format('Worked for {0}', '12s')).toBe('Worked for 12s');
		expect(format('Thought for {0}s', 3)).toBe('Thought for 3s');
		expect(format('No placeholder', 1)).toBe('No placeholder');
	});
});

describe('formatDuration', () => {
	it('shows at least a second', () => {
		expect(formatDuration(0)).toBe('1s');
		expect(formatDuration(400)).toBe('1s');
	});

	it('shows seconds, then minutes, then hours', () => {
		expect(formatDuration(12_000)).toBe('12s');
		expect(formatDuration(59_400)).toBe('59s');
		expect(formatDuration(59_600)).toBe('1m 0s');
		expect(formatDuration(125_000)).toBe('2m 5s');
		expect(formatDuration(3_780_000)).toBe('1h 3m');
	});
});

describe('thoughtSeconds', () => {
	it('rounds to whole seconds, at least one', () => {
		expect(thoughtSeconds(1000, 1000)).toBe(1);
		expect(thoughtSeconds(0, 2600)).toBe(3);
	});
});

const user = (id: string, text = 'question'): TranscriptItem => ({ id, kind: 'user', text });
const agent = (id: string, text: string): TranscriptItem => ({ id, kind: 'agent', text });
const turnEnd = (id: string): TranscriptItem => ({ id, kind: 'turnEnd', durationMs: 1000 });

describe('replyBefore', () => {
	it('joins the agent text of the turn, skipping other items and empty text', () => {
		const items: TranscriptItem[] = [
			user('u1'), agent('a1', 'old reply'), turnEnd('e1'),
			user('u2'), agent('a2', '  First part. \n'), { id: 't', kind: 'thought', text: 'hmm' }, agent('a3', '  '), agent('a4', 'Second part.'), turnEnd('e2'),
		];
		expect(replyBefore(items, 'e2')).toBe('First part.\n\nSecond part.');
		expect(replyBefore(items, 'e1')).toBe('old reply');
	});

	it('stops at a turn end when the turn had no user message', () => {
		const items = [agent('a1', 'one'), turnEnd('e1'), agent('a2', 'two'), turnEnd('e2')];
		expect(replyBefore(items, 'e2')).toBe('two');
	});

	it('is empty for an unknown turn end', () => {
		expect(replyBefore([agent('a1', 'one')], 'missing')).toBe('');
	});
});

describe('indexOfItem and withAppended', () => {
	const items = [user('u1'), agent('a1', 'Hello'), { id: 't1', kind: 'thought', text: 'Hm' } as TranscriptItem];

	it('finds items by id', () => {
		expect(indexOfItem(items, 't1')).toBe(2);
		expect(indexOfItem(items, 'a1')).toBe(1);
		expect(indexOfItem(items, 'nope')).toBe(-1);
		expect(indexOfItem([], 'nope')).toBe(-1);
	});

	it('appends text to replies and thoughts only', () => {
		expect(withAppended(items[1], { kind: 'append', id: 'a1', append: ' world' })).toEqual({ id: 'a1', kind: 'agent', text: 'Hello world' });
		expect(withAppended(items[2], { kind: 'append', id: 't1', append: 'm' })).toEqual({ id: 't1', kind: 'thought', text: 'Hmm' });
		expect(withAppended(items[0], { kind: 'append', id: 'u1', append: '!' })).toBeUndefined();
		expect(withAppended(undefined, { kind: 'append', id: 'x', append: '!' })).toBeUndefined();
	});
});

describe('sameAttachment', () => {
	it('compares files and selections by path and range', () => {
		expect(sameAttachment({ kind: 'file', path: '/a' }, { kind: 'file', path: '/a' })).toBe(true);
		expect(sameAttachment({ kind: 'file', path: '/a' }, { kind: 'file', path: '/b' })).toBe(false);
		const selection = { kind: 'selection', path: '/a', startLine: 1, endLine: 4, text: 'x' } as const;
		expect(sameAttachment(selection, { ...selection, text: 'changed' })).toBe(true);
		expect(sameAttachment(selection, { ...selection, endLine: 5 })).toBe(false);
		expect(sameAttachment({ kind: 'file', path: '/a' }, selection)).toBe(false);
	});

	it('compares documents by path, else by contents', () => {
		const withPath = { kind: 'document', name: 'a.txt', mimeType: 'text/plain', path: '/a.txt', text: 'one' } as const;
		expect(sameAttachment(withPath, { ...withPath, text: 'two' })).toBe(true);
		const pasted = { kind: 'document', name: 'a.txt', mimeType: 'text/plain', text: 'one' } as const;
		expect(sameAttachment(pasted, { ...pasted })).toBe(true);
		expect(sameAttachment(pasted, { ...pasted, text: 'two' })).toBe(false);
		expect(sameAttachment(pasted, { ...pasted, name: 'b.txt' })).toBe(false);
	});

	it('compares images by data', () => {
		const image = { kind: 'image', name: 'a.png', mimeType: 'image/png', data: 'AAA' } as const;
		expect(sameAttachment(image, { ...image, name: 'b.png' })).toBe(true);
		expect(sameAttachment(image, { ...image, data: 'BBB' })).toBe(false);
	});
});

describe('attachment names and icons', () => {
	it('picks an icon by kind and extension', () => {
		expect(attachmentIcon('image', 'a.png')).toBe('file-media');
		expect(attachmentIcon('selection', 'a.ts:1-2')).toBe('list-selection');
		expect(attachmentIcon('document', 'Report.PDF')).toBe('file-pdf');
		expect(attachmentIcon('file', 'a.ts')).toBe('file');
	});

	it('names unnamed images by type', () => {
		expect(imageName('shot.png', 'image/png')).toBe('shot.png');
		expect(imageName('', 'image/jpeg')).toBe('image.jpeg');
		expect(imageName('', '')).toBe('image.png');
	});
});

describe('mentions', () => {
	it('finds the "@word" before the caret', () => {
		expect(mentionAt('@', 1, 1)).toEqual({ start: 0, query: '' });
		expect(mentionAt('see @src/ma', 11, 11)).toEqual({ start: 4, query: 'src/ma' });
		expect(mentionAt('see @src/main.ts and', 11, 11)).toEqual({ start: 4, query: 'src/ma' });
		expect(mentionAt('line\n@x', 7, 7)).toEqual({ start: 5, query: 'x' });
	});

	it('needs a word boundary, a caret in the word and no selection', () => {
		expect(mentionAt('mail me@example', 15, 15)).toBeUndefined();
		expect(mentionAt('@a b', 4, 4)).toBeUndefined();
		expect(mentionAt('@abc', 1, 4)).toBeUndefined();
		expect(mentionAt('@a@b', 4, 4)).toBeUndefined();
	});

	it('adds a space before an inserted "@" only after a word', () => {
		expect(mentionInsertion('')).toBe('@');
		expect(mentionInsertion('see ')).toBe('@');
		expect(mentionInsertion('see\n')).toBe('@');
		expect(mentionInsertion('see')).toBe(' @');
	});

	it('removes the typed mention', () => {
		expect(withoutMention('see @src/ma please', 4, 'src/ma')).toBe('see  please');
		expect(withoutMention('@', 0, '')).toBe('');
	});
});

describe('picker helpers', () => {
	it('splits off the folder', () => {
		expect(folderOf('src/deep/a.ts')).toBe('src/deep');
		expect(folderOf('a.ts')).toBe('');
	});

	it('wraps around', () => {
		expect(wrapIndex(0, -1, 3)).toBe(2);
		expect(wrapIndex(2, 1, 3)).toBe(0);
		expect(wrapIndex(1, 1, 3)).toBe(2);
	});
});

describe('dropped files', () => {
	it('keeps the file URIs of a URI list', () => {
		expect(fileUris('file:///a.ts\r\n  file:///b%20c.ts  \nhttps://example.com\n# comment\n')).toEqual(['file:///a.ts', 'file:///b%20c.ts']);
		expect(fileUris('')).toEqual([]);
	});

	it('recognizes drags that carry files', () => {
		expect(carriesFiles(['Files'])).toBe(true);
		expect(carriesFiles(['text/plain', 'text/uri-list'])).toBe(true);
		expect(carriesFiles(['application/vnd.code.uri-list'])).toBe(true);
		expect(carriesFiles(['text/plain'])).toBe(false);
		expect(carriesFiles([])).toBe(false);
	});
});

describe('code blocks', () => {
	it('reads the language from the class', () => {
		expect(codeLanguage('language-ts')).toBe('ts');
		expect(codeLanguage('hljs language-c++ x')).toBe('c++');
		expect(codeLanguage('xlanguage-ts')).toBe('');
		expect(codeLanguage('')).toBe('');
	});

	it('closes an empty fence with its own marker', () => {
		expect(emptyFence('```ts')).toBe('```ts\n```\n');
		expect(emptyFence('~~~~ python  ')).toBe('~~~~ python  \n~~~~\n');
	});
});

describe('icons', () => {
	it('picks tool and plan icons', () => {
		expect(toolKindIcon('execute')).toBe('terminal');
		expect(toolKindIcon('other')).toBe('tools');
		expect(toolKindIcon(undefined)).toBe('tools');
		expect(planIcon('completed')).toBe('pass-filled');
		expect(planIcon('in_progress')).toBe('loading');
		expect(planIcon('pending')).toBe('circle-large-outline');
	});
});

describe('permissionDefaults', () => {
	it('prefers allowing and rejecting once', () => {
		const options = [
			{ optionId: 'aa', name: 'Always', kind: 'allow_always' },
			{ optionId: 'a', name: 'Allow', kind: 'allow_once' },
			{ optionId: 'ra', name: 'Never', kind: 'reject_always' },
			{ optionId: 'r', name: 'Reject', kind: 'reject_once' },
		] as const;
		const { primary, reject } = permissionDefaults(options);
		expect(primary?.optionId).toBe('a');
		expect(reject?.optionId).toBe('r');
	});

	it('falls back to any allow or reject, or none', () => {
		const { primary, reject } = permissionDefaults([{ optionId: 'aa', name: 'Always', kind: 'allow_always' }, { optionId: 'ra', name: 'Never', kind: 'reject_always' }]);
		expect(primary?.optionId).toBe('aa');
		expect(reject?.optionId).toBe('ra');
		expect(permissionDefaults([])).toEqual({ primary: undefined, reject: undefined });
	});
});

describe('scroll and composer height', () => {
	it('counts within 40px of the bottom as at the bottom', () => {
		expect(isNearBottom(1000, 561, 400)).toBe(true);
		expect(isNearBottom(1000, 560, 400)).toBe(false);
	});

	it('limits the composer to 70% of the view, and at least 60px', () => {
		expect(composerHeightLimit(1000)).toBe(700);
		expect(composerHeightLimit(50)).toBe(60);
	});

	it('clamps a dragged height', () => {
		expect(draggedHeight(100, 500, 450, 1000)).toBe(150);
		expect(draggedHeight(100, 500, 700, 1000)).toBe(20);
		expect(draggedHeight(100, 900, 0, 1000)).toBe(700);
	});

	it('fits a remembered height to the view, unless it has no height yet', () => {
		expect(restoredHeight(300, 1000)).toBe(300);
		expect(restoredHeight(900, 1000)).toBe(700);
		expect(restoredHeight(900, 0)).toBe(900);
	});
});

describe('slashQuery', () => {
	it('opens the menu for a "/name" at the start of the input', () => {
		expect(slashQuery('/', 1, 1)).toBe('');
		expect(slashQuery('/ini', 4, 4)).toBe('ini');
		expect(slashQuery('/ini', 2, 2)).toBeUndefined();
	});

	it('closes it once arguments start, elsewhere in the text, or with a selection', () => {
		expect(slashQuery('/init ', 6, 6)).toBeUndefined();
		expect(slashQuery('fix /init', 9, 9)).toBeUndefined();
		expect(slashQuery('/init', 0, 5)).toBeUndefined();
	});
});

describe('matchCommands', () => {
	const commands = [{ name: 'init' }, { name: 'git:commit' }, { name: 'memory' }, { name: 'commit' }];

	it('lists names starting with the query first, then those containing it', () => {
		expect(matchCommands(commands, 'com').map(c => c.name)).toEqual(['commit', 'git:commit']);
		expect(matchCommands(commands, '').map(c => c.name)).toEqual(['init', 'git:commit', 'memory', 'commit']);
		expect(matchCommands(commands, 'MEM').map(c => c.name)).toEqual(['memory']);
	});
});

describe('fileReference', () => {
	it('reads file names, paths and lines', () => {
		expect(fileReference('src/cart/total.ts')).toEqual({ path: 'src/cart/total.ts' });
		expect(fileReference('total.ts:11')).toEqual({ path: 'total.ts', line: 11 });
		expect(fileReference('./test/total.test.ts:4:2')).toEqual({ path: './test/total.test.ts', line: 4 });
		expect(fileReference('package.json')).toEqual({ path: 'package.json' });
	});

	it('ignores code that only looks like a name with a dot', () => {
		for (const text of ['item.price', 'Math.round', 'cartTotal()', 'npm test', 'v1.2.3', '.ts']) {
			expect(fileReference(text)).toBeUndefined();
		}
	});
});

describe('Enhance prompt', () => {
	const working: EnhancePhase = { kind: 'working', requestId: 2, original: 'fix it' };
	const done: EnhancePhase = { kind: 'done', original: 'fix it', rewrite: 'Fix the login bug.' };

	it('turns a rewrite the user edits or undoes back into their own draft', () => {
		expect(enhancePhaseAfterInput(done, 'Fix the login bug.')).toBe(done);
		expect(enhancePhaseAfterInput(done, 'Fix the login bug now.')).toEqual({ kind: 'idle' });
		expect(enhancePhaseAfterInput(done, 'fix it')).toEqual({ kind: 'idle' });
		expect(enhancePhaseAfterInput(working, 'anything')).toBe(working);
	});

	it('takes only the reply to the rewrite in progress', () => {
		expect(acceptsEnhanceReply(working, 2)).toBe(true);
		expect(acceptsEnhanceReply(working, 1)).toBe(false);
		expect(acceptsEnhanceReply({ kind: 'idle' }, 2)).toBe(false);
		expect(acceptsEnhanceReply(done, 2)).toBe(false);
	});

	it('reverts to what the user wrote, also after enhancing a rewrite again', () => {
		expect(enhanceOriginal({ kind: 'idle' }, 'my draft')).toBe('my draft');
		expect(enhanceOriginal(done, 'Fix the login bug.')).toBe('fix it');
		expect(enhanceOriginal(done, 'something else')).toBe('something else');
	});

	it('keeps the line endings a textarea keeps', () => {
		expect(enhanceText('Goal: a\r\nDone when: b\rend')).toBe('Goal: a\nDone when: b\nend');
	});

	it('knows the shortcut on each platform', () => {
		const key = (code: string, mods: Partial<Record<'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey', boolean>>) => ({ code, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...mods });
		expect(isEnhanceShortcut(key('KeyE', { altKey: true, metaKey: true }), true)).toBe(true);
		expect(isEnhanceShortcut(key('KeyE', { altKey: true, ctrlKey: true }), false)).toBe(true);
		expect(isEnhanceShortcut(key('KeyE', { altKey: true, ctrlKey: true }), true)).toBe(false);
		expect(isEnhanceShortcut(key('KeyE', { altKey: true, metaKey: true, shiftKey: true }), true)).toBe(false);
		expect(isEnhanceShortcut(key('KeyR', { altKey: true, metaKey: true }), true)).toBe(false);
		expect(enhanceShortcutLabel(true)).toBe('\u2325\u2318E');
		expect(enhanceShortcutLabel(false)).toBe('Ctrl+Alt+E');
	});
});

describe('enhanceButtonPlacement', () => {
	const end = { left: 100, top: 20, lineHeight: 20, width: 300, height: 60, scrollTop: 0 };
	const button = { width: 22, height: 22 };
	it('sits just after the text, centred on its line', () => {
		expect(enhanceButtonPlacement(end, button)).toEqual({ x: 106, y: 19, below: false });
	});
	it('starts the next line when it does not fit after the text', () => {
		expect(enhanceButtonPlacement({ ...end, left: 290 }, button)).toEqual({ x: 0, y: 38, below: true });
	});
	it('stays in the visible part of a scrolled input', () => {
		expect(enhanceButtonPlacement({ ...end, top: 200 }, button).y).toBe(38);
		expect(enhanceButtonPlacement({ ...end, scrollTop: 100 }, button).y).toBe(0);
	});
});

describe('formatSentAt', () => {
	const at = new Date(2026, 9, 5, 10, 42).getTime();
	it('shows the time alone for today', () => {
		expect(formatSentAt(at, new Date(2026, 9, 5, 18, 0).getTime(), 'en-GB')).toBe('10:42');
	});
	it('adds the day before today, and the year before this year', () => {
		expect(formatSentAt(at, new Date(2026, 9, 6, 9, 0).getTime(), 'en-GB')).toBe('5 Oct, 10:42');
		expect(formatSentAt(at, new Date(2027, 0, 2).getTime(), 'en-GB')).toBe('5 Oct 2026, 10:42');
	});
});

describe('formatClock', () => {
	it('shows minutes and seconds, then hours', () => {
		expect(formatClock(0)).toBe('0:00');
		expect(formatClock(7_400)).toBe('0:07');
		expect(formatClock(102_000)).toBe('1:42');
		expect(formatClock(3_723_000)).toBe('1:02:03');
		expect(formatClock(-5)).toBe('0:00');
	});
});

describe('currentActivity', () => {
	const user: TranscriptItem = { id: 'u', kind: 'user', text: 'Fix it', at: 1000 };
	const tool = (status: 'pending' | 'in_progress' | 'completed' | 'failed'): TranscriptItem => ({ id: 't', kind: 'toolCall', title: 'npm test', toolKind: 'execute', status, locations: [], details: [] });

	it('thinks when the turn has just started', () => {
		expect(currentActivity([user])).toEqual({ kind: 'thinking', detail: '' });
		expect(currentActivity([])).toEqual({ kind: 'thinking', detail: '' });
	});

	it('names a running tool call, and thinks again once it ends', () => {
		expect(currentActivity([user, tool('in_progress')])).toEqual({ kind: 'tool', detail: 'npm test' });
		expect(currentActivity([user, tool('pending')])).toEqual({ kind: 'tool', detail: 'npm test' });
		expect(currentActivity([user, tool('completed')])).toEqual({ kind: 'thinking', detail: '' });
	});

	it('shows the latest heading of a thought', () => {
		expect(currentActivity([user, { id: 'th', kind: 'thought', text: '**Reading the code**\n\n**Planning the fix**\nmore' }])).toEqual({ kind: 'thinking', detail: 'Planning the fix' });
	});

	it('is writing once the reply streams, waiting while a question is open', () => {
		expect(currentActivity([user, { id: 'a', kind: 'agent', text: 'Done' }])).toEqual({ kind: 'writing', detail: '' });
		const question: TranscriptItem = { id: 'p', kind: 'permission', title: 'Run npm install', options: [], diffPaths: [] };
		expect(currentActivity([user, question])).toEqual({ kind: 'waiting', detail: 'Run npm install' });
		expect(currentActivity([user, { ...question, answer: { kind: 'selected', name: 'Allow' } }])).toEqual({ kind: 'thinking', detail: '' });
	});

	it('skips plans and notices', () => {
		expect(currentActivity([user, tool('in_progress'), { id: 'pl', kind: 'plan', entries: [] }, { id: 'n', kind: 'notice', text: 'x', severity: 'info' }])).toEqual({ kind: 'tool', detail: 'npm test' });
	});
});

describe('turnStart', () => {
	it('is the newest prompt’s send time within the running turn', () => {
		expect(turnStart([{ id: 'u', kind: 'user', text: 'a', at: 5 }, { id: 'a', kind: 'agent', text: 'b' }])).toBe(5);
		expect(turnStart([{ id: 'u', kind: 'user', text: 'a' }])).toBeUndefined();
		expect(turnStart([{ id: 'u', kind: 'user', text: 'a', at: 5 }, { id: 'e', kind: 'turnEnd', durationMs: 1 }])).toBeUndefined();
	});
});

describe('prompt navigation', () => {
	const tops = [0, 400, 1200];
	it('finds the prompt in view', () => {
		expect(currentPrompt([], 0)).toBe(-1);
		expect(currentPrompt(tops, 0)).toBe(0);
		expect(currentPrompt(tops, 395)).toBe(1);
		expect(currentPrompt(tops, 1000)).toBe(1);
		expect(currentPrompt([50], 0)).toBe(-1);
	});
	it('steps to the next and previous prompt', () => {
		expect(promptStep(tops, 0, 1)).toBe(1);
		expect(promptStep(tops, 400, 1)).toBe(2);
		expect(promptStep(tops, 1200, 1)).toBe(-1);
		expect(promptStep(tops, 1200, -1)).toBe(1);
		expect(promptStep(tops, 600, -1)).toBe(1);
		expect(promptStep(tops, 0, -1)).toBe(-1);
	});
});

describe('formatTokens', () => {
	it('shortens large counts', () => {
		expect(formatTokens(950, 'en')).toBe('950');
		expect(formatTokens(48_210, 'en')).toBe('48.2K');
		expect(formatTokens(1_340_000, 'en')).toBe('1.3M');
	});
});

describe('resetsIn', () => {
	const now = Date.parse('2026-10-08T10:00:00Z');

	it('counts whole hours, then minutes under an hour', () => {
		expect(resetsIn('2026-10-08T15:40:00Z', now)).toEqual({ unit: 'hours', value: 5 });
		expect(resetsIn('2026-10-08T10:25:00Z', now)).toEqual({ unit: 'minutes', value: 25 });
		expect(resetsIn('2026-10-08T10:00:10Z', now)).toEqual({ unit: 'minutes', value: 1 });
	});

	it('is undefined once passed or when unknown', () => {
		expect(resetsIn('2026-10-08T09:00:00Z', now)).toBeUndefined();
		expect(resetsIn(undefined, now)).toBeUndefined();
		expect(resetsIn('soon', now)).toBeUndefined();
	});
});
