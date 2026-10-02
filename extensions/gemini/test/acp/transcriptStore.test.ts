/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatTranscript, TranscriptItem } from '../../src/acp/chatTranscript';
import { TranscriptStore } from '../../src/acp/transcriptStore';

describe('TranscriptStore', () => {
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
	});

	async function store() {
		const dir = await mkdtemp(path.join(tmpdir(), 'transcripts-'));
		dirs.push(dir);
		return { dir, store: new TranscriptStore(path.join(dir, 'agents')) };
	}

	it('gives back what was saved', async () => {
		const { store: s } = await store();
		const items: TranscriptItem[] = [
			{ id: 'item-0', kind: 'user', text: 'hi', attachments: [{ kind: 'file', label: 'a.ts', path: '/a.ts' }] },
			{ id: 'item-1', kind: 'agent', text: 'hello' },
			{ id: 'tool-1', kind: 'toolCall', title: 'Read a.ts', toolKind: 'read', status: 'completed', locations: [{ path: '/a.ts' }], details: [] },
		];
		await s.save('a1', items);
		expect(await s.load('a1')).toEqual(items);
		expect(await s.load('other')).toEqual([]);
	});

	it('settles requests and tool calls that were still open', async () => {
		const { store: s } = await store();
		void s.save('a1', [
			{ id: 'p1', kind: 'permission', title: 'Write', options: [], diffPaths: [] },
			{ id: 'tool-1', kind: 'toolCall', title: 'Edit', toolKind: 'edit', status: 'in_progress', locations: [], details: [] },
		]);
		// Loading waits for the save.
		expect(await s.load('a1')).toMatchObject([{ answer: { kind: 'cancelled' } }, { status: 'failed' }]);
	});

	it('keeps the last items and cuts long text', async () => {
		const { store: s } = await store();
		const items: TranscriptItem[] = Array.from({ length: 400 }, (_, i) => ({ id: `item-${i}`, kind: 'agent', text: i === 399 ? 'x'.repeat(30_000) : `m${i}` }));
		await s.save('a1', items);
		const loaded = await s.load('a1');
		expect(loaded).toHaveLength(300);
		expect(loaded[0].id).toBe('item-100');
		expect((loaded.at(-1) as { text: string }).text.length).toBe(20_001);
	});

	it('ignores unreadable files and bad items', async () => {
		const { dir, store: s } = await store();
		await s.save('a1', []);
		await writeFile(path.join(dir, 'agents', 'a1.json'), '{not json');
		expect(await s.load('a1')).toEqual([]);
		await writeFile(path.join(dir, 'agents', 'a1.json'), JSON.stringify({ version: 1, items: [{ id: 'x', kind: 'agent', text: 'ok' }, { id: 'y', kind: 'agent' }, null] }));
		expect(await s.load('a1')).toEqual([{ id: 'x', kind: 'agent', text: 'ok' }]);
	});

	it('deletes an agent\'s conversation', async () => {
		const { store: s } = await store();
		await s.save('a1', [{ id: 'item-0', kind: 'agent', text: 'hi' }]);
		await s.delete('a1');
		expect(await s.load('a1')).toEqual([]);
	});
});

describe('ChatTranscript.restore', () => {
	it('shows saved items and numbers new ones after them', () => {
		const transcript = new ChatTranscript();
		let resets = 0;
		transcript.onDidReset(() => resets++);
		transcript.restore([{ id: 'item-7', kind: 'user', text: 'hi' }, { id: 'tool-x', kind: 'toolCall', title: 't', toolKind: undefined, status: 'completed', locations: [], details: [] }]);
		transcript.addNotice('later');
		expect(resets).toBe(1);
		expect(transcript.items.map(i => i.id)).toEqual(['item-7', 'tool-x', 'item-8']);
	});

	it('starts a new message after the restored ones', () => {
		const transcript = new ChatTranscript();
		transcript.restore([{ id: 'item-0', kind: 'agent', text: 'old' }]);
		transcript.addPrompt('again');
		transcript.apply({ kind: 'text', role: 'agent', text: 'new' });
		expect(transcript.items.map(i => i.kind === 'agent' || i.kind === 'user' ? i.text : '')).toEqual(['old', 'again', 'new']);
	});
});
