/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// MCP servers that fail to start. Over ACP, gemini-cli 0.62 tells the client
// nothing when an MCP server fails; it only writes "[MCP error] ..." to its
// debug log. GeminiCode points that log (GEMINI_DEBUG_LOG_FILE) at a file of
// its own and reads the MCP lines from it.

import { promises as fs, mkdirSync, watch, writeFileSync, FSWatcher } from 'node:fs';
import * as path from 'node:path';
import { Emitter } from './events';

export interface McpProblem {
	readonly severity: 'error' | 'warning';
	/** The server's name in settings, when the message names one. */
	readonly server?: string;
	/** What went wrong, without the stack trace. */
	readonly message: string;
}

/** An entry's first line: "[2026-10-04T10:36:52.038Z] [LOG] ...". Lines after it, such as a stack trace, belong to it. */
const entryStart = /^\[\d{4}-\d\d-\d\dT[^\]]*\] \[[A-Z]+\] /;
const mcpEntry = /^\[MCP (error|warning)\] (.*)$/;

/** The MCP problems in complete lines of the CLI's debug log. */
export function parseMcpProblems(lines: readonly string[]): McpProblem[] {
	const problems: McpProblem[] = [];
	for (const line of lines) {
		const start = entryStart.exec(line);
		const match = start && mcpEntry.exec(line.slice(start[0].length));
		if (!match) {
			continue;
		}
		const text = match[2];
		const server = /MCP server '([^']+)'/.exec(text)?.[1] ?? /\(([^()]+)\)\s*$/.exec(text)?.[1];
		// "Error during discovery for MCP server 'x': spawn foo ENOENT Error: spawn foo ENOENT" -> "spawn foo ENOENT"
		const reason = server && text.includes(`'${server}': `) ? text.slice(text.indexOf(`'${server}': `) + server.length + 4) : text;
		const message = reason.replace(/\s+\w*Error: [\s\S]*$/, '').trim() || reason.trim();
		problems.push({ severity: match[1] as McpProblem['severity'], server, message });
	}
	return problems;
}

/** Past this, the log is emptied; the CLI appends, so it carries on at the start. */
const maxLogBytes = 1024 * 1024;

/**
 * Follows the debug log of one agent process and reports each MCP problem
 * once. `reset` empties the log for a new process.
 */
export class McpDiagnostics {

	private readonly onDidReportEmitter = new Emitter<McpProblem>();
	readonly onDidReport = this.onDidReportEmitter.event;

	private watcher: FSWatcher | undefined;
	private offset = 0;
	private partial = '';
	private reading = false;
	private readAgain = false;
	private readonly reported = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(readonly file: string) { }

	/**
	 * Empties the log and forgets what was reported, just before a new agent
	 * process starts; returns whether the log can be followed.
	 */
	reset(): boolean {
		this.stopWatching();
		this.offset = 0;
		this.partial = '';
		this.reported.clear();
		try {
			mkdirSync(path.dirname(this.file), { recursive: true });
			writeFileSync(this.file, '');
			this.watcher = watch(this.file, () => this.schedule());
			this.watcher.on('error', () => this.stopWatching());
			return true;
		} catch {
			return false;
		}
	}

	dispose(): void {
		this.stopWatching();
		this.onDidReportEmitter.dispose();
	}

	/** Reads what was added since the last read, a moment after the file changes, so a burst of writes is read once. */
	private schedule(): void {
		this.timer ??= setTimeout(() => {
			this.timer = undefined;
			void this.read();
		}, 100);
	}

	/** Reads what the CLI added since the last read. */
	async read(): Promise<void> {
		if (this.reading) {
			this.readAgain = true;
			return;
		}
		this.reading = true;
		try {
			const handle = await fs.open(this.file, 'r');
			try {
				const { size } = await handle.stat();
				if (size < this.offset) {
					this.offset = 0; // Emptied.
				}
				if (size > this.offset) {
					const buffer = Buffer.alloc(size - this.offset);
					await handle.read(buffer, 0, buffer.length, this.offset);
					this.offset = size;
					const lines = (this.partial + buffer.toString('utf8')).split('\n');
					this.partial = lines.pop() ?? '';
					for (const problem of parseMcpProblems(lines)) {
						const key = `${problem.server ?? ''}\n${problem.message}`;
						if (!this.reported.has(key)) {
							this.reported.add(key);
							this.onDidReportEmitter.fire(problem);
						}
					}
				}
			} finally {
				await handle.close();
			}
			if (this.offset > maxLogBytes) {
				await fs.truncate(this.file, 0);
				this.offset = 0;
				this.partial = '';
			}
		} catch {
			// The log is a convenience; a read that fails reports nothing.
		} finally {
			this.reading = false;
			if (this.readAgain) {
				this.readAgain = false;
				void this.read();
			}
		}
	}

	private stopWatching(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.watcher?.close();
		this.watcher = undefined;
	}
}
