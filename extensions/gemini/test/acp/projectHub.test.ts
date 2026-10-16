/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { coordinatorBrief, listedMergedThreads, multiRepoBrief, ProjectHub, threadMemoryContext, wakeThreadLines, type CoordinatorSession, type FeedEntry, type ThreadDriver, type ThreadInfo } from '../../src/acp/projectHub';

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
		message: (thread, text) => { messages.push([thread, text]); },
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

	it('wakes only on the user\'s message, carrying the threads\' reports and progress as context', async () => {
		const { hub, prompts } = setup();
		await hub.call(coordinator, 'start_thread', { title: 'A', brief: 'b' });
		hub.updateThread('t1', { state: 'done' });
		hub.notify({ kind: 'threadUser', thread: 't1', text: 'looks good' });
		await hub.call({ role: 'thread', project: 'p1', thread: 't1' }, 'report', { kind: 'result', text: 'Build passes.' });
		hub.notify({ kind: 'failed', thread: 't1', text: 'crashed' });
		await hub.idle();
		expect(prompts).toHaveLength(0);
		hub.post('What next?');
		await hub.idle();
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain('<event kind="thread-user" thread="t1">');
		expect(prompts[0]).toContain('<event kind="report" thread="t1" report="result">\nBuild passes.\n</event>');
	});

	it('sends follow-ups to a done thread, but to a resolved one only when reopened', async () => {
		const { hub, messages } = setup();
		await hub.call(coordinator, 'start_thread', { title: 'A', brief: 'b' });
		hub.updateThread('t1', { state: 'done' });
		expect((await hub.call(coordinator, 'message_thread', { thread: 't1', text: 'Add the menu too' })).isError).toBeFalsy();
		hub.updateThread('t1', { resolved: true });
		expect((await hub.call(coordinator, 'list_threads', {})).content[0]).toMatchObject({ text: '- t1 "A": resolved (merged)' });
		const refused = await hub.call(coordinator, 'message_thread', { thread: 't1', text: 'More' });
		expect(refused.isError).toBe(true);
		expect(refused.content[0]).toMatchObject({ text: expect.stringContaining('Start a new thread') });
		expect((await hub.call(coordinator, 'message_thread', { thread: 't1', text: 'Reopen it', reopen: true })).isError).toBeFalsy();
		expect(messages).toEqual([['t1', 'Add the menu too'], ['t1', 'Reopen it']]);
		expect((await hub.call(coordinator, 'list_threads', {})).content[0]).toMatchObject({ text: '- t1 "A": done' });
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

	it('sends the notes again only when they change', async () => {
		let memory = 'Use pnpm.';
		const prompts: string[] = [];
		const hub = new ProjectHub('p1', { prompt: async text => { prompts.push(text); } }, { start: async () => 't1', message: () => undefined, read: () => '' }, { memory: async () => memory });
		hub.post('one');
		await hub.idle();
		hub.post('two');
		await hub.idle();
		memory = 'Use npm.';
		hub.memoryChanged();
		hub.post('three');
		await hub.idle();
		expect(prompts[0]).toContain('<notes>\nUse pnpm.\n</notes>');
		expect(prompts[1]).not.toContain('<notes>');
		expect(prompts[2]).toContain('<notes>\nUse npm.\n</notes>');
	});
});

describe('a project with many threads', () => {
	const many = (open: number, merged: number): ThreadInfo[] => [
		...Array.from({ length: merged }, (_, i) => ({ id: `m${i}`, title: `Merged ${i}`, state: 'done' as const, byCoordinator: true, resolved: true })),
		...Array.from({ length: open }, (_, i) => ({ id: `o${i}`, title: `Open ${i}`, state: 'done' as const, byCoordinator: true })),
	];

	it('lists every open thread and only the latest merged ones in each wake', () => {
		const lines = wakeThreadLines(many(3, 25));
		expect(lines).toHaveLength(3 + listedMergedThreads + 1);
		expect(lines.filter(line => line.includes('Open'))).toHaveLength(3);
		expect(lines).toContain('- m24 "Merged 24": resolved (merged)');
		expect(lines.some(line => line.includes('"Merged 14"'))).toBe(false);
		expect(lines.at(-1)).toBe('- 15 older merged threads not listed; list_threads with all: true lists them.');
		expect(wakeThreadLines(many(2, listedMergedThreads))).toHaveLength(2 + listedMergedThreads);
	});

	it('keeps the wake the same size however many threads were merged', async () => {
		const { hub, prompts } = setup();
		for (const thread of many(4, 500)) {
			hub.restoreThread(thread);
		}
		hub.post('What is open?');
		await hub.idle();
		const threads = prompts[0].slice(prompts[0].indexOf('<threads>'), prompts[0].indexOf('</threads>'));
		expect(threads.split('\n').filter(line => line.startsWith('- '))).toHaveLength(4 + listedMergedThreads + 1);
		const all = (await hub.call(coordinator, 'list_threads', { all: true })).content[0];
		expect(all).toMatchObject({ text: expect.stringContaining('"Merged 0"') });
		expect((await hub.call(coordinator, 'list_threads', {})).content[0]).toMatchObject({ text: expect.not.stringContaining('"Merged 0"') });
	});

	it('waits for a thread read from its saved chat, and for a note to a thread that has to start first', async () => {
		const sent: string[] = [];
		const hub = new ProjectHub('p1', { prompt: async () => { } }, {
			start: async () => 't1',
			message: async (_thread, text) => {
				await new Promise(resolve => setTimeout(resolve, 5));
				sent.push(text);
				return true;
			},
			read: async thread => `saved chat of ${thread}`,
		});
		hub.restoreThread({ id: 't1', title: 'A', state: 'done', byCoordinator: true });
		expect((await hub.call(coordinator, 'read_thread', { thread: 't1' })).content[0]).toMatchObject({ text: 'saved chat of t1' });
		expect((await hub.call(coordinator, 'message_thread', { thread: 't1', text: 'Also the footer' })).isError).toBeFalsy();
		expect(sent).toEqual(['Also the footer']);
	});
});

describe('ProjectHub with several repositories', () => {
	function multi() {
		const prompts: string[] = [];
		const started: { repos?: readonly string[] }[] = [];
		const added: [string, string][] = [];
		const driver: ThreadDriver = {
			start: async request => {
				started.push(request);
				return 't1';
			},
			message: () => undefined,
			read: () => '',
			addRepo: async (thread, repo) => {
				added.push([thread, repo]);
				return `Added ${repo}/.`;
			},
		};
		const hub = new ProjectHub('p1', { prompt: async text => { prompts.push(text); } }, driver, { repos: () => ['shop', 'cms'] });
		return { hub, prompts, started, added };
	}

	it('lists the repositories in each wake, and says how to choose them once', async () => {
		const { hub, prompts } = multi();
		hub.post('Add a gift message');
		await hub.idle();
		hub.post('And a promo');
		await hub.idle();
		expect(prompts[0]).toContain(multiRepoBrief);
		expect(prompts[0]).toContain('<repositories>\n- shop\n- cms\n</repositories>');
		expect(prompts[1]).not.toContain(multiRepoBrief);
		expect(prompts[1]).toContain('<repositories>');
	});

	it('starts a thread only in repositories it names, in the project\'s order', async () => {
		const { hub, started } = multi();
		expect((await hub.call(coordinator, 'start_thread', { title: 'Gift', brief: 'Add it' })).isError).toBe(true);
		expect((await hub.call(coordinator, 'start_thread', { title: 'Gift', brief: 'Add it', repos: ['web'] })).isError).toBe(true);
		expect((await hub.call(coordinator, 'start_thread', { title: 'Gift', brief: 'Add it', repos: ['cms', 'shop', 'cms'] })).isError).toBeFalsy();
		expect(started.map(request => request.repos)).toEqual([['shop', 'cms']]);
		expect((await hub.call(coordinator, 'list_threads', {})).content[0]).toMatchObject({ text: expect.stringContaining('[shop, cms]') });
	});

	it('adds a repository to a thread that asks', async () => {
		const { hub, added } = multi();
		await hub.call(coordinator, 'start_thread', { title: 'Promo', brief: 'End date', repos: ['cms'] });
		const thread = { role: 'thread', project: 'p1', thread: 't1' } as const;
		expect((await hub.call(thread, 'add_repo', { repo: 'web', reason: 'x' })).isError).toBe(true);
		expect(await hub.call(thread, 'add_repo', { repo: 'shop', reason: 'reads the end date' })).toMatchObject({ content: [{ text: 'Added shop/.' }] });
		expect(added).toEqual([['t1', 'shop']]);
		expect(hub.threadList[0].repos).toEqual(['cms', 'shop']);
	});

	it('gives a single-repository thread its memory as context', () => {
		expect(threadMemoryContext(' Use pnpm. ')).toContain('<project-memory>\nThe project\'s shared notes');
		expect(threadMemoryContext(' Use pnpm. ')).toMatch(/Use pnpm\.\n<\/project-memory>$/);
	});
});
