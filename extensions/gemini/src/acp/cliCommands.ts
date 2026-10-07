/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Gemini CLI's own slash commands, run for GeminiCode's pages rather than
// typed in a chat. gemini-cli 0.62 handles /extensions and /memory itself over
// ACP, without the model: the command's result comes back as the reply's text
// (`CommandHandler.runCommand`), and `/extensions list` sends its list as JSON.
// The commands of one run share a hidden session of their own, so no chat sees
// them, and a command the CLI does not list in `available_commands_update` is
// never sent: it would reach the model as a prompt.

import type * as acp from '@agentclientprotocol/sdk';
import type { AgentRuntime } from './agentRuntime';

/** Commands answer in milliseconds; an install clones a repository. */
const defaultTimeoutMs = 120_000;
/** How long a new session's command list is waited for; gemini-cli sends it as soon as the session opens. */
const commandListMs = 2_000;

/** The command a `/name args` line runs: `name`, without the slash. */
function commandName(line: string): string {
	return line.trim().replace(/^\//, '').split(/\s+/)[0];
}

/**
 * Runs each `/command` in turn in one new session in `cwd` and returns the
 * text each replied with, or `undefined` for one the CLI does not offer. A
 * command that does not answer within `timeoutMs` is cancelled and the run
 * rejects. The session is closed afterwards when the CLI can close sessions.
 */
export async function runCliCommands(runtime: AgentRuntime, cwd: string, commands: readonly string[], timeoutMs = defaultTimeoutMs, listWaitMs = commandListMs): Promise<(string | undefined)[]> {
	const { connection, agent, session } = await runtime.newSession(cwd);
	const sessionId = session.sessionId;
	let reply = '';
	let offered: ReadonlySet<string> | undefined;
	let onOffered: (() => void) | undefined;
	const registration = runtime.register(sessionId, {
		sessionUpdate: (update: acp.SessionUpdate) => {
			if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
				reply += update.content.text;
			} else if (update.sessionUpdate === 'available_commands_update') {
				offered = new Set(update.availableCommands.filter(c => typeof c.name === 'string').map(c => commandName(c.name)));
				onOffered?.();
			}
		},
		// A command never asks; refuse anything that does.
		requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		if (!offered) {
			await new Promise<void>(resolve => {
				timer = setTimeout(resolve, listWaitMs);
				onOffered = resolve;
			});
			clearTimeout(timer);
		}
		const replies: (string | undefined)[] = [];
		for (const command of commands) {
			if (!offered?.has(commandName(command))) {
				replies.push(undefined);
				continue;
			}
			reply = '';
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					void connection.cancel(sessionId).catch(() => undefined);
					reject(new Error(`The Gemini CLI did not answer ${command} in time.`));
				}, timeoutMs);
			});
			try {
				await Promise.race([connection.prompt(sessionId, [{ type: 'text', text: command }]), timeout]);
			} finally {
				clearTimeout(timer);
			}
			replies.push(reply);
		}
		return replies;
	} finally {
		clearTimeout(timer);
		registration.dispose();
		if (agent.agentCapabilities?.sessionCapabilities?.close) {
			void connection.close(sessionId).catch(() => undefined);
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
