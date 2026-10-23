/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { carriedConversationNote, chatsFolder, findCliSession, isPassingFailure, listCliSessions, parseSessionFile, readCliConversation, readCliSession, readSessionContext, readSessionTokens, reopenFailure, replayUpdateCount, rewindCliSession } from '../../src/acp/cliSessions';

/** Written by gemini-cli 0.62 for `gemini -p "Fix the rounding in the cart total"`, paths changed. */
const terminalSession = readFileSync(path.join(__dirname, '..', 'fixtures', 'cli-sessions', 'session-terminal.jsonl'), 'utf8');

const line = (value: unknown) => JSON.stringify(value);

describe('parseSessionFile', () => {
	it('reads a session the CLI saved, skipping the context it adds', () => {
		expect(parseSessionFile(terminalSession, false)).toEqual({
			id: 'c3c021c6-b0e9-4063-8835-6d223ea326ee',
			title: 'Fix the rounding in the cart total',
			prompts: ['Fix the rounding in the cart total'],
			resumable: true,
			startedAt: Date.parse('2026-10-05T10:27:08.057Z'),
			updatedAt: Date.parse('2026-10-05T10:27:08.130Z'),
			// The context the CLI adds and the prompt, then the reply.
			replayUpdates: 3,
			tokens: { context: 1, model: 'gemini-2.5-flash', cached: 0 },
		});
	});

	it('prefers the summary, and drops messages a rewind took back', () => {
		const text = [
			line({ sessionId: 's1', projectHash: 'h', startTime: '2026-10-01T09:00:00.000Z', lastUpdated: '2026-10-01T09:00:00.000Z' }),
			line({ id: 'm1', type: 'user', content: [{ text: 'first' }] }),
			line({ id: 'm2', type: 'gemini', content: 'ok' }),
			line({ id: 'm3', type: 'user', content: 'second' }),
			line({ $rewindTo: 'm3' }),
			line({ $set: { summary: 'Tidy the tests', lastUpdated: '2026-10-01T10:00:00.000Z' } }),
			'{"id": "cut short',
		].join('\n');
		expect(parseSessionFile(text, false)).toMatchObject({ id: 's1', title: 'Tidy the tests', prompts: ['first'], updatedAt: Date.parse('2026-10-01T10:00:00.000Z') });
	});

	it('applies the patches gemini-cli 0.64 writes: new content, removed messages and a new order', () => {
		const text = [
			line({ sessionId: 's9', projectHash: 'h' }),
			line({ id: 'u1', type: 'user', content: 'first' }),
			line({ id: 'g1', type: 'gemini', content: 'one' }),
			line({ id: 'u2', type: 'user', content: 'second' }),
			line({ id: 'g2', type: 'gemini', content: '', toolCalls: [{ id: 't1' }] }),
			line({ $patch: { updates: [{ id: 'g2', toolCalls: [{ id: 't1', result: [] }] }, { id: 'u2', content: [{ text: 'second, edited' }] }] } }),
			line({ $patch: { id: 'g1', content: 'one, edited' } }),
			line({ $patch: { removeIds: ['u1', 'missing'], orderIds: ['g2', 'u2'] } }),
		].join('\n');
		expect(parseSessionFile(text, false)).toMatchObject({ prompts: ['second, edited'], title: 'second, edited', replayUpdates: 3 });
	});

	it('reads the older one-object files', () => {
		const text = JSON.stringify({ sessionId: 's2', projectHash: 'h', lastUpdated: '2026-09-01T00:00:00.000Z', messages: [{ id: 'a', type: 'user', content: 'Add a test\nfor the cart' }] }, null, 2);
		expect(parseSessionFile(text, true)).toMatchObject({ id: 's2', title: 'Add a test', prompts: ['Add a test\nfor the cart'] });
	});

	it('counts what the CLI would resume, and leaves out subagents', () => {
		expect(parseSessionFile(line({ sessionId: 's3', projectHash: 'h' }), false)).toMatchObject({ resumable: false, prompts: [] });
		expect(parseSessionFile([line({ sessionId: 's4', projectHash: 'h' }), line({ id: 'a', type: 'user', content: '/help' })].join('\n'), false)).toMatchObject({ resumable: false });
		expect(parseSessionFile([line({ sessionId: 's4', projectHash: 'h' }), line({ id: 'a', type: 'gemini', content: '', toolCalls: [{}] })].join('\n'), false)).toMatchObject({ resumable: true, prompts: [] });
		expect(parseSessionFile([line({ sessionId: 's5', projectHash: 'h', kind: 'subagent' }), line({ id: 'a', type: 'user', content: 'go' })].join('\n'), false)).toBeUndefined();
		expect(parseSessionFile('not json', true)).toBeUndefined();
	});

	it('takes the context from the latest reply, and sums the cached tokens', () => {
		const text = [
			line({ sessionId: 's7', projectHash: 'h' }),
			line({ id: 'a', type: 'user', content: 'go' }),
			line({ id: 'b', type: 'gemini', content: 'one', model: 'gemini-3.5-pro', tokens: { input: 1000, output: 10, cached: 400, total: 1010 } }),
			line({ id: 'c', type: 'gemini', content: 'two', model: 'gemini-3.8-flash', tokens: { input: 1500, output: 20, cached: 900, total: 1520 } }),
			line({ id: 'd', type: 'gemini', content: 'no counts' }),
		].join('\n');
		expect(parseSessionFile(text, false)?.tokens).toEqual({ context: 1500, model: 'gemini-3.8-flash', cached: 1300 });
		expect(parseSessionFile([line({ sessionId: 's8', projectHash: 'h' }), line({ id: 'a', type: 'user', content: 'go' })].join('\n'), false)?.tokens).toBeUndefined();
	});

	it('shortens long titles to one line', () => {
		const session = parseSessionFile([line({ sessionId: 's6', projectHash: 'h' }), line({ id: 'a', type: 'user', content: 'x'.repeat(200) })].join('\n'), false);
		expect(session?.title).toHaveLength(80);
		expect(session?.title.endsWith('…')).toBe(true);
	});
});

describe('listCliSessions', () => {
	let home: string | undefined;

	afterEach(() => {
		if (home) {
			rmSync(home, { recursive: true, force: true });
		}
	});

	function saveSession(chats: string, name: string, id: string, prompt: string, updated: string): void {
		mkdirSync(chats, { recursive: true });
		const file = path.join(chats, name);
		writeFileSync(file, [line({ sessionId: id, projectHash: 'h', startTime: updated, lastUpdated: updated }), line({ id: 'm', type: 'user', content: prompt })].join('\n'));
		utimesSync(file, new Date(updated), new Date(updated));
	}

	it('finds the folder through the CLI project registry, newest first, without excluded sessions', async () => {
		home = mkdtempSync(path.join(tmpdir(), 'cli-home-'));
		const work = path.join(home, 'work', 'shop');
		writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { [work]: 'shop' } }));
		const chats = path.join(home, 'tmp', 'shop', 'chats');
		saveSession(chats, 'session-a.jsonl', 'old', 'Older task', '2026-10-01T00:00:00.000Z');
		saveSession(chats, 'session-b.jsonl', 'new', 'Newer task', '2026-10-04T00:00:00.000Z');
		saveSession(chats, 'session-c.jsonl', 'mine', 'Open in an agent', '2026-10-05T00:00:00.000Z');
		writeFileSync(path.join(chats, 'notes.txt'), 'ignored');
		expect(await chatsFolder(work, home)).toBe(chats);
		const sessions = await listCliSessions(work, { home, exclude: new Set(['mine']) });
		expect(sessions.map(s => s.title)).toEqual(['Newer task', 'Older task']);
	});

	it('numbers sessions as the CLI does: by start, counting only what it would offer', async () => {
		home = mkdtempSync(path.join(tmpdir(), 'cli-home-'));
		const work = path.join(home, 'shop');
		writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { [work]: 'shop' } }));
		const chats = path.join(home, 'tmp', 'shop', 'chats');
		saveSession(chats, 'session-3.jsonl', 'third', 'Third', '2026-10-03T00:00:00.000Z');
		saveSession(chats, 'session-1.jsonl', 'first', 'First', '2026-10-01T00:00:00.000Z');
		saveSession(chats, 'session-2.jsonl', 'empty', '/help', '2026-10-02T00:00:00.000Z');
		// A later file for the first session, as the CLI writes when a session moves on.
		saveSession(chats, 'session-4.jsonl', 'first', 'First', '2026-10-04T00:00:00.000Z');
		expect(await findCliSession(work, 'first', home)).toMatchObject({ index: 2, firstPrompt: 'First' });
		expect(await findCliSession(work, 'third', home)).toMatchObject({ index: 1 });
		expect(await findCliSession(work, 'empty', home)).toBeUndefined();
	});

	it('reads one session by its id, with its replay length and conversation, from its own files only', async () => {
		home = mkdtempSync(path.join(tmpdir(), 'cli-home-'));
		const work = path.join(home, 'shop');
		writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { [work]: 'shop' } }));
		const chats = path.join(home, 'tmp', 'shop', 'chats');
		mkdirSync(chats, { recursive: true });
		writeFileSync(path.join(chats, 'session-2026-10-01T09-00-abcdef12.jsonl'), [
			line({ sessionId: 'abcdef12-0000', projectHash: 'h', startTime: '2026-10-01T09:00:00.000Z' }),
			line({ id: 'm1', type: 'user', content: [{ text: '<session_context>ctx</session_context>' }] }),
			line({ id: 'm2', type: 'user', content: [{ text: 'Fix the cart' }] }),
			line({ id: 'm3', type: 'gemini', content: [{ text: 'Done.' }], thoughts: [{ subject: 'a', description: 'b' }], toolCalls: [{ id: 't1', name: 'replace' }] }),
			line({ id: 'm4', type: 'user', content: [{ functionResponse: { name: 'replace' } }] }),
		].join('\n'));
		// Another session's file is not read.
		writeFileSync(path.join(chats, 'session-2026-10-01T09-00-99999999.jsonl'), '{not json');
		expect(await readCliSession(work, 'abcdef12-0000', home)).toEqual({ firstPrompt: 'Fix the cart', replayUpdates: 6 });
		expect(await readCliSession(work, 'abcdef12-other', home)).toBeUndefined();
		const conversation = await readCliConversation(work, 'abcdef12-0000', home);
		expect(conversation).toEqual([{ role: 'user', text: 'Fix the cart' }, { role: 'model', text: 'Done.' }]);
		expect(carriedConversationNote('Cart', conversation!)).toContain('User: Fix the cart\n\nYou: Done.');
	});

	it('carries a session whose tool output overflowed the context without that output', async () => {
		home = mkdtempSync(path.join(tmpdir(), 'cli-home-'));
		const work = path.join(home, 'shop');
		writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { [work]: 'shop' } }));
		const chats = path.join(home, 'tmp', 'shop', 'chats');
		mkdirSync(chats, { recursive: true });
		// As gemini-cli 0.64 saved the review that failed: the diff is in the tool call's result and in the response.
		const diff = `Output: ${'+ a changed line\n'.repeat(250_000)}`;
		writeFileSync(path.join(chats, 'session-2026-10-20T05-35-abcdef12.jsonl'), [
			line({ sessionId: 'abcdef12-0000', projectHash: 'h', startTime: '2026-10-20T05:35:00.000Z', kind: 'main' }),
			line({ id: 'u1', type: 'user', content: [{ text: 'Review merge request !706' }] }),
			line({ id: 'g1', type: 'gemini', content: '', toolCalls: [{ id: 't1', name: 'run_shell_command', result: [{ functionResponse: { name: 'run_shell_command', response: { output: diff } } }] }] }),
			line({ id: 'u2', type: 'user', content: [{ functionResponse: { name: 'run_shell_command', response: { output: diff } } }] }),
		].join('\n'));
		const note = carriedConversationNote('this chat', (await readCliConversation(work, 'abcdef12-0000', home))!);
		expect({ prompt: note.includes('User: Review merge request !706'), diff: note.includes('a changed line'), short: note.length < 1000 }).toEqual({ prompt: true, diff: false, short: true });
	});

	it('rewinds a session to before a prompt with the record /rewind writes, counting repeats from the end', async () => {
		home = mkdtempSync(path.join(tmpdir(), 'cli-home-'));
		const work = path.join(home, 'shop');
		writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { [work]: 'shop' } }));
		const chats = path.join(home, 'tmp', 'shop', 'chats');
		mkdirSync(chats, { recursive: true });
		const file = path.join(chats, 'session-2026-10-01T09-00-abcdef12.jsonl');
		writeFileSync(file, [
			line({ sessionId: 'abcdef12-0000', projectHash: 'h', startTime: '2026-10-01T09:00:00.000Z' }),
			line({ id: 'u1', type: 'user', content: [{ text: 'Try again' }] }),
			line({ id: 'g1', type: 'gemini', content: [{ text: 'Done.' }] }),
			line({ id: 'u2', type: 'user', content: [{ text: '[Shared page: Cart]\n\nTry   again' }] }),
			line({ id: 'g2', type: 'gemini', content: [{ text: 'Done again.' }] }),
		].join('\n') + '\n');
		expect(await rewindCliSession(work, 'abcdef12-0000', 'Try again', 1, home)).toBe(true);
		expect(readFileSync(file, 'utf8').trim().split('\n').at(-1)).toBe(JSON.stringify({ $rewindTo: 'u1' }));
		expect(await readCliConversation(work, 'abcdef12-0000', home)).toEqual([]);
		expect(await rewindCliSession(work, 'abcdef12-0000', 'Not said', 0, home)).toBe(false);
		expect(await rewindCliSession(work, 'other', 'Try again', 0, home)).toBe(false);
	});

	it('falls back to the older hashed folder, and is empty when the CLI never ran there', async () => {
		home = mkdtempSync(path.join(tmpdir(), 'cli-home-'));
		const work = path.join(home, 'legacy');
		const hashed = createHash('sha256').update(work).digest('hex');
		saveSession(path.join(home, 'tmp', hashed, 'chats'), 'session-x.json', 'legacy', 'From before', '2026-08-01T00:00:00.000Z');
		expect((await listCliSessions(work, { home })).map(s => s.id)).toEqual(['legacy']);
		expect(await listCliSessions(path.join(home, 'elsewhere'), { home })).toEqual([]);
	});

	it('reads a session\'s token counts from its own file, by id', async () => {
		home = mkdtempSync(path.join(tmpdir(), 'cli-home-'));
		const work = path.join(home, 'shop');
		writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { [work]: 'shop' } }));
		const chats = path.join(home, 'tmp', 'shop', 'chats');
		mkdirSync(chats, { recursive: true });
		const id = 'abcd1234-0000-4000-8000-000000000000';
		writeFileSync(path.join(chats, 'session-2026-10-08T10-00-abcd1234.jsonl'), [
			line({ sessionId: id, projectHash: 'h' }),
			line({ id: 'a', type: 'user', content: 'go' }),
			line({ id: 'b', type: 'gemini', content: 'done', model: 'gemini-3.8-flash', tokens: { input: 124_300, cached: 80_000 } }),
		].join('\n'));
		saveSession(chats, 'session-2026-10-08T09-00-other000.jsonl', 'other000-0000', 'Other', '2026-10-08T09:00:00.000Z');
		expect(await readSessionTokens(work, id, home)).toEqual({ context: 124_300, model: 'gemini-3.8-flash', cached: 80_000 });
		expect(await readSessionTokens(work, 'other000-0000', home)).toBeUndefined();
		expect(await readSessionTokens(work, 'missing0-0000', home)).toBeUndefined();
		expect(await readSessionContext(work, id, home)).toEqual({ tokens: { context: 124_300, model: 'gemini-3.8-flash', cached: 80_000 }, prompts: 1 });
		expect(await readSessionContext(work, 'missing0-0000', home)).toBeUndefined();
	});

	it('reads only what the CLI appended to a session file, and the whole file again after a rewrite', async () => {
		home = mkdtempSync(path.join(tmpdir(), 'cli-home-'));
		const work = path.join(home, 'shop');
		writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { [work]: 'shop' } }));
		const chats = path.join(home, 'tmp', 'shop', 'chats');
		mkdirSync(chats, { recursive: true });
		const id = 'feed1234-0000-4000-8000-000000000000';
		const file = path.join(chats, 'session-2026-10-08T10-00-feed1234.jsonl');
		const reply = (n: number, input: number) => line({ id: `r${n}`, type: 'gemini', content: `reply ${n}`, model: 'm', tokens: { input, cached: 10 } });
		writeFileSync(file, [line({ sessionId: id, projectHash: 'h' }), line({ id: 'u1', type: 'user', content: 'go' }), reply(1, 100)].join('\n') + '\n');
		expect(await readSessionTokens(work, id, home)).toEqual({ context: 100, model: 'm', cached: 10 });
		// Appended, the last line without its line end yet.
		appendFileSync(file, [line({ id: 'u2', type: 'user', content: 'more' }), reply(2, 250)].join('\n'));
		expect(await readSessionTokens(work, id, home)).toEqual({ context: 250, model: 'm', cached: 20 });
		appendFileSync(file, '\n' + line({ $rewindTo: 'u2' }) + '\n');
		expect(await readSessionTokens(work, id, home)).toEqual({ context: 100, model: 'm', cached: 10 });
		expect((await readCliSession(work, id, home))?.firstPrompt).toBe('go');
		// Rewritten from the start, longer than before: read whole again.
		writeFileSync(file, [line({ sessionId: id, projectHash: 'h' }), line({ id: 'x1', type: 'user', content: 'a different start that is long enough' }), reply(9, 900), reply(10, 950)].join('\n') + '\n');
		expect(await readSessionTokens(work, id, home)).toEqual({ context: 950, model: 'm', cached: 20 });
		expect((await readCliSession(work, id, home))?.firstPrompt).toBe('a different start that is long enough');
	});
});

describe('replayUpdateCount', () => {
	it('counts what gemini-cli replays: user messages with any part, and each model message\'s thoughts, text and tool calls', () => {
		expect(replayUpdateCount([
			{ type: 'user', content: '  ' },
			{ type: 'user', content: [{ text: 'Hi' }] },
			{ type: 'user', content: [{ inlineData: { mimeType: 'image/png', data: '' } }] },
			{ type: 'gemini', content: [], toolCalls: [{}, {}] },
			{ type: 'gemini', content: [{ text: ' ' }], thoughts: [{}] },
			{ type: 'gemini', content: [{ thought: true, text: 'x' }] },
			{ type: 'info', content: 'not replayed' },
		])).toBe(6);
	});
});

describe('reopenFailure', () => {
	it('tells why a saved session could not be reopened, and which failures pass', () => {
		const failures = [
			{ kind: 'auth-required' as const, message: 'Authentication required' },
			{ kind: 'agent-exited' as const, message: 'The agent exited' },
			{ kind: 'unknown' as const, message: 'Agent is not ready' },
			{ kind: 'unknown' as const, message: 'Another chat has that session open.' },
			{ kind: 'unknown' as const, message: 'ENOENT: no such file' },
			{ kind: 'unknown' as const, message: 'The agent opened a different session' },
			{ kind: 'unknown' as const, message: 'Something else' },
		];
		expect(failures.map(failure => [reopenFailure(failure), isPassingFailure(failure)])).toEqual([
			['signedOut', false], ['restarted', true], ['restarted', true], ['inUse', false], ['gone', false], ['otherSession', false], ['other', false],
		]);
	});
});
