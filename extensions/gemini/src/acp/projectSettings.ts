/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the MCP Servers and Rules page reads and writes: the MCP servers in the
// Gemini CLI's settings files, which of them the CLI has switched off, and
// where its rules (GEMINI.md) files are. Mirrors gemini-cli 0.62:
// `McpServerEnablementManager` keeps switched-off servers in
// ~/.gemini/mcp-server-enablement.json by lowercased name, and
// `context.fileName` names the rules files.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerEntry {
	readonly name: string;
	readonly transport: McpTransport;
	/** The command line or URL, for display. */
	readonly target: string;
	/** The settings file it is in. */
	readonly file: string;
}

/** Reads a settings file the way the CLI does: JSON with comments and trailing commas. Missing or broken files read as empty. */
export async function readSettingsFile(file: string): Promise<Record<string, unknown>> {
	let text: string;
	try {
		text = await fs.readFile(file, 'utf8');
	} catch {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(stripJsonComments(text));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** The MCP servers a settings object defines, in its order. */
export function mcpServersIn(settings: Record<string, unknown>, file: string): McpServerEntry[] {
	const servers = settings.mcpServers;
	if (!isRecord(servers)) {
		return [];
	}
	return Object.entries(servers).filter(([, config]) => isRecord(config)).map(([name, raw]) => {
		const config = raw as Record<string, unknown>;
		if (typeof config.httpUrl === 'string') {
			return { name, transport: 'http', target: config.httpUrl, file };
		}
		if (typeof config.url === 'string') {
			return { name, transport: config.type === 'http' ? 'http' : 'sse', target: config.url, file };
		}
		const args = Array.isArray(config.args) ? config.args.filter((a): a is string => typeof a === 'string') : [];
		return { name, transport: 'stdio', target: [typeof config.command === 'string' ? config.command : '', ...args].join(' ').trim(), file };
	});
}

/** The rules file names: `context.fileName` (a name or a list), else GEMINI.md. */
export function rulesFileNames(settings: Record<string, unknown>): string[] {
	const context = settings.context;
	const fileName = isRecord(context) ? context.fileName : undefined;
	const names = typeof fileName === 'string' ? [fileName] : Array.isArray(fileName) ? fileName.filter((n): n is string => typeof n === 'string' && !!n) : [];
	return names.length ? names : ['GEMINI.md'];
}

function serverKey(name: string): string {
	return name.toLowerCase().trim();
}

/** The names, lowercased, of the servers the CLI has switched off. */
export async function disabledServers(enablementFile: string): Promise<Set<string>> {
	const config = await readSettingsFile(enablementFile);
	return new Set(Object.entries(config).filter(([, state]) => isRecord(state) && state.enabled === false).map(([name]) => name));
}

export function isServerEnabled(disabled: ReadonlySet<string>, name: string): boolean {
	return !disabled.has(serverKey(name));
}

/** Switches a server on or off for the CLI, as its /mcp enable and disable commands do. */
export async function setServerEnabled(enablementFile: string, name: string, enabled: boolean): Promise<void> {
	const config = await readSettingsFile(enablementFile);
	const key = serverKey(name);
	if (enabled) {
		if (config[key] === undefined) {
			return;
		}
		delete config[key];
	} else {
		config[key] = { enabled: false };
	}
	await fs.mkdir(path.dirname(enablementFile), { recursive: true });
	await fs.writeFile(enablementFile, JSON.stringify(config, null, 2), 'utf8');
}

/** A server's settings from what the user typed: a URL, or a command line. */
export function serverConfigFrom(input: string): Record<string, unknown> {
	const text = input.trim();
	if (/^https?:\/\//i.test(text)) {
		// Streamable HTTP is what current servers speak; the CLI takes SSE with `url`.
		return /\/sse\/?$/i.test(text) ? { url: text } : { httpUrl: text };
	}
	const words = [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
	return { command: words[0] ?? '', ...(words.length > 1 ? { args: words.slice(1) } : {}) };
}

/**
 * Adds a server to a settings file. Returns false, leaving the file alone,
 * when it has comments (rewriting it would lose them) or is not an object.
 */
export async function addMcpServer(file: string, name: string, config: Record<string, unknown>): Promise<boolean> {
	let text = '';
	try {
		text = await fs.readFile(file, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
	}
	let settings: unknown = {};
	if (text.trim()) {
		try {
			settings = JSON.parse(text);
		} catch {
			return false;
		}
	}
	if (!isRecord(settings)) {
		return false;
	}
	const servers = isRecord(settings.mcpServers) ? settings.mcpServers : {};
	settings.mcpServers = { ...servers, [name]: config };
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
	return true;
}

/** Removes comments and trailing commas outside strings. */
export function stripJsonComments(text: string): string {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			const start = i;
			for (i++; i < text.length && text[i] !== '"'; i++) {
				if (text[i] === '\\') {
					i++;
				}
			}
			out += text.slice(start, i + 1);
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') {
				i++;
			}
			out += '\n';
		} else if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 1;
		} else if (c === '}' || c === ']') {
			// A trailing comma; only here, outside strings.
			out = out.replace(/,(\s*)$/, '$1') + c;
		} else {
			out += c;
		}
	}
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
