/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// MCP servers that fail to start. Over ACP, gemini-cli 0.62 tells the client
// nothing when an MCP server fails; it only writes "[MCP error] ..." to its
// debug log. GeminiCode points that log (GEMINI_DEBUG_LOG_FILE) at a file of
// its own and reads the MCP lines from it: one file per window's extension
// host process (`debugLogName`), so a window starting its agent never empties
// another window's log. Logs of processes that have ended are removed.

import { promises as fs, watch, FSWatcher } from 'node:fs';
import * as path from 'node:path';
import { debugLogEntryStart as entryStart, debugLogMcpEntry as mcpEntry } from './cli/formats';
import { Emitter } from './events';

export interface McpProblem {
	readonly severity: 'error' | 'warning';
	/** The server's name in settings, when the message names one. */
	readonly server?: string;
	/** What went wrong, without the stack trace. */
	readonly message: string;
	/** Nothing answered at the server's address: an HTTP server that isn't running, or a host that can't be found. */
	readonly unreachable?: boolean;
}

const unreachable = /^fetch failed$|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/;
/**
 * gemini-cli 0.66 logs a server that lists nothing yet as a failed discovery, but keeps it and
 * declares its tools once it lists some (`tools/list_changed`). GeminiCode's own servers start
 * that way for an agent whose task doesn't need them yet, so it is not a problem.
 */
const empty = /^No prompts, tools, or resources found on the server\.?$/;

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
		// gemini-cli 0.62 adds the error as "TypeError: fetch failed"; 0.64 inspects it, "[TypeError: fetch failed] {", with its cause on the lines after.
		const message = reason.replace(/\s+\[?\w*Error: [\s\S]*$/, '').trim() || reason.trim();
		if (empty.test(message)) {
			continue;
		}
		problems.push({ severity: match[1] as McpProblem['severity'], server, message, ...unreachable.test(message) ? { unreachable: true } : {} });
	}
	return problems;
}

/** Past this, the log is emptied; the CLI appends, so it carries on at the start. */
const maxLogBytes = 1024 * 1024;

/** The debug log's name for process `pid`. */
export function debugLogName(pid: number = process.pid): string {
	return `cli-debug-${pid}.log`;
}

/** The process a debug log belongs to, from its name; undefined for any other file. */
export function debugLogPid(name: string): number | undefined {
	const pid = /^cli-debug-(?<pid>\d+)\.log$/.exec(name)?.groups?.pid;
	return pid ? Number(pid) : undefined;
}

/** Whether process `pid` is still running. */
export function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: it runs, as another user.
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Removes the debug logs in `dir` of processes that have ended; returns the files removed. */
export async function removeEndedDebugLogs(dir: string, running: (pid: number) => boolean = isRunning): Promise<string[]> {
	const names = await fs.readdir(dir).catch(() => [] as string[]);
	const ended = names.flatMap(name => {
		const pid = debugLogPid(name);
		return pid !== undefined && pid !== process.pid && !running(pid) ? [path.join(dir, name)] : [];
	});
	await Promise.all(ended.map(file => fs.rm(file, { force: true })));
	return ended;
}

/**
 * Follows the debug log of one agent process and reports each MCP problem
 * once. `reset` empties the log for a new process.
 */
export class McpDiagnostics {

	private readonly onDidReportEmitter = new Emitter<McpProblem>();
	readonly onDidReport = this.onDidReportEmitter.event;
	private readonly onDidReadLinesEmitter = new Emitter<readonly string[]>();
	/** The complete lines each read found, for other readers of the log, such as the CLI's retries. */
	readonly onDidReadLines = this.onDidReadLinesEmitter.event;

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
	async reset(): Promise<boolean> {
		this.stopWatching();
		this.offset = 0;
		this.partial = '';
		this.reported.clear();
		try {
			await fs.mkdir(path.dirname(this.file), { recursive: true });
			void removeEndedDebugLogs(path.dirname(this.file));
			await fs.writeFile(this.file, '');
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
		this.onDidReadLinesEmitter.dispose();
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
					this.onDidReadLinesEmitter.fire(lines);
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
