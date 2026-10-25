/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Why a project agent's session has no project tools. gemini-cli 0.63 loads a
// session's MCP servers (`McpClientManager.maybeDiscoverMcpServer`) only when
// the session's folder is trusted, the server isn't left out by `mcp.allowed`
// (which GeminiCode's launch flag makes list its own servers) or `mcp.excluded`
// or turned off by an admin, and `gemini mcp disable` hasn't
// turned it off in mcp-server-enablement.json, which, when unreadable, turns
// every server off. It says none of this over ACP, so GeminiCode reads the
// same files to name the cause.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isRecord, readSettingsFile, updateSettingsFile } from './projectSettings';
import { folderTrustApplies, isFolderTrusted, trustedFoldersPath } from './trustedFolders';

export type ProjectToolsBlock =
	| { readonly kind: 'untrusted'; readonly folder: string }
	| { readonly kind: 'excluded'; readonly file: string }
	| { readonly kind: 'adminOff'; readonly file: string }
	| { readonly kind: 'disabled'; readonly file: string }
	| { readonly kind: 'enablementUnreadable'; readonly file: string };

export interface ProjectToolsCheckOptions {
	/** The session's folder. */
	readonly folder: string;
	/** The MCP server's name. */
	readonly server: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly homedir?: string;
	readonly platform?: NodeJS.Platform;
	/** A workspace folder whose .gemini/settings.json the CLI also merges, such as the team's checked-in allowlist. */
	readonly workspace?: string;
}

/** The first thing that keeps the CLI from loading `server` in `folder`, or undefined when nothing in its files does. */
export async function projectToolsBlock(options: ProjectToolsCheckOptions): Promise<ProjectToolsBlock | undefined> {
	const env = options.env ?? process.env;
	const homedir = options.homedir ?? os.homedir();
	if (await folderTrustApplies(env, homedir) && await isFolderTrusted(trustedFoldersPath(env, homedir), options.folder) !== true) {
		return { kind: 'untrusted', folder: options.folder };
	}
	const geminiDir = path.join(env.GEMINI_CLI_HOME || homedir, '.gemini');
	const settingsBlock = await allowlistBlock(options.server, settingsFiles({ ...options, env, homedir }));
	if (settingsBlock) {
		return settingsBlock;
	}
	const enablement = path.join(geminiDir, 'mcp-server-enablement.json');
	let text: string | undefined;
	try {
		text = await fs.readFile(enablement, 'utf8');
	} catch {
		// No file: every server is on.
	}
	if (text !== undefined) {
		// Read as the CLI reads it: plain JSON, and an object.
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return { kind: 'enablementUnreadable', file: enablement };
		}
		const entry = (parsed as Record<string, { enabled?: unknown } | undefined>)[options.server.trim().toLowerCase()];
		if (entry?.enabled === false) {
			return { kind: 'disabled', file: enablement };
		}
	}
	return undefined;
}

/** The settings files that can leave a server out, highest precedence first: system, the workspace's, the user's, then the system defaults. */
export function settingsFiles(options: Omit<ProjectToolsCheckOptions, 'folder' | 'server'>): string[] {
	const env = options.env ?? process.env;
	const homedir = options.homedir ?? os.homedir();
	const system = systemSettingsPath(env, options.platform ?? process.platform);
	return [
		system,
		...options.workspace ? [path.join(options.workspace, '.gemini', 'settings.json')] : [],
		path.join(env.GEMINI_CLI_HOME || homedir, '.gemini', 'settings.json'),
		env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH || path.join(path.dirname(system), 'system-defaults.json'),
	];
}

/**
 * The first of `files` that turns MCP off or puts `server` in `mcp.excluded`.
 * `mcp.allowed` can't leave out GeminiCode's own servers: `allowlistWith` adds them.
 */
export async function allowlistBlock(server: string, files: readonly string[]): Promise<Extract<ProjectToolsBlock, { kind: 'excluded' | 'adminOff' }> | undefined> {
	for (const file of files) {
		const settings = await readSettingsFile(file);
		const mcp = settings.mcp as { excluded?: unknown } | undefined;
		const admin = (settings.admin as { mcp?: { enabled?: unknown } } | undefined)?.mcp;
		if (admin?.enabled === false) {
			return { kind: 'adminOff', file };
		}
		if (Array.isArray(mcp?.excluded) && mcp.excluded.includes(server)) {
			return { kind: 'excluded', file };
		}
	}
	return undefined;
}

/**
 * The `--allowed-mcp-server-names` list that keeps the allowlist `files` set and adds `servers`, or
 * undefined when it already has them or none is set. As gemini-cli 0.64 reads them, the allowlist is the
 * intersection of every file's `mcp.allowed`, and an empty one allows every server. The flag replaces
 * both `mcp.allowed` and `mcp.excluded`, so the list leaves out the excluded servers itself.
 */
export async function allowlistWith(servers: readonly string[], files: readonly string[]): Promise<string[] | undefined> {
	const key = (name: string) => name.toLowerCase().trim();
	const names = (value: unknown) => Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : undefined;
	let allowed: string[] | undefined;
	const excluded = new Set<string>();
	for (const settings of await Promise.all(files.map(readSettingsFile))) {
		const mcp = settings.mcp as { allowed?: unknown; excluded?: unknown } | undefined;
		const fileAllowed = names(mcp?.allowed);
		if (fileAllowed) {
			const keys = new Set(fileAllowed.map(key));
			allowed = (allowed ?? fileAllowed).filter(name => keys.has(key(name)));
		}
		for (const name of names(mcp?.excluded) ?? []) {
			excluded.add(key(name));
		}
	}
	if (!allowed?.length) {
		return undefined;
	}
	const listed = new Set(allowed.map(key));
	if (servers.every(server => listed.has(key(server)))) {
		return undefined;
	}
	return [...new Set([...allowed, ...servers.filter(server => !listed.has(key(server)))])].filter(name => !excluded.has(key(name)));
}

/**
 * Lets `server` load per `file`: adds it to `mcp.allowed` and takes it out of
 * `mcp.excluded`. Returns false, leaving the file alone, when it has comments.
 */
export function allowServer(file: string, server: string): Promise<boolean> {
	return updateSettingsFile(file, settings => {
		const mcp = isRecord(settings.mcp) ? settings.mcp : {};
		if (Array.isArray(mcp.allowed) && mcp.allowed.length && !mcp.allowed.includes(server)) {
			mcp.allowed = [...mcp.allowed, server];
		}
		if (Array.isArray(mcp.excluded)) {
			mcp.excluded = mcp.excluded.filter(name => name !== server);
		}
		settings.mcp = mcp;
	});
}

/** Mirrors gemini-cli's `getSystemSettingsPath`. */
function systemSettingsPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	return env.GEMINI_CLI_SYSTEM_SETTINGS_PATH
		|| (platform === 'darwin' ? '/Library/Application Support/GeminiCli/settings.json' : platform === 'win32' ? 'C:\\ProgramData\\gemini-cli\\settings.json' : '/etc/gemini-cli/settings.json');
}
