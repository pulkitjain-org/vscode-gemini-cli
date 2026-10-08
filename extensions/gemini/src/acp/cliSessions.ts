/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Gemini CLI's saved sessions for a folder, so an agent can reopen one
// that started in the terminal. gemini-cli 0.62 has no `session/list` over
// ACP, but its `session/load` takes any session id saved for the folder, the
// way `gemini --resume` does. So GeminiCode reads the CLI's session files
// itself, read-only, as the CLI lays them out:
//
//   ~/.gemini/projects.json             { "projects": { "<folder>": "<project id>" } }
//   ~/.gemini/tmp/<project id>/chats/   session-<time>-<id>.jsonl (or .json, older)
//
// A .jsonl file is a list of records: the session's metadata, messages (with
// an `id`), metadata updates (`$set`) and rewinds (`$rewindTo`). An older
// .json file is one object with a `messages` array. Anything unexpected makes
// a file count as having no session; a changed layout gives an empty list,
// never an error.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CliSession {
	readonly id: string;
	/** The CLI's summary of the session, else its first prompt's first line. */
	readonly title: string;
	/** The first prompt, to check that the agent opened the right session. */
	readonly firstPrompt: string;
	/** Prompts the user sent. */
	readonly messages: number;
	/** Last activity, in ms since the epoch. */
	readonly updatedAt: number;
	/**
	 * The session's number in `gemini --list-sessions`, which `session/load`
	 * also takes. Loading by number matters: loading a saved session by its
	 * id makes gemini-cli 0.62 reset the session's saved messages before it
	 * reads them, so the load fails and the session is lost.
	 */
	readonly index: number;
}

/** One session file's session, before the list is put together. */
export interface ParsedSession {
	readonly id: string;
	readonly title: string;
	readonly prompts: readonly string[];
	/** Whether the CLI would offer it: it has a prompt or a reply. */
	readonly resumable: boolean;
	readonly startedAt: number;
	readonly updatedAt: number;
	/** The token counts the CLI saved with its replies; unset when it saved none. */
	readonly tokens?: SessionTokens;
}

/** What a session's model requests used, from the counts the CLI saves with each reply. */
export interface SessionTokens {
	/** The latest request's input tokens: how much of the context window the conversation fills. */
	readonly context: number;
	/** The model of that request. */
	readonly model?: string;
	/** Input tokens served from the cache, summed over the session's replies. */
	readonly cached: number;
}

/** The CLI's own folder: ~/.gemini, or under GEMINI_CLI_HOME when that is set. */
export function cliHome(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
}

/** The folder the CLI saves `cwd`'s sessions in, if it ever saved any. */
export async function chatsFolder(cwd: string, home = cliHome()): Promise<string | undefined> {
	const key = path.resolve(cwd);
	const candidates: string[] = [];
	try {
		const registry = JSON.parse(await fs.readFile(path.join(home, 'projects.json'), 'utf8')) as { projects?: Record<string, unknown> };
		const id = registry.projects?.[key];
		if (typeof id === 'string' && id && !id.includes('/') && !id.includes('\\') && id !== '..') {
			candidates.push(id);
		}
	} catch {
		// No registry yet: CLIs before it named the folder by a hash of the path.
	}
	candidates.push(createHash('sha256').update(key).digest('hex'));
	for (const id of candidates) {
		const folder = path.join(home, 'tmp', id, 'chats');
		if (await isFolder(folder)) {
			return folder;
		}
	}
	return undefined;
}

interface CachedFile {
	readonly mtime: number;
	readonly size: number;
	readonly session: ParsedSession | undefined;
}

/** Parsed files by path, so listing again reads only the files that changed. */
const parsedFiles = new Map<string, CachedFile>();
const maxCachedFiles = 2000;

/**
 * Every session the CLI would offer for `cwd`, numbered as it numbers them:
 * one per id (its latest file), oldest first by start time.
 */
async function numberedSessions(cwd: string, home?: string): Promise<CliSession[]> {
	const folder = await chatsFolder(cwd, home);
	if (!folder) {
		return [];
	}
	let names: string[];
	try {
		names = (await fs.readdir(folder)).filter(name => name.startsWith('session-') && (name.endsWith('.jsonl') || name.endsWith('.json'))).sort();
	} catch {
		return [];
	}
	const parsed = await Promise.all(names.map(name => readSessionFile(path.join(folder, name))));
	// As the CLI does: drop what it would not offer, keep each id's latest file, then order by start.
	const byId = new Map<string, ParsedSession>();
	for (const session of parsed) {
		if (session?.resumable && (byId.get(session.id)?.updatedAt ?? -Infinity) < session.updatedAt) {
			byId.set(session.id, session);
		}
	}
	return [...byId.values()]
		.sort((a, b) => a.startedAt - b.startedAt)
		.map((session, i) => ({
			id: session.id,
			title: session.title,
			firstPrompt: session.prompts[0] ?? '',
			messages: session.prompts.length,
			updatedAt: session.updatedAt,
			index: i + 1,
		}));
}

async function readSessionFile(file: string): Promise<ParsedSession | undefined> {
	try {
		const stat = await fs.stat(file);
		const cached = parsedFiles.get(file);
		if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
			return cached.session;
		}
		const session = parseSessionFile(await fs.readFile(file, 'utf8'), file.endsWith('.json'), stat.mtimeMs);
		if (parsedFiles.size >= maxCachedFiles) {
			parsedFiles.clear();
		}
		parsedFiles.set(file, { mtime: stat.mtimeMs, size: stat.size, session });
		return session;
	} catch {
		return undefined;
	}
}

/**
 * The sessions saved for `cwd` that have a prompt of the user's, newest
 * first, without `exclude`.
 */
export async function listCliSessions(cwd: string, options: { readonly exclude?: ReadonlySet<string>; readonly home?: string } = {}): Promise<CliSession[]> {
	return (await numberedSessions(cwd, options.home))
		.filter(session => session.messages > 0 && !options.exclude?.has(session.id))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Session `id` as the CLI numbers it now, to load it by; undefined when the CLI would not offer it. */
export async function findCliSession(cwd: string, id: string, home?: string): Promise<CliSession | undefined> {
	return (await numberedSessions(cwd, home)).find(session => session.id === id);
}

interface MessageRecord {
	readonly id: string;
	readonly type?: unknown;
	readonly content?: unknown;
}

/** One session file's session, or undefined when it has none worth reopening. */
export function parseSessionFile(text: string, wholeJson: boolean, mtime = 0): ParsedSession | undefined {
	let meta: Record<string, unknown> = {};
	const messages = new Map<string, MessageRecord>();
	const setMessages = (list: unknown) => {
		messages.clear();
		for (const message of Array.isArray(list) ? list : []) {
			if (isMessage(message)) {
				messages.set(message.id, message);
			}
		}
	};
	const record = (value: unknown) => {
		if (!isObject(value)) {
			return;
		}
		if (typeof value.$rewindTo === 'string') {
			// Drops that message and everything after it.
			let found = false;
			for (const id of [...messages.keys()]) {
				found ||= id === value.$rewindTo;
				if (found) {
					messages.delete(id);
				}
			}
			if (!found) {
				messages.clear();
			}
		} else if (isMessage(value)) {
			messages.set(value.id, value);
		} else if (isObject(value.$set)) {
			if (Array.isArray(value.$set.messages)) {
				setMessages(value.$set.messages);
			}
			meta = { ...meta, ...value.$set };
		} else if (typeof value.sessionId === 'string') {
			meta = { ...meta, ...value };
			if (Array.isArray(value.messages)) {
				for (const message of value.messages) {
					if (isMessage(message)) {
						messages.set(message.id, message);
					}
				}
			}
		}
	};
	let whole: unknown;
	if (wholeJson) {
		try {
			whole = JSON.parse(text);
		} catch {
			// Not one object: read it as records.
		}
	}
	if (isObject(whole)) {
		meta = whole;
		setMessages(whole.messages);
	} else {
		for (const line of text.split('\n')) {
			if (line.trim()) {
				try {
					record(JSON.parse(line));
				} catch {
					// A line cut short by a crash; the CLI skips it too.
				}
			}
		}
	}
	const id = meta.sessionId;
	if (typeof id !== 'string' || !id || meta.kind === 'subagent') {
		return undefined;
	}
	const all = [...messages.values()];
	const prompts = all.filter(m => m.type === 'user').map(m => textOf(m.content).trim()).filter(isPrompt);
	const resumable = prompts.length > 0 || all.some(isReply);
	const summary = typeof meta.summary === 'string' ? meta.summary.trim() : '';
	const time = (key: string) => typeof meta[key] === 'string' ? Date.parse(meta[key] as string) : NaN;
	const started = time('startTime');
	const updated = time('lastUpdated');
	return {
		id,
		title: oneLine(summary || prompts[0] || ''),
		prompts,
		resumable,
		startedAt: Number.isFinite(started) ? started : Number.isFinite(updated) ? updated : mtime,
		updatedAt: Number.isFinite(updated) ? updated : Number.isFinite(started) ? started : mtime,
		...withTokens(all),
	};
}

/** The session's token counts from its replies' `tokens` (`input`, `cached`, ...), as gemini-cli 0.62 and 0.63 save them. */
function withTokens(messages: readonly MessageRecord[]): { tokens?: SessionTokens } {
	let latest: { readonly input: number; readonly model?: string } | undefined;
	let cached = 0;
	for (const message of messages) {
		const tokens = (message as { tokens?: unknown }).tokens;
		if (message.type !== 'gemini' || !isObject(tokens)) {
			continue;
		}
		const model = (message as { model?: unknown }).model;
		if (typeof tokens.input === 'number' && Number.isFinite(tokens.input) && tokens.input > 0) {
			latest = { input: tokens.input, ...(typeof model === 'string' && model ? { model } : {}) };
		}
		if (typeof tokens.cached === 'number' && Number.isFinite(tokens.cached) && tokens.cached > 0) {
			cached += tokens.cached;
		}
	}
	return latest ? { tokens: { context: Math.round(latest.input), ...(latest.model ? { model: latest.model } : {}), cached: Math.round(cached) } } : {};
}

/**
 * The token counts saved for session `id` in `cwd`, from its newest file;
 * undefined when the CLI saved none (chat recording off, or nothing sent yet).
 */
export async function readSessionTokens(cwd: string, id: string, home?: string): Promise<SessionTokens | undefined> {
	const folder = await chatsFolder(cwd, home);
	if (!folder || !id) {
		return undefined;
	}
	let names: string[];
	try {
		// The CLI names a session's file after the first 8 characters of its id.
		const suffix = `-${id.slice(0, 8)}.json`;
		names = (await fs.readdir(folder)).filter(name => name.startsWith('session-') && (name.endsWith(suffix) || name.endsWith(`${suffix}l`)));
	} catch {
		return undefined;
	}
	const sessions = (await Promise.all(names.map(name => readSessionFile(path.join(folder, name))))).filter(session => session?.id === id);
	return sessions.sort((a, b) => b!.updatedAt - a!.updatedAt)[0]?.tokens;
}

/** A model message the CLI would resume: one with text, tool calls or thoughts. */
function isReply(message: MessageRecord): boolean {
	const record = message as MessageRecord & { readonly toolCalls?: unknown; readonly thoughts?: unknown };
	return message.type === 'gemini' && (!!textOf(message.content).trim() || (Array.isArray(record.toolCalls) && record.toolCalls.length > 0) || (Array.isArray(record.thoughts) && record.thoughts.length > 0));
}

/** Whether a user message is a prompt, as the CLI counts them: not empty, a command or context it added. */
export function isPrompt(text: string): boolean {
	return !!text && !/^(\/|\?|<session_context>|<hook_context>)/.test(text);
}

const maxTitleLength = 80;

function oneLine(text: string): string {
	const line = text.split('\n').map(l => l.trim()).find(Boolean)?.replace(/\s+/g, ' ') ?? '';
	return line.length > maxTitleLength ? `${line.slice(0, maxTitleLength - 1).trimEnd()}…` : line;
}

/** A message's text: a string, or the text parts of a part list. */
function textOf(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map(part => isObject(part) && typeof part.text === 'string' ? part.text : '').join('');
	}
	return isObject(content) && typeof content.text === 'string' ? content.text : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessage(value: unknown): value is MessageRecord {
	return isObject(value) && typeof value.id === 'string';
}

async function isFolder(folder: string): Promise<boolean> {
	try {
		return (await fs.stat(folder)).isDirectory();
	} catch {
		return false;
	}
}
