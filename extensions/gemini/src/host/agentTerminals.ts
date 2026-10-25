/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Each agent's terminals, one per folder it works in, and the last command of
// every terminal. Open Terminal and Run on a reply's command use an agent's
// terminal; Send Last Command to Gemini and Run's "Send Output to Gemini" use
// the last command, which is kept from shell integration as it runs (its
// output is only readable by a listener there from its start), capped at the
// last 200 lines and replaced by the next command.

import * as vscode from 'vscode';
import { commandCount, FinishedCommand, OutputTail } from '../acp/runCommands';

/** How long Run waits for a new terminal's shell integration before typing the command in without it. */
const shellIntegrationWaitMs = 3_000;

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
	private readonly running = new Map<vscode.TerminalShellExecution, { readonly tail: OutputTail; readonly done: Promise<void> }>();
	/** Called with each command that finishes in a terminal Run is waiting on. */
	private readonly waiters = new Map<vscode.Terminal, (command: FinishedCommand | undefined) => void>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.disposables.push(
			vscode.window.onDidStartTerminalShellExecution(({ execution }) => {
				const tail = new OutputTail();
				// Read from the start: the stream has only what arrives after it is opened.
				const stream = execution.read();
				const done = (async () => {
					for await (const chunk of stream) {
						tail.push(chunk);
					}
				})().catch(() => undefined);
				this.running.set(execution, { tail, done });
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
				this.waiters.get(terminal)?.(finished);
			}),
			vscode.window.onDidCloseTerminal(terminal => {
				this.last.delete(terminal);
				this.waiters.get(terminal)?.(undefined);
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

	/** The agent's terminal in `folder`, named `name`, made the first time; `fresh` makes another. */
	terminalFor(agent: string, name: string, folder: string, fresh = false): vscode.Terminal {
		const known = fresh ? undefined : this.terminals.find(each => each.agent === agent && each.folder === folder && each.terminal.exitStatus === undefined);
		if (known) {
			return known.terminal;
		}
		const terminal = vscode.window.createTerminal({ name, cwd: folder, iconPath: new vscode.ThemeIcon('terminal') });
		this.terminals.push({ agent, folder, terminal });
		return terminal;
	}

	/** Opens the agent's terminal in `folder` and shows it. */
	open(agent: string, name: string, folder: string): void {
		this.terminalFor(agent, name, folder).show();
	}

	/** Types `command` into the agent's terminal and leaves Return to the user. */
	insert(agent: string, name: string, folder: string, command: string): void {
		const terminal = this.terminalFor(agent, name, folder);
		terminal.show();
		terminal.sendText(command, false);
	}

	/**
	 * Runs `command` in the agent's terminal in `folder`, shown without taking
	 * focus, and resolves when it ends. Without shell integration the command is
	 * typed in and run, and nothing is known of how it ended.
	 */
	async run(agent: string, name: string, folder: string, command: string, fresh: boolean): Promise<RunOutcome> {
		let terminal = this.terminalFor(agent, name, folder, fresh);
		if (this.waiters.has(terminal)) {
			// A command Run started still runs there.
			terminal = this.terminalFor(agent, name, folder, true);
		}
		terminal.show(true);
		const shell = terminal.shellIntegration ?? await this.shellIntegrationOf(terminal);
		if (!shell) {
			terminal.sendText(command, true);
			return {};
		}
		const started = Date.now();
		// A block of several lines runs as several commands; it has ended when the last of them has.
		let left = Math.max(1, commandCount(command));
		const finished = new Promise<FinishedCommand | undefined>(resolve => this.waiters.set(terminal, each => {
			if (!each || --left === 0) {
				this.waiters.delete(terminal);
				resolve(each);
			}
		}));
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
		this.running.clear();
		this.last.clear();
	}
}
