/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Agents list on disk: workspaces and agents, one file each, in two
// record stores (recordStore.ts) under the extension's global storage, so
// every window saves only what it changed and learns of the others' changes.
// It used to be one snapshot in global state (`gemini.agents`), which every
// window wrote whole; the first load moves that in, once, and leaves it where
// it was, and the host still writes it when a window closes, for a downgrade.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { agentsSnapshotVersion, type AgentRecord, type AgentsModel, type AgentsSnapshot, type SavedRecord, type StoredAgents } from './agents';
import { RecordStore } from './recordStore';

/** Marks that the global state snapshot was moved in. */
const migratedFile = 'migrated.json';

export class AgentsStore {

	readonly workspaces: RecordStore<SavedRecord>;
	readonly agents: RecordStore<SavedRecord>;
	/** Where problems go: a file moved aside, a write that failed. */
	log: (message: string) => void = () => undefined;
	private saving: Promise<void> = Promise.resolve();

	constructor(readonly dir: string, now: () => number = Date.now) {
		const onError = (message: string) => this.log(message);
		this.workspaces = new RecordStore<SavedRecord>(path.join(dir, 'workspaces'), { now, onError });
		// The copy used last wins: a prompt bumps `updatedAt`.
		this.agents = new RecordStore<SavedRecord>(path.join(dir, 'agents'), { now, onError, newer: (theirs, ours) => stamp(theirs) > stamp(ours) });
	}

	/**
	 * The saved list. The first time, the snapshot global state kept
	 * (`legacy`) is moved in: its records join any already here.
	 */
	async load(legacy: AgentsSnapshot | undefined): Promise<StoredAgents> {
		const [workspaces, agents] = await Promise.all([this.workspaces.load(), this.agents.load()]);
		if (await fs.access(path.join(this.dir, migratedFile)).then(() => true, () => false)) {
			return { version: agentsSnapshotVersion, workspaces, agents };
		}
		const merged = {
			version: agentsSnapshotVersion,
			workspaces: withMissing(workspaces, legacy?.workspaces),
			agents: withMissing(agents, legacy?.agents),
		};
		await Promise.all([this.workspaces.save(merged.workspaces), this.agents.save(merged.agents)]);
		await fs.writeFile(path.join(this.dir, migratedFile), JSON.stringify({ version: 1, at: new Date().toISOString(), workspaces: merged.workspaces.length, agents: merged.agents.length }));
		return merged;
	}

	/**
	 * Saves what changed in `model`; whatever another window changed in the
	 * meantime and won goes back into the model.
	 */
	save(model: AgentsModel): Promise<void> {
		const stored = model.stored();
		this.saving = this.saving.then(async () => {
			const [workspaces, agents] = await Promise.all([this.workspaces.save(stored.workspaces), this.agents.save(stored.agents)]);
			model.applyExternal({ workspaces, agents }, record => this.unsaved(record));
		}).catch(err => this.log(`The agent list could not be saved: ${err instanceof Error ? err.message : String(err)}`));
		return this.saving;
	}

	/** Follows other windows' changes into `model`; `onRemoved` hears of the agents they removed. */
	watch(model: AgentsModel, onRemoved: (agents: readonly AgentRecord[]) => void): { dispose(): void } {
		const take = (change: Parameters<AgentsModel['applyExternal']>[0]) => {
			const removed = model.applyExternal(change, record => this.unsaved(record));
			if (removed.length) {
				onRemoved(removed);
			}
		};
		const workspaces = this.workspaces.watch(change => take({ workspaces: change }));
		const agents = this.agents.watch(change => take({ agents: change }));
		return {
			dispose: () => {
				workspaces.dispose();
				agents.dispose();
			},
		};
	}

	async flush(): Promise<void> {
		await this.saving;
		await Promise.all([this.workspaces.flush(), this.agents.flush()]);
	}

	dispose(): void {
		this.workspaces.dispose();
		this.agents.dispose();
	}

	/** Changed here and not saved yet. */
	private unsaved(record: SavedRecord): boolean {
		return !this.workspaces.isSaved(record) && !this.agents.isSaved(record);
	}
}

/** `records`, then each of `legacy`'s that it lacks. */
function withMissing(records: readonly SavedRecord[], legacy: readonly unknown[] | undefined): SavedRecord[] {
	const ids = new Set(records.map(record => record.id));
	const added = (Array.isArray(legacy) ? legacy : []).filter((record): record is SavedRecord => typeof (record as SavedRecord | undefined)?.id === 'string' && !ids.has((record as SavedRecord).id));
	return [...records, ...added];
}

function stamp(record: SavedRecord): number {
	const value = (record as { readonly updatedAt?: unknown }).updatedAt;
	return typeof value === 'number' ? value : 0;
}
