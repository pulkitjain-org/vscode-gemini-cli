/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Slash commands in the composer. Two kinds:
//
//   cli   The commands the agent lists in `available_commands_update` (/init,
//         /memory, /restore, ...). The prompt goes to the agent as typed and
//         the agent runs the command itself.
//   skill Agent skills (skills.ts); picking one asks the agent to load it.
//   team  Prompts saved as TOML under .gemini/commands, the format the Gemini
//         CLI uses for custom commands. gemini-cli 0.63 does not run these
//         over ACP, so GeminiCode expands the template before sending, with
//         its @{file} and !{command} (teamCommandExpansion.ts).

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SlashCommand {
	/** Without the slash, such as "init" or "git:commit". */
	readonly name: string;
	readonly description: string;
	/** The agent's, the team's (.gemini/commands), a skill (.gemini/skills), or GeminiCode's own, such as /resume. */
	readonly source: 'cli' | 'team' | 'skill' | 'app';
}

export interface TeamCommand extends SlashCommand {
	readonly source: 'team';
	readonly prompt: string;
	/** The file it came from, for the log. */
	readonly file: string;
}

/** The command name and its arguments when `text` starts with "/name". */
export function parseInvocation(text: string): { name: string; args: string } | undefined {
	const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? { name: match[1], args: (match[2] ?? '').trim() } : undefined;
}

/**
 * The prompt a team command sends: `{{args}}` replaced with the arguments, or,
 * like the CLI, the whole invocation appended when the template has no
 * `{{args}}` and arguments were given.
 */
export function expandTeamCommand(command: TeamCommand, invocation: string): string {
	const { args } = parseInvocation(invocation) ?? { args: '' };
	if (command.prompt.includes('{{args}}')) {
		return command.prompt.split('{{args}}').join(args);
	}
	return args ? `${command.prompt}\n\n${invocation.trim()}` : command.prompt;
}

/**
 * The commands for the menu: the team's own first, since they are what people
 * reach for, then the agent's. A team command whose name the agent uses is
 * left out, because the agent's runs (as in the CLI).
 */
export function mergeCommands(cli: readonly SlashCommand[], team: readonly SlashCommand[]): SlashCommand[] {
	const taken = new Set(cli.map(c => c.name));
	return [...team.filter(c => !taken.has(c.name)), ...cli].map(({ name, description, source }) => ({ name, description, source }));
}

/** The folders team commands are read from: the user's, then the project's, which wins on a clash. */
export function teamCommandFolders(cwd: string, home = os.homedir()): string[] {
	const user = path.join(home, '.gemini', 'commands');
	const project = path.join(cwd, '.gemini', 'commands');
	return user === project ? [user] : [user, project];
}

/** Larger files are skipped; a prompt template is a few kilobytes. */
const maxFileBytes = 64 * 1024;
/** Enough for any real team; stops a runaway folder from slowing the menu. */
const maxFiles = 200;

export interface LoadResult {
	readonly commands: readonly TeamCommand[];
	/** Files that could not be used, and why, for the log. */
	readonly skipped: readonly { readonly file: string; readonly reason: string }[];
}

/** Reads the team commands under `folders`; a later folder's command replaces an earlier one with the same name. */
export async function loadTeamCommands(folders: readonly string[]): Promise<LoadResult> {
	const byName = new Map<string, TeamCommand>();
	const skipped: { file: string; reason: string }[] = [];
	for (const folder of folders) {
		for (const file of await tomlFiles(folder)) {
			const name = path.relative(folder, file).replace(/\.toml$/i, '').split(path.sep).join(':');
			try {
				const stat = await fs.stat(file);
				if (stat.size > maxFileBytes) {
					skipped.push({ file, reason: 'larger than 64 KB' });
					continue;
				}
				const fields = parseToml(await fs.readFile(file, 'utf8'));
				const prompt = fields.prompt;
				if (typeof prompt !== 'string' || !prompt.trim()) {
					skipped.push({ file, reason: 'no prompt' });
					continue;
				}
				const description = typeof fields.description === 'string' && fields.description.trim()
					? fields.description.trim()
					: firstLine(prompt);
				byName.set(name, { name, description, source: 'team', prompt, file });
			} catch (err) {
				skipped.push({ file, reason: err instanceof Error ? err.message : String(err) });
			}
		}
	}
	return { commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), skipped };
}

async function tomlFiles(folder: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return; // No such folder: no commands.
		}
		for (const entry of entries) {
			if (found.length >= maxFiles) {
				return;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory() && depth < 4 && !entry.name.startsWith('.')) {
				await walk(full, depth + 1);
			} else if (entry.isFile() && /\.toml$/i.test(entry.name)) {
				found.push(full);
			}
		}
	};
	await walk(folder, 0);
	return found.sort();
}

function firstLine(text: string): string {
	const line = text.split('\n').map(l => l.trim()).find(Boolean) ?? '';
	return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/**
 * The top-level string keys of a TOML file: basic and literal strings,
 * single-line or multi-line. That is all a command file holds; anything else
 * is ignored rather than rejected.
 */
export function parseToml(text: string): Record<string, string> {
	const result: Record<string, string> = {};
	let i = 0;
	const n = text.length;
	const skipLine = () => {
		while (i < n && text[i] !== '\n') {
			i++;
		}
		i++;
	};
	while (i < n) {
		// Skip blank space and comments between entries.
		while (i < n && /\s/.test(text[i])) {
			i++;
		}
		if (i >= n) {
			break;
		}
		if (text[i] === '#') {
			skipLine();
			continue;
		}
		if (text[i] === '[') {
			// A table: its keys are not top-level, so stop here.
			break;
		}
		const keyMatch = /^([A-Za-z0-9_-]+)\s*=\s*/.exec(text.slice(i));
		if (!keyMatch) {
			skipLine();
			continue;
		}
		const key = keyMatch[1];
		i += keyMatch[0].length;
		const value = readString();
		if (value === undefined) {
			skipLine();
		} else {
			result[key] = value;
		}
	}
	return result;

	function readString(): string | undefined {
		for (const quote of ['"""', '\'\'\''] as const) {
			if (text.startsWith(quote, i)) {
				i += 3;
				// A newline right after the opening quotes is not part of the string.
				if (text[i] === '\r' && text[i + 1] === '\n') {
					i += 2;
				} else if (text[i] === '\n') {
					i++;
				}
				const end = text.indexOf(quote, i);
				if (end < 0) {
					return undefined;
				}
				const raw = text.slice(i, end);
				i = end + 3;
				return quote === '"""' ? unescapeBasic(raw.replace(/\\\r?\n\s*/g, '')) : raw;
			}
		}
		if (text[i] === '\'') {
			const end = text.indexOf('\'', i + 1);
			const newline = text.indexOf('\n', i + 1);
			if (end < 0 || (newline >= 0 && newline < end)) {
				return undefined;
			}
			const raw = text.slice(i + 1, end);
			i = end + 1;
			return raw;
		}
		if (text[i] === '"') {
			let j = i + 1;
			while (j < n && text[j] !== '"' && text[j] !== '\n') {
				j += text[j] === '\\' ? 2 : 1;
			}
			if (text[j] !== '"') {
				return undefined;
			}
			const raw = text.slice(i + 1, j);
			i = j + 1;
			return unescapeBasic(raw);
		}
		return undefined;
	}
}

function unescapeBasic(raw: string): string {
	return raw.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_, esc: string) => {
		switch (esc[0]) {
			case 'n': return '\n';
			case 't': return '\t';
			case 'r': return '\r';
			case 'b': return '\b';
			case 'f': return '\f';
			case '"': return '"';
			case '\\': return '\\';
			case 'u':
			case 'U': return String.fromCodePoint(parseInt(esc.slice(1), 16));
			default: return `\\${esc}`;
		}
	});
}
