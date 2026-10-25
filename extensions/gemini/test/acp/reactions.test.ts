/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { isSingleEmoji, leadingReaction, meaningOf, reactionNote, reactionReport, reactionRule, replyExcerpt, resolveMeanings, routeReaction, withoutReactionNotes } from '../../src/acp/reactions';

const meanings = resolveMeanings(undefined);
const idle = { busy: false, buildPlan: false };
const busy = { busy: true, buildPlan: false };

describe('resolveMeanings', () => {
	it('has the four built-ins, the heart with no meaning', () => {
		expect([...meanings.keys()]).toEqual(['👍', '👎', '❓', '❤']);
		expect(meaningOf('❤️', meanings)).toBeUndefined();
		expect(meaningOf('👍', meanings)).toBe('Approve what you proposed and go ahead.');
	});

	it('changes or adds meanings, and ignores entries it cannot use', () => {
		const edited = resolveMeanings({
			'👍': ' Go ahead and run the tests first. ',
			'🚀': 'Go ahead, then commit with a short message.',
			'❤️': 'Thanks: write a one-line summary of what changed.',
			'not an emoji': 'ignored',
			'🎉🎉': 'two emoji, ignored',
			'🔥': '',
			'🐛': 'x'.repeat(501),
			'🧪': 3,
		});
		expect(Object.fromEntries(edited)).toEqual({
			'👍': 'Go ahead and run the tests first.',
			'👎': meaningOf('👎', meanings),
			'❓': meaningOf('❓', meanings),
			'❤': 'Thanks: write a one-line summary of what changed.',
			'🚀': 'Go ahead, then commit with a short message.',
		});
	});

	it('keeps the built-ins whatever the setting holds', () => {
		expect(resolveMeanings(['👍']).size).toBe(4);
		expect(resolveMeanings('👍').size).toBe(4);
		expect(resolveMeanings(null).size).toBe(4);
	});
});

describe('routeReaction', () => {
	it('takes each reaction down its path', () => {
		expect({
			heartIdle: routeReaction('❤️', meanings, idle),
			heartBusy: routeReaction('❤', meanings, busy),
			upOnPlan: routeReaction('👍', meanings, { busy: false, buildPlan: true }),
			upIdle: routeReaction('👍', meanings, idle),
			upBusy: routeReaction('👍', meanings, busy),
			downIdle: routeReaction('👎', meanings, idle),
			downBusy: routeReaction('👎', meanings, busy),
			rocketIdle: routeReaction('🚀', meanings, idle),
			rocketBusy: routeReaction('🚀', meanings, busy),
		}).toEqual({
			heartIdle: 'mark', heartBusy: 'mark', upOnPlan: 'buildPlan', upIdle: 'send', upBusy: 'queue',
			downIdle: 'send', downBusy: 'now', rocketIdle: 'send', rocketBusy: 'queue',
		});
	});

	it('sends an edited heart like any reaction', () => {
		expect(routeReaction('❤️', resolveMeanings({ '❤️': 'Say thanks.' }), idle)).toBe('send');
	});
});

describe('reactionNote', () => {
	it('gives a fixed meaning for the latest reply', () => {
		expect(reactionNote({ turnEnd: 'item-4', emoji: '👍', name: 'thumbs up', meaning: 'Approve what you proposed and go ahead.' })).toBe(
			'<reaction_note>\nThe user reacted 👍 (thumbs up) to your reply.\nBefore any tool call, say in one short line how you read the reaction.\nThey mean: Approve what you proposed and go ahead.\n</reaction_note>\n');
	});

	it('quotes an older reply, says it did not finish, and that it stopped the turn', () => {
		expect(reactionNote({ emoji: '🚀', name: 'rocket', excerpt: 'Added a retry', unfinished: true }, true)).toBe([
			'<reaction_note>',
			'The user reacted 🚀 (rocket) to your reply that began: "Added a retry".',
			'That turn did not finish.',
			'The user stopped your turn to send it. Your last step may not have finished: check its result before repeating it.',
			'Before any tool call, say in one short line how you read the reaction.',
			'Decide what they mean.',
			'- If it clearly approves or asks for a next step you proposed, do it.',
			'- If it is negative or asks for a change, ask what to change. Do not undo work on your own.',
			'- If it is only appreciation or acknowledgement, reply in one short line and take no action.',
			'- If you are unsure, ask one short question.',
			'</reaction_note>',
			'',
		].join('\n'));
	});
});

describe('withoutReactionNotes', () => {
	it('takes the notes and the rule out of a replayed message, keeping its reactions', () => {
		const text = reactionNote({ emoji: '👎', name: 'thumbs down', meaning: 'Stop.' }) + reactionNote({ emoji: '🚀', name: 'rocket' }) + reactionRule() + 'and use pnpm';
		expect(withoutReactionNotes(text)).toEqual({
			text: 'and use pnpm',
			reactions: [{ emoji: '👎', name: 'thumbs down' }, { emoji: '🚀', name: 'rocket' }],
		});
	});

	it('leaves a message without notes as it is', () => {
		expect(withoutReactionNotes('just text')).toEqual({ text: 'just text', reactions: [] });
	});
});

describe('leadingReaction', () => {
	it('lifts a tag at the start of the reply', () => {
		expect(leadingReaction('<react>🎉</react> Pushed to main.')).toEqual({ emoji: '🎉', rest: 'Pushed to main.' });
		expect(leadingReaction('\n<react> 👨‍👩‍👧 </react>\nDone.')).toEqual({ emoji: '👨‍👩‍👧', rest: 'Done.' });
		expect(leadingReaction('<react>🇮🇳</react>')).toEqual({ emoji: '🇮🇳', rest: '' });
	});

	it('waits while the tag may still be coming, split across chunks', () => {
		expect(['', ' ', '<', '<rea', '<react>', '<react>🎉', '<react>🎉</re'].map(leadingReaction)).toEqual(Array(7).fill('pending'));
	});

	it('leaves anything else as text', () => {
		expect({
			plain: leadingReaction('Done.'),
			angle: leadingReaction('<div>'),
			midReply: leadingReaction('Done. <react>🎉</react>'),
			words: leadingReaction('<react>party</react> Done.'),
			twoEmoji: leadingReaction('<react>🎉🎉</react> Done.'),
			neverClosed: leadingReaction(`<react>${'x'.repeat(40)}`),
		}).toEqual({ plain: 'none', angle: 'none', midReply: 'none', words: 'none', twoEmoji: 'none', neverClosed: 'none' });
	});
});

describe('emoji helpers', () => {
	it('knows one emoji from text or several', () => {
		expect(['👍', '❤️', '❤', '👍🏽', '👨‍💻', '🇯🇵', '1️⃣'].every(isSingleEmoji)).toBe(true);
		expect(['', 'a', '👍👍', 'ok 👍', '🇯'].some(isSingleEmoji)).toBe(false);
	});

	it('quotes the start of a long reply on one line', () => {
		expect(replyExcerpt('Added\n  a retry.')).toBe('Added a retry.');
		expect(replyExcerpt('x'.repeat(400))).toBe(`${'x'.repeat(299)}…`);
	});

	it('reports reactions to a coordinator in one line', () => {
		expect(reactionReport([{ emoji: '👎', name: 'thumbs down' }, { emoji: '🚀', name: 'rocket' }])).toBe('The user reacted 👎 🚀 to its reply.');
		expect(reactionReport([])).toBeUndefined();
	});
});
