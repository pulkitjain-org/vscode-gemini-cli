/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The pilot's counters (gemini/pilot/README.md): counts and timings only,
// never prompt, reply, file or ticket text. Recorded only while `gemini.pilot.record` is on, kept
// in the extension's storage one file per day, and handed over only by Gemini: Export Pilot Data,
// which writes them with the audit log to ~/geminicode-pilot/. Nothing leaves the Mac on its own.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type PilotEvent =
	/** GeminiCode started (the extension activated). */
	| { readonly kind: 'launch' }
	/** A prompt went to an agent, after `waitedMs` waiting for it to be ready (its process and `session/new`). */
	| { readonly kind: 'prompt'; readonly waitedMs: number }
	/** A turn ended: how many permission cards it showed, how long it took, and its first text. */
	| { readonly kind: 'turn'; readonly permissions: number; readonly durationMs: number; readonly firstTextMs?: number }
	/** The user undid an agent's change, file or whole turn. */
	| { readonly kind: 'undo'; readonly scope: 'change' | 'file' | 'turn' }
	/** The user rewound a conversation. */
	| { readonly kind: 'rewind' }
	/** What Home listed under Unfinished after a launch: open flows and writes with no result. */
	| { readonly kind: 'unfinished'; readonly flows: number; readonly writes: number }
	/** A Jira, GitLab, SonarQube, Snyk or Figma call failed, by kind (unreachable is usually the VPN). */
	| { readonly kind: 'teamToolError'; readonly tool: string; readonly error: string; readonly status?: number }
	/** A team link opened, leaving the app unless it opens in GeminiCode's browser. */
	| { readonly kind: 'openedLink'; readonly mergeRequest: boolean }
	/** A Jira or GitLab write, from a page (done in place) or an agent. */
	| { readonly kind: 'write'; readonly tool: string; readonly caller: string; readonly ok: boolean }
	/** A quota reading from the usage meter: each model's used share. */
	| { readonly kind: 'usage'; readonly quota: readonly { readonly model: string; readonly used: number; readonly resetTime?: string }[] };

/** An event as stored, with its time. */
export type PilotRecord = PilotEvent & { readonly at: string };

let sink: ((record: PilotRecord) => void) | undefined;

/** Where events go: the pilot log while recording is on, nowhere otherwise. */
export function setPilotSink(next: ((record: PilotRecord) => void) | undefined): void {
	sink = next;
}

/** Records an event if the pilot is recording; costs nothing otherwise. */
export function recordPilot(event: PilotEvent): void {
	sink?.({ ...event, at: new Date().toISOString() });
}

/** How long events wait in memory before they are appended, so a busy turn writes once. */
const flushDelayMs = 2000;

/** The pilot's events, one JSON Lines file per day in `dir`. */
export class PilotLog {

	private buffer: PilotRecord[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private writing: Promise<void> = Promise.resolve();

	constructor(private readonly dir: string) { }

	add(record: PilotRecord): void {
		this.buffer.push(record);
		this.timer ??= setTimeout(() => void this.flush(), flushDelayMs);
	}

	/** Appends what is buffered to each record's day file. */
	flush(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		const records = this.buffer;
		this.buffer = [];
		this.writing = this.writing.then(async () => {
			if (!records.length) {
				return;
			}
			await fs.mkdir(this.dir, { recursive: true });
			const byDay = new Map<string, string>();
			for (const record of records) {
				const day = record.at.slice(0, 10);
				byDay.set(day, (byDay.get(day) ?? '') + `${JSON.stringify(record)}\n`);
			}
			for (const [day, lines] of byDay) {
				await fs.appendFile(path.join(this.dir, `${day}.jsonl`), lines);
			}
		}).catch(() => undefined);
		return this.writing;
	}

	/** Every recorded event, oldest first. */
	async readAll(): Promise<PilotRecord[]> {
		await this.flush();
		let files: string[];
		try {
			files = (await fs.readdir(this.dir)).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
		} catch {
			return [];
		}
		const records: PilotRecord[] = [];
		for (const file of files) {
			for (const line of (await fs.readFile(path.join(this.dir, file), 'utf8')).split('\n')) {
				if (line.trim()) {
					try {
						records.push(JSON.parse(line) as PilotRecord);
					} catch {
						// A line cut short by a crash; the rest of the file still counts.
					}
				}
			}
		}
		return records;
	}
}

/** Per launch: how long until the first prompt went to an agent, and what was unfinished. */
export interface PilotLaunch {
	readonly at: string;
	readonly msToFirstPrompt: number | null;
	readonly unfinished: { readonly flows: number; readonly writes: number } | null;
}

/** The launches in `records` with their restart cost: the time to the first prompt, and what was unfinished. */
export function pilotLaunches(records: readonly PilotRecord[]): PilotLaunch[] {
	const launches: { at: string; msToFirstPrompt: number | null; unfinished: { flows: number; writes: number } | null }[] = [];
	for (const record of records) {
		const current = launches[launches.length - 1];
		if (record.kind === 'launch') {
			launches.push({ at: record.at, msToFirstPrompt: null, unfinished: null });
		} else if (record.kind === 'prompt' && current && current.msToFirstPrompt === null) {
			current.msToFirstPrompt = Date.parse(record.at) - Date.parse(current.at);
		} else if (record.kind === 'unfinished' && current && !current.unfinished) {
			current.unfinished = { flows: record.flows, writes: record.writes };
		}
	}
	return launches;
}

/** The exported file: one JSON object per line, each with a `type` (event, launch, audit) that says what it is. */
export function pilotExport(records: readonly PilotRecord[], audit: readonly object[]): string {
	return [
		...records.map(record => ({ type: 'event', ...record })),
		...pilotLaunches(records).map(launch => ({ type: 'launch', ...launch })),
		...audit.map(entry => ({ type: 'audit', ...entry })),
	].map(line => JSON.stringify(line)).join('\n') + '\n';
}
