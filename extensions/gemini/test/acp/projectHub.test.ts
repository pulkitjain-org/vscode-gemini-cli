/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { coordinatorBrief, ProjectHub, type CoordinatorSession, type FeedEntry, type ThreadDriver } from '../../src/acp/projectHub';

function setup(turn: (prompt: string, hub: ProjectHub) => Promise<void> = async () => { }) {
	const prompts: string[] = [];
	const started: { title: string; brief: string; planFirst: boolean }[] = [];
	const messages: [string, string][] = [];
	let next = 0;
	const driver: ThreadDriver = {
		start: async request => {
			started.push(request);
			return `t${++next}`;
		},
		message: (thread, text) => messages.push([thread, text]),
		read: thread => `messages of ${thread}`,
	};
	const coordinator: CoordinatorSession = {
		prompt: async text => {
			prompts.push(text);
			await turn(text, hub);
		},
	};
	const hub = new ProjectHub('p1', coordinator, driver, { memory: async () => 'Use pnpm.' });
	const feed: FeedEntry[] = [];
	hub.onDidPost(entry => feed.push(entry));
	return { hub, prompts, started, messages, feed };
}

const coordinator = { role: 'coordinator', project: 'p1' } as const;

describe('ProjectHub', () => {
	it('wakes the coordinator at once with the brief, the threads, the notes and the event', async () => {
		const { hub, prompts } = setup();
		hub.post('Fix the cart total');
		await hub.idle();
		expect(prompts).toHaveLength(1);
		expect(prompts[0].startsWith(coordinatorBrief)).toBe(true);
		expect(prompts[0]).toContain('<threads>\nnone yet\n</threads>');
		expect(prompts[0]).toContain('<notes>\nUse pnpm.\n</notes>');
		expect(prompts[0]).toContain('<event kind="user">\nFix the cart total\n</event>');
	});

	it('sends the brief only once', async () => {
		const { hub, prompts } = setup();
		hub.post('one');
		await hub.idle();
		hub.post('two');
		await hub.idle();
		expect(prompts[1]).not.toContain(coordinatorBrief);
	});

	it('batches what arrives mid-turn into one wake after it', async () => {
		let release!: () => void;
		const { hub, prompts } = setup(prompt => prompt.includes('first') ? new Promise(resolve => release = resolve) : Promise.resolve());
		hub.post('first');
		await new Promise(resolve => setTimeout(resolve));
		hub.post('second');
		hub.post('third');
		expect(prompts).toHaveLength(1);
		release();
		await new Promise(resolve => setTimeout(resolve));
		await hub.idle();
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain('second');
		expect(prompts[1]).toContain('third');
	});

	it('starts a thread the user asks for without the coordinator, and tells it with the next wake', async () => {
		const { hub, prompts, started } = setup();
		const id = await hub.startThread('Loader state', 'Show the loader');
		expect(id).toBe('t1');
		expect(started).toEqual([{ title: 'Loader state', brief: 'Show the loader', planFirst: false, byCoordinator: false }]);
		expect(prompts).toHaveLength(0);
		hub.post('What is running?');
		await hub.idle();
		expect(prompts[0]).toContain('t1 "Loader state": starting (started by the user)');
		expect(prompts[0]).toContain('<event kind="started" thread="t1">');
	});

	it('passes the branch and model picked in the New thread dialog to the thread', async () => {
		const { hub, started } = setup();
		await hub.startThread('Review MR', 'Review it', true, { branch: 'gemini/review-mr', model: 'gemini-3.1-pro' });
		expect(started).toEqual([{ title: 'Review MR', brief: 'Review it', planFirst: true, byCoordinator: false, branch: 'gemini/review-mr', model: 'gemini-3.1-pro' }]);
	});

	it('runs start_thread for the coordinator and returns at once', async () => {
		const { hub, started, feed } = setup();
		const result = await hub.call(coordinator, 'start_thread', { title: 'Mobile sizes', brief: 'Make the panel 85vh', planFirst: true });
		expect(result).toEqual({ content: [{ type: 'text', text: 'Started thread t1.' }] });
		expect(started[0]).toEqual({ title: 'Mobile sizes', brief: 'Make the panel 85vh', planFirst: true, byCoordinator: true });
		expect(hub.threadList[0]).toMatchObject({ id: 't1', state: 'starting', byCoordinator: true });
		expect(feed.at(-1)).toMatchObject({ kind: 'thread', thread: 't1' });
	});

	it('takes a Conductor track as the brief', async () => {
		const { hub, started } = setup();
		(hub as unknown as { context: object }).context = { trackBrief: async (track: string) => track === 'dark-mode' ? 'Spec: a toggle' : undefined };
		await hub.call(coordinator, 'start_thread', { title: 'Dark mode', brief: '', track: 'dark-mode' });
		expect(started[0].brief).toBe('Spec: a toggle');
		expect((await hub.call(coordinator, 'start_thread', { title: 'X', brief: 'y', track: 'nope' })).isError).toBe(true);
	});

	it('relays, lists, reads and posts', async () => {
		const { hub, messages, feed } = setup();
		await hub.call(coordinator, 'start_thread', { title: 'A', brief: 'b' });
		await hub.call(coordinator, 'message_thread', { thread: 't1', text: 'Keep 300 ms' });
		expect(messages).toEqual([['t1', 'Keep 300 ms']]);
		expect((await hub.call(coordinator, 'message_thread', { thread: 't9', text: 'x' })).isError).toBe(true);
		expect((await hub.call(coordinator, 'list_threads', {})).content[0]).toMatchObject({ text: '- t1 "A": starting' });
		expect((await hub.call(coordinator, 'read_thread', { thread: 't1' })).content[0]).toMatchObject({ text: 'messages of t1' });
		await hub.call(coordinator, 'post', { text: 'Started A.' });
		expect(feed.at(-1)).toMatchObject({ kind: 'coordinator', text: 'Started A.' });
	});

	it('wakes on a report but not on a thread\'s own progress', async () => {
		const { hub, prompts } = setup();
		await hub.call(coordinator, 'start_thread', { title: 'A', brief: 'b' });
		hub.updateThread('t1', { state: 'done' });
		hub.notify({ kind: 'threadUser', thread: 't1', text: 'looks good' });
		expect(prompts).toHaveLength(0);
		await hub.call({ role: 'thread', project: 'p1', thread: 't1' }, 'report', { kind: 'result', text: 'Build passes.' });
		await hub.idle();
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain('<event kind="thread-user" thread="t1">');
		expect(prompts[0]).toContain('<event kind="report" thread="t1" report="result">\nBuild passes.\n</event>');
	});

	it('keeps a thread to its own tools and project', async () => {
		const { hub } = setup();
		expect((await hub.call({ role: 'thread', project: 'p1', thread: 't1' }, 'start_thread', { title: 'a', brief: 'b' })).isError).toBe(true);
		expect((await hub.call({ role: 'coordinator', project: 'other' }, 'post', { text: 'x' })).isError).toBe(true);
	});

	it('reports a failed coordinator turn in the chat and keeps going', async () => {
		const { hub, feed, prompts } = setup(async prompt => {
			if (prompt.includes('boom')) {
				throw new Error('quota');
			}
		});
		hub.post('boom');
		await hub.idle();
		expect(feed.at(-1)).toMatchObject({ kind: 'coordinator', text: 'The coordinator could not answer: quota' });
		hub.post('again');
		await hub.idle();
		expect(prompts).toHaveLength(2);
	});
});
