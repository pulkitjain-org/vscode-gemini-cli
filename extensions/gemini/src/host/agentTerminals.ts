/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Each agent's terminals, one per folder it works in, and the last command of
// every terminal. An agent's terminals are tabs in its side group, so they
// hide and come back with the agent as its files do. Open Terminal and Run on
// a reply's command use an agent's terminal; Send Last Command to Gemini and
// Run's "Send Output to Gemini" use the last command, which is kept from shell
// integration as it runs (its output is only readable by a listener there from
// its start), capped at the last 200 lines and replaced by the next command.

import * as vscode from 'vscode';
import { commandCount, FinishedCommand, OutputTail } from '../acp/runCommands';

/** How long Run waits for a new terminal's shell integration before typing the command in without it. */
const shellIntegrationWaitMs = 3_000;
/** How long after a command of a block ends Run waits for the block's next command to start before taking the shell to be at its prompt. */
export const blockIdleMs = 500;

/** What Run waits on in a terminal: each command that ends there, or the terminal closing (`undefined`), and each command that starts. */
interface RunWaiter {
	ended(command: FinishedCommand | undefined): void;
	started(): void;
}

interface AgentTerminal {
	readonly agent: string;
	readonly folder: string;
	readonly terminal: vscode.Terminal;
}

/** How a command Run started ended; undefined fields when the shell has no integration to say. */
export interface RunOutcome {
	readonly exitCode?: number;
	readonly ms?: number;
	readonly command?: FinishedCommand;
}

export class AgentTerminals implements vscode.Disposable {
	private readonly terminals: AgentTerminal[] = [];
	private readonly last = new Map<vscode.Terminal, FinishedCommand>();
	/** When each terminal's last command finished, so the newest of an agent's terminals can be told. */
	private readonly endedAt = new Map<vscode.Terminal, number>();
	private readonly running = new Map<vscode.TerminalShellExecution, { readonly terminal: vscode.Terminal; readonly tail: OutputTail; readonly done: Promise<void> }>();
	/** Run's wait on each terminal it runs a command in. */
	private readonly waiters = new Map<vscode.Terminal, RunWaiter>();
	private readonly disposables: vscode.Disposable[] = [];

	/** `columnOf` is the column of the agent's side group, where its terminals open. */
	constructor(private readonly columnOf: (agent: string) => Promise<vscode.ViewColumn>) {
		this.disposables.push(
			vscode.window.onDidStartTerminalShellExecution(({ terminal, execution }) => {
				const tail = new OutputTail();
				// Read from the start: the stream has only what arrives after it is opened.
				const stream = execution.read();
				const done = (async () => {
					for await (const chunk of stream) {
						tail.push(chunk);
					}
				})().catch(() => undefined);
				this.running.set(execution, { terminal, tail, done });
				this.waiters.get(terminal)?.started();
			}),
			vscode.window.onDidEndTerminalShellExecution(async ({ terminal, execution, exitCode }) => {
				const run = this.running.get(execution);
				this.running.delete(execution);
				// The stream ends with the command; give its last chunk a moment.
				await Promise.race([run?.done, new Promise(resolve => setTimeout(resolve, 200))]);
				const output = run?.tail.finish() ?? { lines: [], dropped: 0 };
				// The execution's folder, else the terminal's: zsh's integration often reports only the terminal's.
				const cwd = execution.cwd ?? terminal.shellIntegration?.cwd;
				const finished: FinishedCommand = {
					commandLine: execution.commandLine.value,
					...cwd ? { cwd: cwd.fsPath } : {},
					...exitCode !== undefined ? { exitCode } : {},
					...output,
				};
				this.last.set(terminal, finished);
				this.endedAt.set(terminal, Date.now());
				this.waiters.get(terminal)?.ended(finished);
			}),
			vscode.window.onDidCloseTerminal(terminal => {
				this.last.delete(terminal);
				this.endedAt.delete(terminal);
				// A command still running there never ends now.
				for (const [execution, run] of this.running) {
					if (run.terminal === terminal) {
						this.running.delete(execution);
					}
				}
				this.waiters.get(terminal)?.ended(undefined);
				const at = this.terminals.findIndex(each => each.terminal === terminal);
				if (at >= 0) {
					this.terminals.splice(at, 1);
				}
			}),
		);
	}

	/** The agent whose terminal `terminal` is, if it is one. */
	agentOf(terminal: vscode.Terminal): string | undefined {
		return this.terminals.find(each => each.terminal === terminal)?.agent;
	}

	/** The last command that finished in `terminal`, while shell integration reports commands there. */
	lastCommand(terminal: vscode.Terminal): FinishedCommand | undefined {
		return this.last.get(terminal);
	}

	/** The newest command that finished in `agent`'s terminals, else in the terminal in front; for the chat's @ picker. */
	lastCommandFor(agent: string): FinishedCommand | undefined {
		const own = this.terminals.filter(each => each.agent === agent && this.last.has(each.terminal))
			.sort((a, b) => (this.endedAt.get(b.terminal) ?? 0) - (this.endedAt.get(a.terminal) ?? 0))[0];
		const terminal = own?.terminal ?? vscode.window.activeTerminal;
		return terminal && this.last.get(terminal);
	}

	/** The agent's terminal in `folder`, named `name`, made the first time; `fresh` makes another. */
	async terminalFor(agent: string, name: string, folder: string, fresh = false): Promise<vscode.Terminal> {
		const known = fresh ? undefined : this.terminals.find(each => each.agent === agent && each.folder === folder && each.terminal.exitStatus === undefined);
		if (known) {
			return known.terminal;
		}
		const viewColumn = await this.columnOf(agent);
		const again = fresh ? undefined : this.terminals.find(each => each.agent === agent && each.folder === folder && each.terminal.exitStatus === undefined);
		if (again) {
			// Made by another call while the column was asked for.
			return again.terminal;
		}
		// Transient: a reload would bring it back as a tab its agent no longer knows, beside the one Open Terminal makes.
		const terminal = vscode.window.createTerminal({ name, cwd: folder, iconPath: new vscode.ThemeIcon('terminal'), location: { viewColumn, preserveFocus: true }, isTransient: true });
		this.terminals.push({ agent, folder, terminal });
		return terminal;
	}

	/** Opens the agent's terminal in `folder` and shows it. */
	async open(agent: string, name: string, folder: string): Promise<void> {
		(await this.terminalFor(agent, name, folder)).show();
	}

	/** Types `command` into the agent's terminal and leaves Return to the user. */
	async insert(agent: string, name: string, folder: string, command: string): Promise<void> {
		const terminal = await this.terminalFor(agent, name, folder);
		terminal.show();
		terminal.sendText(command, false);
	}

	/**
	 * Runs `command` in the agent's terminal in `folder`, shown without taking
	 * focus, and resolves when it ends. Without shell integration the command is
	 * typed in and run, and nothing is known of how it ended.
	 */
	async run(agent: string, name: string, folder: string, command: string, fresh: boolean): Promise<RunOutcome> {
		let terminal = await this.terminalFor(agent, name, folder, fresh);
		if (this.waiters.has(terminal)) {
			// A command Run started still runs there.
			terminal = await this.terminalFor(agent, name, folder, true);
		}
		terminal.show(true);
		const shell = terminal.shellIntegration ?? await this.shellIntegrationOf(terminal);
		if (!shell) {
			terminal.sendText(command, true);
			return {};
		}
		const started = Date.now();
		// A block of several lines runs as several commands, or as fewer when the shell takes lines together
		// (zsh often does with a pasted block): it has ended when as many have ended as it has lines, when one
		// of them fails, or when no further one starts after one ended, the shell being back at its prompt.
		let left = Math.max(1, commandCount(command));
		let idle: ReturnType<typeof setTimeout> | undefined;
		const finished = new Promise<FinishedCommand | undefined>(resolve => {
			const settle = (each: FinishedCommand | undefined) => {
				clearTimeout(idle);
				idle = undefined;
				if (this.waiters.get(terminal) === waiter) {
					this.waiters.delete(terminal);
				}
				resolve(each);
			};
			const waiter: RunWaiter = {
				ended: each => {
					clearTimeout(idle);
					if (!each || --left <= 0 || (each.exitCode !== undefined && each.exitCode !== 0)) {
						settle(each);
					} else {
						idle = setTimeout(() => settle(each), blockIdleMs);
					}
				},
				started: () => clearTimeout(idle),
			};
			this.waiters.set(terminal, waiter);
		});
		shell.executeCommand(command);
		const last = await finished;
		return last ? { ms: Date.now() - started, ...last.exitCode !== undefined ? { exitCode: last.exitCode } : {}, command: last } : {};
	}

	/** Closes the agent's terminals, as when it is removed or merged back and its folders go. */
	closeAgent(agent: string): void {
		for (const each of this.terminals.filter(t => t.agent === agent)) {
			each.terminal.dispose();
		}
	}

	private shellIntegrationOf(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				listener.dispose();
				resolve(terminal.shellIntegration);
			}, shellIntegrationWaitMs);
			const listener = vscode.window.onDidChangeTerminalShellIntegration(event => {
				if (event.terminal === terminal) {
					clearTimeout(timer);
					listener.dispose();
					resolve(event.shellIntegration);
				}
			});
		});
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
		for (const waiter of [...this.waiters.values()]) {
			waiter.ended(undefined);
		}
		this.running.clear();
		this.last.clear();
		this.endedAt.clear();
	}
}
