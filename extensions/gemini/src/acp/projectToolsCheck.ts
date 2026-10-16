/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Why a project agent's session has no project tools. gemini-cli 0.63 loads a
// session's MCP servers (`McpClientManager.maybeDiscoverMcpServer`) only when
// the session's folder is trusted, the server isn't left out by `mcp.allowed`
// or `mcp.excluded` or turned off by an admin, and `gemini mcp disable` hasn't
// turned it off in mcp-server-enablement.json, which, when unreadable, turns
// every server off. It says none of this over ACP, so GeminiCode reads the
// same files to name the cause.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readSettingsFile } from './projectSettings';
import { folderTrustApplies, isFolderTrusted, trustedFoldersPath } from './trustedFolders';

export type ProjectToolsBlock =
	| { readonly kind: 'untrusted'; readonly folder: string }
	| { readonly kind: 'notAllowed'; readonly file: string }
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
}

/** The first thing that keeps the CLI from loading `server` in `folder`, or undefined when nothing in its files does. */
export async function projectToolsBlock(options: ProjectToolsCheckOptions): Promise<ProjectToolsBlock | undefined> {
	const env = options.env ?? process.env;
	const homedir = options.homedir ?? os.homedir();
	if (folderTrustApplies(env, homedir) && isFolderTrusted(trustedFoldersPath(env, homedir), options.folder) !== true) {
		return { kind: 'untrusted', folder: options.folder };
	}
	const geminiDir = path.join(env.GEMINI_CLI_HOME || homedir, '.gemini');
	// System settings override the user's, as the CLI merges them.
	for (const file of [systemSettingsPath(env, options.platform ?? process.platform), path.join(geminiDir, 'settings.json')]) {
		const settings = await readSettingsFile(file);
		const mcp = settings.mcp as { allowed?: unknown; excluded?: unknown } | undefined;
		const admin = (settings.admin as { mcp?: { enabled?: unknown } } | undefined)?.mcp;
		if (admin?.enabled === false) {
			return { kind: 'adminOff', file };
		}
		if (Array.isArray(mcp?.allowed) && mcp.allowed.length && !mcp.allowed.includes(options.server)) {
			return { kind: 'notAllowed', file };
		}
		if (Array.isArray(mcp?.excluded) && mcp.excluded.includes(options.server)) {
			return { kind: 'excluded', file };
		}
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

/** Mirrors gemini-cli's `getSystemSettingsPath`. */
function systemSettingsPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	return env.GEMINI_CLI_SYSTEM_SETTINGS_PATH
		|| (platform === 'darwin' ? '/Library/Application Support/GeminiCli/settings.json' : platform === 'win32' ? 'C:\\ProgramData\\gemini-cli\\settings.json' : '/etc/gemini-cli/settings.json');
}
