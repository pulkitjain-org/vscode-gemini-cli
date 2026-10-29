/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Each agent's conversation as shown in its tab and the files it changed, one
// JSON file per agent. The agent keeps its own history for `session/load`; this
// is only what the tab displays, so it is capped to stay small and fast to
// read: the last items, with long text cut.

import { readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import type { EditedFile } from './agentChanges';
import type { TranscriptItem } from './chatTranscript';
import { KeyedQueue, privateWrite, quarantine, writeFileAtomic } from './fsUtil';
import { hasReplayMarkers, withoutReplayMarkers } from './replayText';
import type { ModelTokens } from './turnUsage';

/**
 * 2 since replayed history can no longer leak into a chat (see replayText.ts);
 * a version 1 file is cleaned of the markers it may have when it loads. A
 * file of any other version, or one that can't be parsed, is moved aside as
 * `.broken` rather than written over.
 */
const formatVersion = 2;
const maxItems = 300;
const maxTextLength = 20_000;

export interface StoredAgent {
	readonly items: readonly TranscriptItem[];
	/** Checked by `AgentChanges` when it loads them. */
	readonly changes: readonly EditedFile[];
}

interface StoredTranscript extends StoredAgent {
	readonly version: number;
}

/**
 * The changed files' texts (what each was before the agent's first edit, and
 * what the agent last wrote) are a file of their own beside the chat's,
 * `<id>.changes.json`, written only when they change: the chat file is
 * written at every turn's end and after every save, and with the texts in
 * it an agent that edited 300 files rewrote megabytes each time. The chat
 * file keeps the files' paths and counts, so a chat from before loads, and
 * a changes file that fails to write loses only the diffs, never the list.
 */
interface StoredChanges {
	readonly version: number;
	readonly files: readonly EditedFile[];
}

const empty: StoredAgent = { items: [], changes: [] };

export class TranscriptStore {

	/** Reads and writes per agent, one after another, so they never overlap. */
	private readonly queue = new KeyedQueue();

	/** `onError` hears of every write that fails, such as on a full disk. */
	constructor(private readonly directory: string, private readonly onError: (err: unknown) => void = () => undefined) { }

	/** The last written signature of each agent's change texts, so the changes file is written only when they changed. */
	private readonly changesWritten = new Map<string, string>();

	/** The saved items, ready to show; empty when there are none, or when the file can't be read, which is then moved aside. */
	load(agentId: string): Promise<StoredAgent> {
		return this.queue.run(agentId, async () => {
			const file = this.file(agentId);
			let text: string;
			try {
				text = await readFile(file, 'utf8');
			} catch {
				return empty;
			}
			const changes = await this.loadChanges(agentId);
			let stored: StoredTranscript;
			try {
				stored = JSON.parse(text) as StoredTranscript;
				if (stored?.version !== formatVersion && stored?.version !== 1) {
					throw new Error(`version ${String(stored?.version)}`);
				}
			} catch {
				// A newer version's chat, or a damaged one: kept aside, never written over.
				await quarantine(file).catch(err => this.onError(err));
				return empty;
			}
			const items = Array.isArray(stored.items) ? stored.items.filter(isTranscriptItem).map(settle) : [];
			return {
				items: stored.version === 1 ? withoutLeakedReplay(items) : items,
				// The chat file says which files changed; the changes file adds their texts. A chat from before that file carries them itself.
				changes: (Array.isArray(stored.changes) ? stored.changes : []).map(file => withTexts(file, changes)),
			};
		});
	}

	save(agentId: string, agent: StoredAgent): Promise<void> {
		const stored: StoredTranscript = { version: formatVersion, items: agent.items.slice(-maxItems).map(trim), changes: agent.changes.map(withoutTexts) };
		const signature = changesSignature(agent.changes);
		return this.write(agentId, async () => {
			await writeFileAtomic(this.file(agentId), JSON.stringify(stored), privateWrite);
			// Nothing to write for an agent that changed nothing, unless its changes file holds texts from before.
			if (this.changesWritten.get(agentId) !== signature && (agent.changes.length || this.changesWritten.has(agentId))) {
				const changes: StoredChanges = { version: formatVersion, files: agent.changes };
				await writeFileAtomic(this.changesFile(agentId), JSON.stringify(changes), privateWrite);
				this.changesWritten.set(agentId, signature);
			}
		});
	}

	/** The changed files with their texts, from the changes file; undefined when there is none, or it cannot be read (then moved aside). */
	private async loadChanges(agentId: string): Promise<EditedFile[] | undefined> {
		const file = this.changesFile(agentId);
		let text: string;
		try {
			text = await readFile(file, 'utf8');
		} catch {
			return undefined;
		}
		try {
			const stored = JSON.parse(text) as StoredChanges;
			if (stored?.version !== formatVersion || !Array.isArray(stored.files)) {
				throw new Error(`version ${String(stored?.version)}`);
			}
			return stored.files;
		} catch {
			await quarantine(file).catch(err => this.onError(err));
			return undefined;
		}
	}

	/** Resolves once every write queued so far is on disk. */
	flush(): Promise<void> {
		return this.queue.flush();
	}

	delete(agentId: string): Promise<void> {
		this.changesWritten.delete(agentId);
		return this.write(agentId, async () => {
			await rm(this.file(agentId), { force: true });
			await rm(this.changesFile(agentId), { force: true });
		});
	}

	/** Queues a write; one that fails goes to `onError` and resolves. */
	private write(agentId: string, write: () => Promise<void>): Promise<void> {
		return this.queue.run(agentId, write).catch(err => this.onError(err));
	}

	private file(agentId: string): string {
		return path.join(this.directory, `${agentId.replace(/[^\w-]/g, '_')}.json`);
	}

	private changesFile(agentId: string): string {
		return path.join(this.directory, `${agentId.replace(/[^\w-]/g, '_')}.changes.json`);
	}
}

/** `file` with the texts the changes file holds for its path, when it holds any. */
function withTexts(file: EditedFile, changes: readonly EditedFile[] | undefined): EditedFile {
	const texts = changes?.find(each => each.path === file.path);
	return texts ? { ...file, ...texts.original !== undefined ? { original: texts.original } : {}, ...texts.agentText !== undefined ? { agentText: texts.agentText } : {} } : file;
}

/** A changed file as the chat file keeps it: its path and counts, never its texts. */
function withoutTexts(file: EditedFile): EditedFile {
	const { original: _original, agentText: _agentText, ...light } = file;
	return light;
}

/** What tells one set of change texts from another without reading them: paths, text lengths, counts and edit times. */
function changesSignature(files: readonly EditedFile[]): string {
	return files.map(file => `${file.path}\0${file.original?.length ?? -1}\0${file.agentText?.length ?? -1}\0${file.added}\0${file.removed}\0${file.editedAt ?? 0}`).join('\n');
}

function trim(item: TranscriptItem): TranscriptItem {
	switch (item.kind) {
		case 'user':
		case 'agent':
		case 'thought':
		case 'notice':
			return item.text.length > maxTextLength ? { ...item, text: `${item.text.slice(0, maxTextLength)}…` } : item;
		case 'compact':
			return item.summary && item.summary.length > maxTextLength ? { ...item, summary: `${item.summary.slice(0, maxTextLength)}…` } : item;
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
	if (item.kind === 'compact' && item.state === 'running') {
		// The app quit while it compacted: the chat stayed on its session.
		return { ...item, state: 'failed' };
	}
	if (item.kind === 'turnEnd' && (item.undo === 'available' || item.retry)) {
		// Checkpoints and the last prompt live in memory, so another window cannot undo or retry.
		const { undo, retry, ...rest } = item;
		return undo === 'undone' ? { ...rest, undo } : rest;
	}
	return item;
}

/**
 * A version 1 chat with the CLI's replay markers cleaned out: a prompt or
 * reply made only of markers, such as `[Function Response: replace]`, goes,
 * and markers at the start or end of other text are taken off.
 */
export function withoutLeakedReplay(items: readonly TranscriptItem[]): TranscriptItem[] {
	return items.flatMap(item => {
		if ((item.kind !== 'user' && item.kind !== 'agent' && item.kind !== 'thought') || !hasReplayMarkers(item.text)) {
			return [item];
		}
		const text = withoutReplayMarkers(item.text);
		return text ? [{ ...item, text }] : [];
	});
}

const kinds = new Set(['user', 'agent', 'thought', 'toolCall', 'plan', 'permission', 'other', 'notice', 'cutOff', 'compact', 'fork', 'trace', 'turnEnd', 'thread', 'research']);

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
		case 'cutOff':
			return typeof item.prompt === 'string';
		case 'compact':
			return typeof item.state === 'string';
		case 'fork':
			return (item.role === 'from' || item.role === 'child') && typeof item.agent === 'string' && typeof item.title === 'string';
		case 'trace':
			return typeof item.file === 'string' && typeof item.readout === 'object' && item.readout !== null && Array.isArray(item.readout.hops);
		case 'turnEnd':
			return typeof item.durationMs === 'number' && (item.usage === undefined || (Array.isArray(item.usage) && item.usage.every(isModelTokens)));
		case 'thread':
			return typeof item.thread === 'string' && typeof item.title === 'string' && typeof item.state === 'string' && typeof item.startedAt === 'number';
	}
}

function isModelTokens(value: unknown): boolean {
	const tokens = value as ModelTokens;
	return typeof tokens?.model === 'string' && Number.isFinite(tokens.input) && Number.isFinite(tokens.output);
}
