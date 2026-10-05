/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chatsFolder, findCliSession, listCliSessions, parseSessionFile } from '../../src/acp/cliSessions';

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

	it('falls back to the older hashed folder, and is empty when the CLI never ran there', async () => {
		home = mkdtempSync(path.join(tmpdir(), 'cli-home-'));
		const work = path.join(home, 'legacy');
		const hashed = createHash('sha256').update(work).digest('hex');
		saveSession(path.join(home, 'tmp', hashed, 'chats'), 'session-x.json', 'legacy', 'From before', '2026-08-01T00:00:00.000Z');
		expect((await listCliSessions(work, { home })).map(s => s.id)).toEqual(['legacy']);
		expect(await listCliSessions(path.join(home, 'elsewhere'), { home })).toEqual([]);
	});
});
