/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findCliSession, MessageRecord, projectHash, readSessionMessages } from '../../src/acp/cliSessions';
import { compactedMessages, compactSplit, estimateTokens, messagesBefore, sessionFileName, writeSessionCopy } from '../../src/acp/sessionSnapshot';

const user = (id: string, text: string): MessageRecord => ({ id, type: 'user', content: [{ text }] });
const reply = (id: string, text: string, result = ''): MessageRecord => ({ id, type: 'gemini', content: text, thoughts: [{ description: 'x'.repeat(400) }], ...(result ? { toolCalls: [{ id: `${id}-t`, name: 'read_file', args: {}, result }] } : {}) });

/** The CLI's context, then four prompts; the last two have large tool output. */
const session: MessageRecord[] = [
	user('c', '<session_context>\nfolders\n</session_context>'),
	user('u1', 'Plan the refund flow'), reply('g1', 'Plan: API, tests, UI.'),
	user('u2', 'Do the API'), reply('g2', 'Done the API.', 'a'.repeat(400)),
	user('u3', 'Do the tests'), reply('g3', 'Done the tests.', 'b'.repeat(4000)),
	user('u4', 'Do the UI'), reply('g4', 'Done the UI.', 'c'.repeat(200)),
];

describe('messagesBefore', () => {
	it('cuts before a prompt found by its text, counting repeats from the end', () => {
		const repeated = [...session, user('u5', 'Do the API'), reply('g5', 'Again.')];
		expect(messagesBefore(repeated, 'Do  the API', 0)?.map(m => m.id).at(-1)).toBe('g4');
		expect(messagesBefore(repeated, 'Do the API', 1)?.map(m => m.id).at(-1)).toBe('g1');
		expect(messagesBefore(repeated, 'Not a prompt', 0)).toBeUndefined();
	});
});

describe('compactSplit', () => {
	it('keeps the latest prompts that fit in the share, never everything, and none when the latest alone is too big', () => {
		// u4 and its reply fit in 30%; u3 brings the large output.
		expect(compactSplit(session)).toBe(7);
		// With room for all, it still leaves the first prompt to summarize.
		expect(compactSplit(session, 4, 1)).toBe(3);
		expect(compactSplit(session, 1, 1)).toBe(7);
		expect(compactSplit([...session, user('u5', 'Huge'), reply('g5', '', 'd'.repeat(50_000))])).toBe(11);
	});
});

describe('compactedMessages', () => {
	it('puts the summary and an acknowledgement before the kept messages, without the old session context', () => {
		const compacted = compactedMessages(session, 'Refund API and tests done.', 7, new Date('2026-10-23T10:00:00.000Z'));
		expect(compacted.map(m => [m.type, m.id.length === 36 ? 'new' : m.id])).toEqual([['user', 'new'], ['gemini', 'new'], ['user', 'u4'], ['gemini', 'g4']]);
		expect(JSON.stringify(compacted[0].content)).toContain('<summary_of_earlier_work>\\nRefund API and tests done.\\n</summary_of_earlier_work>');
		expect(compacted[0].timestamp).toBe('2026-10-23T10:00:00.000Z');
		// The kept messages' token counts described the whole session, so they go.
		expect(compactedMessages([...session.slice(0, 7), user('u4', 'Do the UI'), { ...reply('g4', 'Done.'), tokens: { input: 650_000 } }], 'S', 7).at(-1)).not.toHaveProperty('tokens');
	});

	it('is much smaller than the session it compacts', () => {
		expect(estimateTokens(session)).toBe(Math.round((
			'<session_context>\nfolders\n</session_context>'.length + 'Plan the refund flow'.length + 'Plan: API, tests, UI.'.length
			+ 'Do the API'.length + 'Done the API.'.length + 2 + 402 + 'Do the tests'.length + 'Done the tests.'.length + 2 + 4002
			+ 'Do the UI'.length + 'Done the UI.'.length + 2 + 202) / 4));
		expect(estimateTokens(compactedMessages(session, 'Short summary.', compactSplit(session)))).toBeLessThan(estimateTokens(session) / 5);
	});
});

describe('writeSessionCopy', () => {
	let home: string | undefined;

	afterEach(() => {
		if (home) {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it('writes a new session where the CLI keeps the folder\'s sessions, which reads back as the same messages', async () => {
		home = mkdtempSync(path.join(tmpdir(), 'cli-home-'));
		const fork = path.join(home, 'work', 'shop-fork');
		await expect(writeSessionCopy(fork, session, { home })).rejects.toThrow(/has not opened a session/);
		writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { [fork]: 'shop-fork' } }));
		const now = new Date('2026-10-23T10:05:30.000Z');
		const id = await writeSessionCopy(fork, session, { home, now });
		const chats = path.join(home, 'tmp', 'shop-fork', 'chats');
		expect(readdirSync(chats)).toEqual([sessionFileName(id, now)]);
		expect(sessionFileName(id, now)).toBe(`session-2026-10-23T10-05-${id.slice(0, 8)}.jsonl`);
		expect(JSON.parse(readFileSync(path.join(chats, sessionFileName(id, now)), 'utf8').split('\n')[0])).toEqual({ sessionId: id, projectHash: projectHash(fork), startTime: now.toISOString(), lastUpdated: now.toISOString(), kind: 'main' });
		expect((await readSessionMessages(fork, id, home))?.messages).toEqual(session);
		expect(await findCliSession(fork, id, home)).toMatchObject({ id, messages: 4 });
	});
});
