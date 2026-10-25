/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { Attachment } from '../../src/acp/attachments';
import type { TranscriptItem } from '../../src/acp/chatTranscript';
import { atSafePoint, PromptQueue, steeringNote, withoutSteeringNote } from '../../src/acp/promptQueue';

const user = (id: string): TranscriptItem => ({ id, kind: 'user', text: 'do it' });
const agent = (id: string): TranscriptItem => ({ id, kind: 'agent', text: 'on it' });
const tool = (id: string, status: 'pending' | 'in_progress' | 'completed' | 'failed'): TranscriptItem => ({
	id, kind: 'toolCall', title: 'Shell', toolKind: 'execute', status, locations: [], details: [],
});
const file: Attachment = { kind: 'file', path: '/w/a.ts' };

describe('PromptQueue', () => {
	it('keeps queued and steering messages in order, and shows how many files each carries', () => {
		const queue = new PromptQueue();
		queue.add('first', [], false);
		queue.add('second', [file], true);
		expect(queue.hasSteer).toBe(true);
		expect(queue.view).toEqual([
			{ id: 'q1', text: 'first', attachments: 0, steer: false },
			{ id: 'q2', text: 'second', attachments: 1, steer: true },
		]);
	});

	it('takes the steering messages out, joined, and leaves the queued ones', () => {
		const queue = new PromptQueue();
		queue.add('later', [], false);
		queue.add('use pnpm', [], true);
		queue.add(' not npm ', [file], true);
		expect(queue.takeSteers()).toEqual({ text: 'use pnpm\n\nnot npm', attachments: [file] });
		expect(queue.view.map(item => item.text)).toEqual(['later']);
		expect(queue.takeSteers()).toBeUndefined();
	});

	it('sends every queued message together once the turn is done', () => {
		const queue = new PromptQueue();
		queue.add('one', [], false);
		queue.add('two', [file], false);
		expect(queue.takeAll()).toEqual({ text: 'one\n\ntwo', attachments: [file] });
		expect(queue.pending).toEqual([]);
		expect(queue.takeAll()).toBeUndefined();
	});

	it('turns a queued message into one sent now, once', () => {
		const queue = new PromptQueue();
		queue.add('one', [], false);
		expect(queue.steer('q1')).toBe(true);
		expect(queue.steer('q1')).toBe(false);
		expect(queue.steer('gone')).toBe(false);
		expect(queue.hasSteer).toBe(true);
	});

	it('holds messages sent now when the turn is stopped, so nothing goes behind the user', () => {
		const queue = new PromptQueue();
		queue.add('now', [], true);
		queue.holdSteers();
		expect(queue.hasSteer).toBe(false);
		expect(queue.view).toEqual([{ id: 'q1', text: 'now', attachments: 0, steer: false }]);
	});

	it('marks the coordinator\'s notes, and sends them as its own only when nothing else goes with them', () => {
		const queue = new PromptQueue();
		queue.add('check the tests', [], false, 'coordinator');
		expect(queue.view).toEqual([{ id: 'q1', text: 'check the tests', attachments: 0, steer: false, from: 'coordinator' }]);
		expect(queue.remove('q1')?.from).toBe('coordinator');
		queue.add('check the tests', [], false, 'coordinator');
		queue.add('and the docs', [], false, 'coordinator');
		expect(queue.takeAll()).toEqual({ text: 'check the tests\n\nand the docs', attachments: [], from: 'coordinator' });
		queue.add('check the tests', [], false, 'coordinator');
		queue.add('use pnpm', [], false);
		expect(queue.takeAll()).toEqual({ text: 'check the tests\n\nuse pnpm', attachments: [] });
	});

	it('removes one message by id', () => {
		const queue = new PromptQueue();
		queue.add('one', [], false);
		queue.add('two', [], false);
		expect(queue.remove('q1')?.text).toBe('one');
		expect(queue.remove('q1')).toBeUndefined();
		expect(queue.view.map(item => item.id)).toEqual(['q2']);
	});

	it('queues a reaction as its own message, replacing one still waiting for the same reply', () => {
		const queue = new PromptQueue();
		queue.add('use pnpm', [], false);
		queue.addReaction({ turnEnd: 'item-3', emoji: '🚀', name: 'rocket' }, false);
		queue.addReaction({ turnEnd: 'item-3', emoji: '👎', name: 'thumbs down', meaning: 'Stop.' }, true);
		queue.addReaction({ turnEnd: 'item-7', emoji: '❓', name: 'question mark' }, false);
		expect(queue.hasReaction('item-3', '👎')).toBe(true);
		expect(queue.hasReaction('item-3', '🚀')).toBe(false);
		expect(queue.view).toEqual([
			{ id: 'q1', text: 'use pnpm', attachments: 0, steer: false },
			{ id: 'q2', text: '', attachments: 0, steer: true, reactions: [{ emoji: '👎', name: 'thumbs down' }] },
			{ id: 'q3', text: '', attachments: 0, steer: false, reactions: [{ emoji: '❓', name: 'question mark' }] },
		]);
		expect(queue.takeSteers()).toEqual({ text: '', attachments: [], reactions: [{ turnEnd: 'item-3', emoji: '👎', name: 'thumbs down', meaning: 'Stop.' }] });
		expect(queue.takeAll()).toEqual({ text: 'use pnpm', attachments: [], reactions: [{ turnEnd: 'item-7', emoji: '❓', name: 'question mark' }] });
	});
});

describe('atSafePoint', () => {
	it('is safe while the model thinks or writes, and after every tool finished', () => {
		expect(atSafePoint([user('u')], false)).toBe(true);
		expect(atSafePoint([user('u'), tool('t', 'completed'), agent('a')], false)).toBe(true);
		expect(atSafePoint([user('u'), tool('t', 'failed')], false)).toBe(true);
	});

	it('waits while a tool runs', () => {
		expect(atSafePoint([user('u'), tool('t', 'in_progress')], false)).toBe(false);
		expect(atSafePoint([user('u'), tool('t', 'in_progress'), tool('t2', 'completed')], false)).toBe(false);
		expect(atSafePoint([user('u'), tool('t', 'pending')], false)).toBe(false);
	});

	it('is safe at a permission prompt, since the tool has not started', () => {
		expect(atSafePoint([user('u'), tool('t', 'pending')], true)).toBe(true);
		expect(atSafePoint([user('u'), tool('t', 'in_progress')], true)).toBe(false);
	});

	it('looks only at the running turn', () => {
		expect(atSafePoint([user('u0'), tool('old', 'in_progress'), user('u')], false)).toBe(true);
	});
});

describe('steeringNote', () => {
	it('carries the steering instruction of gemini-cli', () => {
		expect(steeringNote()).toContain('Classify it as ADD_TASK, MODIFY_TASK, CANCEL_TASK, or EXTRA_CONTEXT');
	});

	it('is left out when a saved session replays', () => {
		expect(withoutSteeringNote(`${steeringNote()}\n\nuse pnpm`)).toBe('use pnpm');
		expect(withoutSteeringNote(steeringNote())).toBe('');
		expect(withoutSteeringNote('use pnpm')).toBe('use pnpm');
		expect(withoutSteeringNote('<steering_note> unclosed')).toBe('<steering_note> unclosed');
	});
});
