/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A record of every write GeminiCode makes to Jira or GitLab for the user,
// whether an agent asked for it or the user pressed a button. One JSON line
// per record, appended to a file per day under the extension's storage, never
// rewritten. A write gets two records with the same id: the intent, before
// the call, and the result (or the failure) after it, with the id the tool
// gave back. An intent that never got its result is what was running when
// the app quit; Home lists those as unfinished.
//
// The record names what changed and where, not what was written: the text of
// a comment is in the transcript, and a hash of it here ties the two.

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Emitter } from './events';
import { privateWrite } from './fsUtil';

export type AuditCaller = 'agent' | 'ui';
export type AuditPhase = 'intent' | 'result' | 'failed';

export interface AuditEntry {
	/** The same for a write's intent and its result. */
	readonly id: string;
	readonly time: string;
	readonly phase: AuditPhase;
	readonly caller: AuditCaller;
	/** The agent the write was made for, when an agent asked. */
	readonly agent?: string;
	/** The tool name, such as `jira_transition`, or the flow, such as `openMergeRequest`. */
	readonly tool: string;
	/** What the write is about: a ticket key, `!12`, a branch. */
	readonly ref?: string;
	/** One line for a person: "ACME-412 In Progress → In Review". */
	readonly effect: string;
	/** A hash of the arguments, so a record can be matched to a call without holding the text. */
	readonly argsHash?: string;
	/** The id the tool gave back: a comment id, a worklog id, `!12`, a merge commit. */
	readonly remote?: string;
	readonly error?: string;
}

export interface AuditIntent {
	readonly caller: AuditCaller;
	readonly agent?: string;
	readonly tool: string;
	readonly ref?: string;
	readonly effect: string;
	readonly args?: unknown;
}

/** A short hash of `value`, as the log stores arguments and text. */
export function auditHash(value: unknown): string {
	return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex').slice(0, 16);
}

/** The day's file name for `time`. */
export function auditFileName(time: Date): string {
	return `${time.toISOString().slice(0, 10)}.jsonl`;
}

/** How long the unfinished intents are served again before the log is read for other windows' entries. */
const unfinishedTtlMs = 5_000;

export class AuditLog {

	private queue: Promise<void> = Promise.resolve();
	private readonly onDidAppendEmitter = new Emitter<AuditEntry>();
	/** Fires once a record is on disk. */
	readonly onDidAppend = this.onDidAppendEmitter.event;

	/** The last `unfinished` answer, served again for a while: Home rebuilds on every agent step and asks each time. */
	private unfinishedCache: { readonly at: number; readonly days: number; readonly entries: Promise<AuditEntry[]> } | undefined;

	constructor(readonly dir: string, private readonly now: () => Date = () => new Date()) { }

	/** Records that a write is about to happen; returns the id its result is recorded under. */
	async intent(intent: AuditIntent): Promise<string> {
		const id = randomBytes(6).toString('hex');
		await this.append({ id, time: this.now().toISOString(), phase: 'intent', caller: intent.caller, ...intent.agent ? { agent: intent.agent } : {}, tool: intent.tool, ...intent.ref ? { ref: intent.ref } : {}, effect: intent.effect, ...intent.args !== undefined ? { argsHash: auditHash(intent.args) } : {} });
		return id;
	}

	/** Records that the write with `id` went through, with the id the tool gave back. */
	async result(id: string, intent: AuditIntent, remote?: string): Promise<void> {
		await this.append({ id, time: this.now().toISOString(), phase: 'result', caller: intent.caller, ...intent.agent ? { agent: intent.agent } : {}, tool: intent.tool, ...intent.ref ? { ref: intent.ref } : {}, effect: intent.effect, ...remote ? { remote } : {} });
	}

	async failed(id: string, intent: AuditIntent, error: string): Promise<void> {
		await this.append({ id, time: this.now().toISOString(), phase: 'failed', caller: intent.caller, ...intent.agent ? { agent: intent.agent } : {}, tool: intent.tool, ...intent.ref ? { ref: intent.ref } : {}, effect: intent.effect, error: error.slice(0, 500) });
	}

	/** Runs `write` between an intent and its result or failure; rethrows the failure. */
	async record<T>(intent: AuditIntent, write: () => Promise<T>, remoteOf?: (value: T) => string | undefined): Promise<T> {
		const id = await this.intent(intent);
		try {
			const value = await write();
			await this.result(id, intent, remoteOf?.(value));
			return value;
		} catch (err) {
			await this.failed(id, intent, err instanceof Error ? err.message : String(err));
			throw err;
		}
	}

	/** The records of `day` (today by default), oldest first. */
	async read(day: Date = this.now()): Promise<AuditEntry[]> {
		let text: string;
		try {
			text = await fs.readFile(path.join(this.dir, auditFileName(day)), 'utf8');
		} catch {
			return [];
		}
		return text.split('\n').flatMap(line => {
			try {
				return line.trim() ? [JSON.parse(line) as AuditEntry] : [];
			} catch {
				return [];
			}
		});
	}

	/** The days that have records, newest first. */
	async days(): Promise<string[]> {
		try {
			return (await fs.readdir(this.dir)).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).map(name => name.slice(0, 10)).sort().reverse();
		} catch {
			return [];
		}
	}

	/** Intents of the last `days` days that got neither a result nor a failure: writes that were running when the app quit. */
	unfinished(days = 7): Promise<AuditEntry[]> {
		const now = this.now().getTime();
		if (this.unfinishedCache && this.unfinishedCache.days === days && now - this.unfinishedCache.at < unfinishedTtlMs) {
			return this.unfinishedCache.entries;
		}
		const entries = this.readUnfinished(days);
		this.unfinishedCache = { at: now, days, entries };
		entries.catch(() => this.unfinishedCache = undefined);
		return entries;
	}

	private async readUnfinished(days: number): Promise<AuditEntry[]> {
		const open = new Map<string, AuditEntry>();
		for (const day of (await this.days()).slice(0, days).reverse()) {
			for (const entry of await this.read(new Date(`${day}T00:00:00Z`))) {
				if (entry.phase === 'intent') {
					open.set(entry.id, entry);
				} else {
					open.delete(entry.id);
				}
			}
		}
		return [...open.values()];
	}

	/** Marks an unfinished intent as settled by hand, after the user checked the tool. */
	settle(entry: AuditEntry, remote?: string): Promise<void> {
		return this.result(entry.id, { caller: entry.caller, agent: entry.agent, tool: entry.tool, ref: entry.ref, effect: entry.effect }, remote);
	}

	/** Appends in order. A failed append rejects only for its caller; the next one still runs. */
	private append(entry: AuditEntry): Promise<void> {
		this.unfinishedCache = undefined;
		const run = this.queue.then(async () => {
			await fs.mkdir(this.dir, { recursive: true, mode: privateWrite.dirMode });
			await fs.appendFile(path.join(this.dir, auditFileName(new Date(entry.time))), `${JSON.stringify(entry)}\n`, { mode: privateWrite.mode });
			this.onDidAppendEmitter.fire(entry);
		});
		this.queue = run.catch(() => undefined);
		return run;
	}
}

/** The log as Markdown, for Open Audit Log: one table per day, newest day first. */
export function renderAudit(days: readonly { readonly day: string; readonly entries: readonly AuditEntry[] }[], unfinished: readonly AuditEntry[]): string {
	const lines = ['# Audit log', '', 'Every write GeminiCode made to Jira or GitLab for you. Each write has an intent before the call and a result after it; the remote id is what the tool gave back, and the tool\'s own history is the record.', ''];
	if (unfinished.length) {
		lines.push('## Unfinished', '', 'Intents with no result: these were running when GeminiCode last quit. Check the tool before redoing any of them.', '');
		for (const e of unfinished) {
			lines.push(`- ${e.time.slice(0, 16).replace('T', ' ')} · ${e.tool} · ${e.effect}`);
		}
		lines.push('');
	}
	for (const { day, entries } of days) {
		lines.push(`## ${day}`, '', '| Time | Caller | Tool | Effect | Phase | Remote |', '| --- | --- | --- | --- | --- | --- |');
		for (const e of [...entries].reverse()) {
			const caller = e.caller === 'agent' ? `agent${e.agent ? ` ${e.agent.slice(0, 8)}` : ''}` : 'you';
			lines.push(`| ${e.time.slice(11, 19)} | ${caller} | \`${e.tool}\` | ${e.effect.replace(/\|/g, '\\|')} | ${e.phase}${e.error ? `: ${e.error.replace(/\|/g, '\\|')}` : ''} | ${e.remote ?? ''} |`);
		}
		lines.push('');
	}
	if (!days.length) {
		lines.push('Nothing recorded yet.', '');
	}
	return lines.join('\n');
}
