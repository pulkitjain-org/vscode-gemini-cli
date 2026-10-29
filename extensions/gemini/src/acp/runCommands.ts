/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run on a reply's shell blocks, and terminal output sent to a chat: which
// blocks can run, the commands a block holds, which of an agent's folders a
// command runs in, and the tail of a command's output that is kept. The chat
// page imports `canRun` only; the rest runs in the extension host.

import type { Attachment } from './attachments';

/** Code block languages whose blocks get Run. */
const shellLanguages: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'shell', 'shellscript', 'console', 'fish', 'powershell', 'ps1', 'pwsh']);

/** Whether a code block fenced as `language` gets Run; unfenced blocks do not. */
export function canRun(language: string): boolean {
	return shellLanguages.has(language.trim().toLowerCase());
}

/** The most lines of a command's output kept, and sent to a chat. */
export const maxOutputLines = 200;

/**
 * The commands a block runs, one per line. In a `console` block only lines
 * that start with a prompt (`$ `, else `> ` or `PS> `) run, without the prompt; the rest is
 * output. In other blocks a `$ ` prompt on every line is taken off too, as
 * replies often write one. Empty when nothing would run.
 */
export function blockCommands(language: string, text: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	if (language.trim().toLowerCase() === 'console') {
		// `> ` only without `$ ` prompts: npm's output starts lines with `> ` too.
		const prompt = lines.some(line => /^\s*\$ /.test(line)) ? /^\s*\$ / : /^\s*(PS[^>]*)?> /;
		return lines.filter(line => prompt.test(line)).map(line => line.replace(prompt, '')).join('\n').trim();
	}
	const filled = lines.filter(line => line.trim());
	const prompted = /^\s*\$ /;
	const commands = filled.length && filled.every(line => prompted.test(line)) ? lines.map(line => line.replace(prompted, '')) : lines;
	return commands.join('\n').trim();
}

/** How many commands `command` runs: its lines that are not empty or comments, a line ending in `\` joined with the next. */
export function commandCount(command: string): number {
	return command.replace(/\\\n/g, ' ').split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).length;
}

/** A folder Run can run in: an agent's folder, or one repository of a thread or project. */
export interface RunPlace {
	readonly name: string;
	readonly folder: string;
}

/**
 * Where `command` runs: the only place, or the one place the command names by
 * its folder or by its name as a path (`cd api`, `api/src`). Undefined when
 * there are several and the command names none of them, or more than one.
 */
export function placeFor(command: string, places: readonly RunPlace[]): RunPlace | undefined {
	if (places.length <= 1) {
		return places[0];
	}
	const named = places.filter(place => command.includes(place.folder) || new RegExp(`(^|[\\s'"=/])${escapeRegExp(place.name)}(/|[\\s'";&|]|$)`).test(command));
	return named.length === 1 ? named[0] : undefined;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Terminal control sequences: colours, cursor moves, titles and shell integration marks. */
const controlSequence = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * `text` without terminal control sequences, and with each carriage-return
 * rewrite of a line kept as its last. A line's own ending `\r` (of a `\r\n`
 * split elsewhere) is not a rewrite.
 */
export function plainTerminalText(text: string): string {
	return text.replace(controlSequence, '').split('\n').map(line => {
		const own = line.replace(/\r+$/, '');
		return own.slice(own.lastIndexOf('\r') + 1);
	}).join('\n');
}

/**
 * The last lines of a command's output as it arrives in chunks, at most
 * `max`, as plain text. A chunk can end mid-line or mid-sequence; the rest of
 * that line waits for the next chunk.
 */
export class OutputTail {
	private readonly lines: string[] = [];
	private partial = '';
	private dropped = 0;

	constructor(private readonly max = maxOutputLines) { }

	push(chunk: string): void {
		const text = this.partial + chunk;
		const end = text.lastIndexOf('\n');
		if (end < 0) {
			this.partial = text;
			return;
		}
		this.partial = text.slice(end + 1);
		this.lines.push(...plainTerminalText(text.slice(0, end)).split('\n'));
		const over = this.lines.length - this.max;
		if (over > 0) {
			this.lines.splice(0, over);
			this.dropped += over;
		}
	}

	/** The lines kept, the line still open last and without blank lines at either end; and how many earlier lines were dropped. */
	finish(): { readonly lines: readonly string[]; readonly dropped: number } {
		const last = plainTerminalText(this.partial);
		const lines = last ? [...this.lines, last] : [...this.lines];
		const over = Math.max(0, lines.length - this.max);
		const kept = lines.slice(over);
		while (kept.length && !kept[kept.length - 1].trim()) {
			kept.pop();
		}
		while (kept.length && !kept[0].trim()) {
			kept.shift();
		}
		return { lines: kept, dropped: this.dropped + over };
	}
}

/** A command that ran in a terminal, as kept for sending to a chat. */
export interface FinishedCommand {
	readonly commandLine: string;
	readonly cwd?: string;
	/** Undefined when the shell did not report one. */
	readonly exitCode?: number;
	readonly lines: readonly string[];
	/** Earlier lines of output that were not kept. */
	readonly dropped: number;
}

/** A finished command as the text a chat is sent: the command, where it ran, its exit code and its output. */
export function commandReport(command: FinishedCommand): string {
	const head = [
		`$ ${command.commandLine}`,
		...command.cwd ? [`# in ${command.cwd}`] : [],
		...command.exitCode !== undefined ? [`# exit code ${command.exitCode}`] : [],
		...command.dropped ? [`# output: the last ${command.lines.length} lines (${command.dropped} earlier lines left out)`] : [],
	];
	return [...head, ...command.lines].join('\n');
}

/** The text of a terminal selection sent to a chat, capped to its last `max` lines like a command's output. */
export function selectionReport(selection: string, max = maxOutputLines): string {
	const lines = plainTerminalText(selection).split('\n');
	return lines.length > max ? [`# the last ${max} lines of ${lines.length} selected`, ...lines.slice(-max)].join('\n') : lines.join('\n');
}

/**
 * The command in a model's answer to "a command that does …": the first code
 * block's contents if it has one, else the text, without a `$ ` prompt.
 */
export function commandFromReply(reply: string): string {
	const fenced = /```[\w-]*\n([\s\S]*?)```/.exec(reply)?.[1] ?? reply;
	return blockCommands('sh', fenced.replace(/^`|`$/g, ''));
}

/** A finished command as a chip: "$ npm test", with where it ran, its exit code and its output. */
export function commandAttachment(command: FinishedCommand): Attachment {
	return { kind: 'document', name: `$ ${commandName(command.commandLine)}`, mimeType: 'text/plain', text: commandReport(command) };
}

/** A short name for a command's chip: its first line, cut to `max` characters. */
export function commandName(commandLine: string, max = 40): string {
	const first = commandLine.trim().split('\n')[0];
	return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
