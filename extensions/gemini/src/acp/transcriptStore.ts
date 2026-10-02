/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Each agent's conversation as shown in its tab (plan Phase 2B, agent-resume),
// one JSON file per agent. The agent keeps its own history for `session/load`;
// this is only what the tab displays, so it is capped to stay small and fast
// to read: the last items, with long text cut.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { TranscriptItem } from './chatTranscript';

const formatVersion = 1;
const maxItems = 300;
const maxTextLength = 20_000;

interface StoredTranscript {
	readonly version: number;
	readonly items: readonly TranscriptItem[];
}

export class TranscriptStore {

	/** The last write per agent, so writes to one file never overlap. */
	private readonly writes = new Map<string, Promise<void>>();

	constructor(private readonly directory: string) { }

	/** The saved items, ready to show; empty when there are none or the file is unreadable. */
	async load(agentId: string): Promise<TranscriptItem[]> {
		await this.writes.get(agentId);
		try {
			const stored = JSON.parse(await readFile(this.file(agentId), 'utf8')) as StoredTranscript;
			return stored?.version === formatVersion && Array.isArray(stored.items) ? stored.items.filter(isTranscriptItem).map(settle) : [];
		} catch {
			return [];
		}
	}

	save(agentId: string, items: readonly TranscriptItem[]): Promise<void> {
		const stored: StoredTranscript = { version: formatVersion, items: items.slice(-maxItems).map(trim) };
		return this.enqueue(agentId, async () => {
			const file = this.file(agentId);
			await mkdir(this.directory, { recursive: true });
			// Write then rename, so a crash never leaves half a file.
			await writeFile(`${file}.tmp`, JSON.stringify(stored));
			await rename(`${file}.tmp`, file);
		});
	}

	delete(agentId: string): Promise<void> {
		return this.enqueue(agentId, () => rm(this.file(agentId), { force: true }));
	}

	private enqueue(agentId: string, write: () => Promise<void>): Promise<void> {
		const next = (this.writes.get(agentId) ?? Promise.resolve()).then(write).catch(() => undefined);
		this.writes.set(agentId, next);
		void next.then(() => {
			if (this.writes.get(agentId) === next) {
				this.writes.delete(agentId);
			}
		});
		return next;
	}

	private file(agentId: string): string {
		return path.join(this.directory, `${agentId.replace(/[^\w-]/g, '_')}.json`);
	}
}

function trim(item: TranscriptItem): TranscriptItem {
	switch (item.kind) {
		case 'user':
		case 'agent':
		case 'thought':
		case 'notice':
			return item.text.length > maxTextLength ? { ...item, text: `${item.text.slice(0, maxTextLength)}…` } : item;
		case 'toolCall':
			return { ...item, details: item.details.map(d => d.type === 'text' && d.text.length > maxTextLength ? { ...d, text: `${d.text.slice(0, maxTextLength)}…` } : d) };
		default:
			return item;
	}
}

/** Nothing from an earlier window is still running or waiting for an answer. */
function settle(item: TranscriptItem): TranscriptItem {
	if (item.kind === 'permission' && !item.answer) {
		return { ...item, answer: { kind: 'cancelled' } };
	}
	if (item.kind === 'toolCall' && (item.status === 'pending' || item.status === 'in_progress')) {
		return { ...item, status: 'failed' };
	}
	return item;
}

const kinds = new Set(['user', 'agent', 'thought', 'toolCall', 'plan', 'permission', 'other', 'notice']);

function isTranscriptItem(value: unknown): value is TranscriptItem {
	const item = value as TranscriptItem;
	if (typeof item?.id !== 'string' || !kinds.has(item.kind)) {
		return false;
	}
	switch (item.kind) {
		case 'user':
		case 'agent':
		case 'thought':
		case 'notice':
			return typeof item.text === 'string';
		case 'toolCall':
			return typeof item.title === 'string' && Array.isArray(item.locations) && Array.isArray(item.details);
		case 'plan':
			return Array.isArray(item.entries);
		case 'permission':
			return typeof item.title === 'string' && Array.isArray(item.options) && Array.isArray(item.diffPaths);
		case 'other':
			return typeof item.type === 'string';
	}
}
