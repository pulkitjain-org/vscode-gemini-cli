/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A team flow (Open Merge Request, Move Ticket, Review) is a tab that lives
// in memory. GeminiCode is a desktop app, so when it quits, every open flow
// goes with it. Each flow writes a small record here when it opens and
// removes it when it finishes or is closed; a record still here when the app
// starts again is a flow that was cut off, and Home lists it with Reopen and
// Discard. The record holds what the flow was started with and, as the user
// types, what they typed and ticked; reopening starts the flow again from
// the same inputs and puts those back.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { writeJsonAtomic } from './fsUtil';

export interface FlowRecord {
	readonly id: string;
	/** The command that opened the flow, and its arguments, so Reopen can run it again. */
	readonly command: string;
	readonly args: readonly unknown[];
	/** The tab's title: "Move ACME-412", "Open Merge Request". */
	readonly title: string;
	readonly startedAt: string;
	/** What the flow was about, for the row on Home. */
	readonly about?: string;
	/** What the user typed and ticked, by field, so Reopen puts it back. */
	readonly fields?: Readonly<Record<string, string | number | boolean>>;
}

/** How long a listing is served again before the folder is read for other windows' records. */
const listTtlMs = 5_000;

export class FlowRecordStore {

	constructor(readonly dir: string, private readonly now: () => Date = () => new Date()) { }

	/** The last listing, served again for a while: Home rebuilds on every agent step and asks each time. */
	private cached: { readonly at: number; readonly records: Promise<FlowRecord[]> } | undefined;

	/** Writes the record for a flow that just opened; returns its id. */
	async open(record: Omit<FlowRecord, 'id' | 'startedAt'>): Promise<string> {
		const id = `${this.now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		await writeJsonAtomic(this.file(id), { ...record, id, startedAt: this.now().toISOString() } satisfies FlowRecord, { indent: '\t', newline: false });
		this.cached = undefined;
		return id;
	}

	/** Removes the record: the flow finished, or the user closed it. */
	async close(id: string): Promise<void> {
		await fs.rm(this.file(id), { force: true });
		this.cached = undefined;
	}

	/** Keeps what the user typed and ticked on the flow's record; nothing when the record is gone. */
	async saveFields(id: string, fields: Readonly<Record<string, string | number | boolean>>): Promise<void> {
		const record = await this.get(id);
		if (record) {
			await writeJsonAtomic(this.file(id), { ...record, fields } satisfies FlowRecord, { indent: '\t', newline: false });
			this.cached = undefined;
		}
	}

	async get(id: string): Promise<FlowRecord | undefined> {
		return (await this.list()).find(record => record.id === id);
	}

	/**
	 * The flows that were open when the app last quit, oldest first. Read from
	 * disk once per write of this store's own, and again after `listTtlMs` for
	 * what other windows wrote.
	 */
	list(): Promise<FlowRecord[]> {
		const now = this.now().getTime();
		if (this.cached && now - this.cached.at < listTtlMs) {
			return this.cached.records;
		}
		const records = this.read();
		this.cached = { at: now, records };
		records.catch(() => this.cached = undefined);
		return records;
	}

	private async read(): Promise<FlowRecord[]> {
		let names: string[];
		try {
			names = await fs.readdir(this.dir);
		} catch {
			return [];
		}
		const records: FlowRecord[] = [];
		for (const name of names.filter(n => n.endsWith('.json'))) {
			try {
				const record = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8')) as FlowRecord;
				if (record.id && record.command) {
					records.push(record);
				}
			} catch {
				// An unreadable record is of no use; it goes with the next close.
			}
		}
		return records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	}

	private file(id: string): string {
		return path.join(this.dir, `${id.replace(/[^\w-]/g, '')}.json`);
	}
}
