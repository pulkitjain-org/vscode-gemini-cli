/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Team commands whose prompt pulls in a file with @{path} or a command's
// output with !{command}, as the Gemini CLI's custom commands do
// (gemini-cli 0.63 `AtFileProcessor` and `ShellProcessor`). Over ACP the CLI
// runs no custom commands, so GeminiCode expands them before sending.
//
// Differences from the CLI, on purpose: the template is read once, so a file's
// text or a command's output is never searched for more !{...}; a file goes
// through GeminiCode's own file rules; and a folder is not read.

import { spawn } from 'node:child_process';
import { expandTeamCommand, parseInvocation, TeamCommand } from './slashCommands';

const argsPlaceholder = '{{args}}';

export interface ExpansionHost {
	readonly platform: NodeJS.Platform;
	/** The text of the file `@{pathText}` names; throws with the reason when it cannot be read. */
	readFile(pathText: string): Promise<string>;
	/** Asks before any command runs; false stops the team command. */
	confirm(commands: readonly string[]): Promise<boolean>;
	runShell(command: string): Promise<ShellResult>;
}

export interface ShellResult {
	/** Standard output and error, in the order they came. */
	readonly output: string;
	readonly exitCode: number | null;
	readonly signal?: string | null;
	readonly timedOut?: boolean;
}

export interface Expansion {
	readonly text: string;
	/** Files that could not be pulled in, and why; their @{...} stays in the prompt, as in the CLI. */
	readonly problems: readonly string[];
}

/** The user said no to the team command's shell commands. */
export class TeamCommandCancelled extends Error {
	constructor(name: string) {
		super(`/${name} was not run.`);
	}
}

interface Injection {
	readonly kind: 'shell' | 'file';
	readonly content: string;
	readonly start: number;
	readonly end: number;
}

/** Whether a team command's prompt reads a file or runs a command. */
export function usesInjections(prompt: string): boolean {
	return prompt.includes('!{') || prompt.includes('@{');
}

/**
 * The !{...} and @{...} in `prompt`, in order. Braces inside are counted, so
 * `!{echo {a,b}}` is one command. Throws on an unclosed one, like the CLI.
 */
export function findInjections(prompt: string, name: string): Injection[] {
	const injections: Injection[] = [];
	let index = 0;
	while (index < prompt.length) {
		const shell = prompt.indexOf('!{', index);
		const file = prompt.indexOf('@{', index);
		const start = shell < 0 ? file : file < 0 ? shell : Math.min(shell, file);
		if (start < 0) {
			break;
		}
		let depth = 1;
		let i = start + 2;
		for (; i < prompt.length && depth; i++) {
			if (prompt[i] === '{') {
				depth++;
			} else if (prompt[i] === '}') {
				depth--;
			}
		}
		if (depth) {
			throw new Error(`/${name} has an unclosed ${prompt.slice(start, start + 2)} at character ${start}. Make sure its braces are balanced.`);
		}
		injections.push({ kind: start === shell ? 'shell' : 'file', content: prompt.slice(start + 2, i - 1).trim(), start, end: i });
		index = i;
	}
	return injections;
}

/** `value` quoted as one argument for the shell `runShell` uses: sh, or cmd.exe on Windows. */
export function quoteShellArg(value: string, platform: NodeJS.Platform): string {
	return platform === 'win32' ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The prompt a team command sends. `{{args}}` becomes the arguments as typed,
 * and inside !{...} the arguments quoted for the shell. Every command is
 * confirmed at once, before any runs.
 */
export async function expandTeamCommandWithInjections(command: TeamCommand, invocation: string, host: ExpansionHost): Promise<Expansion> {
	if (!usesInjections(command.prompt)) {
		return { text: expandTeamCommand(command, invocation), problems: [] };
	}
	const { args } = parseInvocation(invocation) ?? { args: '' };
	const injections = findInjections(command.prompt, command.name);
	const quoted = quoteShellArg(args, host.platform);
	const commands = injections.filter(i => i.kind === 'shell' && i.content).map(i => i.content.split(argsPlaceholder).join(quoted));
	if (commands.length && !await host.confirm([...new Set(commands)])) {
		throw new TeamCommandCancelled(command.name);
	}
	const problems: string[] = [];
	let text = '';
	let last = 0;
	let next = 0;
	for (const injection of injections) {
		text += command.prompt.slice(last, injection.start).split(argsPlaceholder).join(args);
		last = injection.end;
		if (injection.kind === 'file') {
			try {
				text += await host.readFile(injection.content);
			} catch (err) {
				problems.push(`@{${injection.content}}: ${err instanceof Error ? err.message : String(err)}`);
				text += command.prompt.slice(injection.start, injection.end);
			}
		} else if (injection.content) {
			const line = commands[next++];
			const result = await host.runShell(line);
			text += result.output;
			if (result.timedOut) {
				text += `\n[Shell command '${line}' timed out]`;
			} else if (result.exitCode !== 0 && result.exitCode !== null) {
				text += `\n[Shell command '${line}' exited with code ${result.exitCode}]`;
			} else if (result.signal) {
				text += `\n[Shell command '${line}' terminated by signal ${result.signal}]`;
			}
		}
	}
	text += command.prompt.slice(last).split(argsPlaceholder).join(args);
	// Like the CLI, a template without {{args}} gets the whole invocation after it.
	if (!command.prompt.includes(argsPlaceholder) && args) {
		text += `\n\n${invocation.trim()}`;
	}
	return { text, problems };
}

/** At most this much of a command's output goes into the prompt. */
const maxOutputChars = 100_000;

/** Runs `command` in the user's shell in `cwd`, stopping it and anything it started after `timeoutMs`. */
export function runShellCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<ShellResult> {
	return new Promise(resolve => {
		let output = '';
		let done = false;
		// Its own process group, so a timeout stops the shell's children too.
		const child = spawn(command, { cwd, env, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		const finish = (result: Omit<ShellResult, 'output'>) => {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			const text = output.length > maxOutputChars ? `${output.slice(0, maxOutputChars)}\n[Output cut at ${maxOutputChars} characters]` : output;
			resolve({ output: text, ...result });
		};
		const add = (chunk: Buffer) => {
			if (output.length < maxOutputChars) {
				output += chunk.toString('utf8');
			}
		};
		child.stdout.on('data', add);
		child.stderr.on('data', add);
		const timer = setTimeout(() => {
			stopTree(child.pid);
			finish({ exitCode: null, timedOut: true });
		}, timeoutMs);
		child.on('error', err => {
			output += err.message;
			finish({ exitCode: null });
		});
		child.on('close', (exitCode, signal) => finish({ exitCode, signal }));
	});
}

function stopTree(pid: number | undefined): void {
	if (!pid) {
		return;
	}
	try {
		if (process.platform === 'win32') {
			spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
		} else {
			process.kill(-pid, 'SIGKILL');
		}
	} catch {
		// Already gone.
	}
}
