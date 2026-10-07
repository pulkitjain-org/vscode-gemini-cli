/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Gemini CLI's own slash commands, run for GeminiCode's pages rather than
// typed in a chat. gemini-cli 0.62 handles /extensions and /memory itself over
// ACP, without the model: the command's result comes back as the reply's text
// (`CommandHandler.runCommand`), and `/extensions list` sends its list as JSON.
// Each run uses a session of its own, so no chat sees it.

import type * as acp from '@agentclientprotocol/sdk';
import type { AgentRuntime } from './agentRuntime';

/** Commands answer in milliseconds; an install clones a repository. */
const defaultTimeoutMs = 120_000;

/** Runs `/command` in a new session in `cwd` and returns the text it replied with. */
export async function runCliCommand(runtime: AgentRuntime, cwd: string, command: string, timeoutMs = defaultTimeoutMs): Promise<string> {
	const { connection, agent, session } = await runtime.newSession(cwd);
	let reply = '';
	const registration = runtime.register(session.sessionId, {
		sessionUpdate: (update: acp.SessionUpdate) => {
			if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
				reply += update.content.text;
			}
		},
		// A command never asks; refuse anything that does.
		requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`The Gemini CLI did not answer ${command} in time.`)), timeoutMs);
		});
		await Promise.race([connection.prompt(session.sessionId, [{ type: 'text', text: command }]), timeout]);
		return reply;
	} finally {
		clearTimeout(timer);
		registration.dispose();
		if (agent.agentCapabilities?.sessionCapabilities?.close) {
			void connection.close(session.sessionId).catch(() => undefined);
		}
	}
}

/** An installed Gemini CLI extension, as /extensions list reports it. */
export interface CliExtension {
	readonly name: string;
	readonly version: string;
	/** Enabled for this folder. */
	readonly active: boolean;
	/** Where it was installed from: a repository URL or a folder. */
	readonly source?: string;
	/** `git`, `github-release`, `local` or `link`. */
	readonly kind?: string;
	readonly path?: string;
	readonly mcpServers: readonly string[];
	readonly contextFiles: readonly string[];
	readonly skills: number;
	readonly hooks: boolean;
}

/**
 * The extensions in a /extensions list reply: a JSON array, or a sentence when
 * there are none. Settings an extension resolved (which may hold keys) are
 * never read.
 */
export function parseExtensionList(reply: string): CliExtension[] {
	const start = reply.indexOf('[');
	if (start < 0) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(reply.slice(start));
	} catch {
		throw new Error('The Gemini CLI listed its extensions in a form GeminiCode does not know.');
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed.filter(isRecord).filter(e => typeof e.name === 'string').map(e => {
		const install = isRecord(e.installMetadata) ? e.installMetadata : {};
		return {
			name: e.name as string,
			version: typeof e.version === 'string' ? e.version : '',
			active: e.isActive !== false,
			...(typeof install.source === 'string' ? { source: install.source } : {}),
			...(typeof install.type === 'string' ? { kind: install.type } : {}),
			...(typeof e.path === 'string' ? { path: e.path } : {}),
			mcpServers: isRecord(e.mcpServers) ? Object.keys(e.mcpServers) : [],
			contextFiles: Array.isArray(e.contextFiles) ? e.contextFiles.filter((f): f is string => typeof f === 'string') : [],
			skills: Array.isArray(e.skills) ? e.skills.length : 0,
			hooks: isRecord(e.hooks) && Object.keys(e.hooks).length > 0,
		};
	});
}

/** The files a /memory list reply names: one absolute path per line after its heading. */
export function parseMemoryList(reply: string): string[] {
	return reply.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('/') || /^[A-Za-z]:[\\/]/.test(line));
}

/**
 * Whether an install source is safe to pass on: a URL, a GitHub `owner/repo`
 * or a path, with none of the characters the CLI refuses.
 */
export function isExtensionSource(source: string): boolean {
	const text = source.trim();
	return !!text && !/[\s;&|`'"]/.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
