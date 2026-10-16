/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Gemini CLI's saved sessions for a folder, so an agent can reopen one
// that started in the terminal. gemini-cli 0.62 has no `session/list` over
// ACP, but its `session/load` takes any session id saved for the folder, the
// way `gemini --resume` does. So GeminiCode reads the CLI's session files
// itself, as the CLI lays them out, and writes to them only to rewind one
// (`rewindCliSession`), with the record the CLI's own /rewind writes:
//
//   ~/.gemini/projects.json             { "projects": { "<folder>": "<project id>" } }
//   ~/.gemini/tmp/<project id>/chats/   session-<time>-<id>.jsonl (or .json, older)
//
// A .jsonl file is a list of records: the session's metadata, messages (with
// an `id`), metadata updates (`$set`), rewinds (`$rewindTo`) and, from 0.64,
// patches (`$patch`) that change, remove or reorder messages. An older
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
	/** How many updates the CLI sends when it replays the session on `session/load` (see `replayUpdateCount`). */
	readonly replayUpdates: number;
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
	/** How many updates the CLI sends when it replays the session (see `replayUpdateCount`). */
	readonly replayUpdates: number;
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
	/** For a .jsonl file: its records so far, to add only what the CLI appended. */
	readonly records?: SessionRecords;
	/** The bytes parsed: up to the end of the last whole line. */
	readonly offset?: number;
	/** The bytes just before `offset`, to tell an append from a rewrite. */
	readonly tail?: Buffer;
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
			replayUpdates: session.replayUpdates,
		}));
}

/** Bytes compared to tell that a session file only grew. */
const tailCheckBytes = 256;

async function readSessionFile(file: string): Promise<ParsedSession | undefined> {
	try {
		const stat = await fs.stat(file);
		const cached = parsedFiles.get(file);
		if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
			return cached.session;
		}
		// The CLI appends a record or two per message, so after the first read
		// of a long session only the new lines are parsed, not the whole file.
		const appended = cached?.records && stat.size > cached.size ? await readAppended(file, cached, stat.size) : undefined;
		const entry = appended ?? parseWholeFile(await fs.readFile(file), file.endsWith('.json'));
		let session: ParsedSession | undefined;
		if (entry.records) {
			// A last line without its line end may still be complete; it is read but not kept, since the next append may finish it.
			const current = entry.rest?.trim() ? entry.records.clone() : entry.records;
			if (current !== entry.records) {
				current.addLines(entry.rest!);
			}
			session = sessionFrom(current.meta, current.messages(), stat.mtimeMs);
		} else {
			session = parseSessionFile(entry.text ?? '', true, stat.mtimeMs);
		}
		if (parsedFiles.size >= maxCachedFiles) {
			parsedFiles.clear();
		}
		parsedFiles.set(file, { mtime: stat.mtimeMs, size: stat.size, session, ...(entry.records ? { records: entry.records, offset: entry.offset, tail: entry.tail } : {}) });
		return session;
	} catch {
		return undefined;
	}
}

interface ParsedFile {
	readonly records?: SessionRecords;
	readonly offset?: number;
	readonly tail?: Buffer;
	/** Text after the last line end. */
	readonly rest?: string;
	/** A whole-JSON file's text. */
	readonly text?: string;
}

function parseWholeFile(data: Buffer, wholeJson: boolean): ParsedFile {
	if (wholeJson) {
		return { text: data.toString('utf8') };
	}
	const records = new SessionRecords();
	const end = data.lastIndexOf(0x0a) + 1;
	records.addLines(data.subarray(0, end).toString('utf8'));
	return { records, offset: end, tail: Buffer.from(data.subarray(Math.max(0, end - tailCheckBytes), end)), rest: data.subarray(end).toString('utf8') };
}

/** The records appended since `cached` was parsed; undefined when the file was rewritten instead. */
async function readAppended(file: string, cached: CachedFile, size: number): Promise<ParsedFile | undefined> {
	const offset = cached.offset ?? 0;
	const tail = cached.tail ?? Buffer.alloc(0);
	const handle = await fs.open(file, 'r');
	let data: Buffer;
	try {
		const start = offset - tail.length;
		data = Buffer.alloc(size - start);
		const { bytesRead } = await handle.read(data, 0, data.length, start);
		data = data.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
	if (!data.subarray(0, tail.length).equals(tail)) {
		return undefined;
	}
	const added = data.subarray(tail.length);
	const end = added.lastIndexOf(0x0a) + 1;
	const records = cached.records!.clone();
	records.addLines(added.subarray(0, end).toString('utf8'));
	const parsed = Buffer.concat([tail, added.subarray(0, end)]);
	return { records, offset: offset + end, tail: Buffer.from(parsed.subarray(Math.max(0, parsed.length - tailCheckBytes))), rest: added.subarray(end).toString('utf8') };
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
	const { meta, all } = parseSessionRecords(text, wholeJson);
	return sessionFrom(meta, all, mtime);
}

function sessionFrom(meta: Record<string, unknown>, all: readonly MessageRecord[], mtime: number): ParsedSession | undefined {
	const id = meta.sessionId;
	if (typeof id !== 'string' || !id || meta.kind === 'subagent') {
		return undefined;
	}
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
		replayUpdates: replayUpdateCount(all),
		...withTokens(all),
	};
}

/** A .jsonl session file's metadata and messages as they stand, after rewinds and rewrites, built up record by record. */
class SessionRecords {
	meta: Record<string, unknown> = {};
	private readonly byId = new Map<string, MessageRecord>();

	messages(): MessageRecord[] {
		return [...this.byId.values()];
	}

	clone(): SessionRecords {
		const copy = new SessionRecords();
		copy.meta = this.meta;
		for (const [id, message] of this.byId) {
			copy.byId.set(id, message);
		}
		return copy;
	}

	/** Whole lines of the file; a line cut short by a crash is skipped, as the CLI does. */
	addLines(text: string): void {
		for (const line of text.split('\n')) {
			if (line.trim()) {
				try {
					this.add(JSON.parse(line));
				} catch {
					// Skipped.
				}
			}
		}
	}

	setMessages(list: unknown): void {
		this.byId.clear();
		for (const message of Array.isArray(list) ? list : []) {
			if (isMessage(message)) {
				this.byId.set(message.id, message);
			}
		}
	}

	private add(value: unknown): void {
		if (!isObject(value)) {
			return;
		}
		if (typeof value.$rewindTo === 'string') {
			// Drops that message and everything after it.
			let found = false;
			for (const id of [...this.byId.keys()]) {
				found ||= id === value.$rewindTo;
				if (found) {
					this.byId.delete(id);
				}
			}
			if (!found) {
				this.byId.clear();
			}
		} else if (isObject(value.$patch)) {
			this.patch(value.$patch);
		} else if (isMessage(value)) {
			this.byId.set(value.id, value);
		} else if (isObject(value.$set)) {
			if (Array.isArray(value.$set.messages)) {
				this.setMessages(value.$set.messages);
			}
			this.meta = { ...this.meta, ...value.$set };
		} else if (typeof value.sessionId === 'string') {
			this.meta = { ...this.meta, ...value };
			if (Array.isArray(value.messages)) {
				for (const message of value.messages) {
					if (isMessage(message)) {
						this.byId.set(message.id, message);
					}
				}
			}
		}
	}

	/**
	 * A `$patch` record, which gemini-cli 0.64 writes when the conversation
	 * changes in place: new content for messages (`id` and `content`, alone or
	 * in `updates`), `removeIds`, and `orderIds`, the new order of the
	 * messages it names, after any it does not. Tool results it patches are
	 * not read here.
	 */
	private patch(patch: Record<string, unknown>): void {
		for (const update of [patch, ...(Array.isArray(patch.updates) ? patch.updates : [])]) {
			const message = isObject(update) && typeof update.id === 'string' ? this.byId.get(update.id) : undefined;
			if (message && update.content !== undefined) {
				// Records are shared with earlier parses of the file, so replace rather than change one.
				this.byId.set(message.id, { ...message, content: update.content });
			}
		}
		if (Array.isArray(patch.removeIds)) {
			for (const id of patch.removeIds) {
				if (typeof id === 'string') {
					this.byId.delete(id);
				}
			}
		}
		if (Array.isArray(patch.orderIds)) {
			const ordered = patch.orderIds.flatMap(id => {
				const message = typeof id === 'string' ? this.byId.get(id) : undefined;
				return message ? [message] : [];
			});
			const named = new Set(ordered.map(message => message.id));
			const rest = [...this.byId.values()].filter(message => !named.has(message.id));
			this.byId.clear();
			for (const message of [...rest, ...ordered]) {
				this.byId.set(message.id, message);
			}
		}
	}
}

/** A session file's metadata and its messages as they stand, after rewinds and rewrites. */
function parseSessionRecords(text: string, wholeJson: boolean): { meta: Record<string, unknown>; all: MessageRecord[] } {
	let whole: unknown;
	if (wholeJson) {
		try {
			whole = JSON.parse(text);
		} catch {
			// Not one object: read it as records.
		}
	}
	const records = new SessionRecords();
	if (isObject(whole)) {
		records.meta = whole;
		records.setMessages(whole.messages);
	} else {
		records.addLines(text);
	}
	return { meta: records.meta, all: records.messages() };
}

/**
 * How many updates gemini-cli 0.63 and 0.64 send when they replay `messages` after a
 * `session/load` (`streamHistory`): one per user message with any text or
 * part, and for each model message one per thought, one for its text or
 * parts, and one per tool call. The CLI answers `session/load` before the
 * replay is over, so this is how GeminiCode knows when it is.
 */
export function replayUpdateCount(messages: readonly unknown[]): number {
	let count = 0;
	for (const message of messages) {
		if (!isObject(message)) {
			continue;
		}
		if (message.type === 'user') {
			count += hasReplayText(message.content) ? 1 : 0;
		} else if (message.type === 'gemini') {
			count += (Array.isArray(message.thoughts) ? message.thoughts.length : 0)
				+ (hasReplayText(message.content) ? 1 : 0)
				+ (Array.isArray(message.toolCalls) ? message.toolCalls.length : 0);
		}
	}
	return count;
}

/** Parts the CLI's verbose converter writes as a marker such as `[Function Call: replace]`, which is never empty. */
const markerParts = ['videoMetadata', 'thought', 'codeExecutionResult', 'executableCode', 'fileData', 'functionCall', 'functionResponse', 'inlineData'];

/** Whether the CLI's verbose text of `content` is more than white space. */
function hasReplayText(content: unknown): boolean {
	if (typeof content === 'string') {
		return !!content.trim();
	}
	const parts = Array.isArray(content) ? content : [content];
	return parts.some(part => typeof part === 'string' ? !!part.trim()
		: isObject(part) && (markerParts.some(key => part[key] !== undefined) || (typeof part.text === 'string' && !!part.text.trim())));
}

/** The session's token counts from its replies' `tokens` (`input`, `cached`, ...), as gemini-cli 0.62 to 0.64 save them. */
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

/** Session `id` in `cwd` from its newest file, reading only that session's files; undefined when there is none. */
async function readSessionById(cwd: string, id: string, home?: string): Promise<ParsedSession | undefined> {
	return (await newestSessionFile(cwd, id, home))?.session;
}

/** The newest file of session `id` in `cwd`, and its session. */
async function newestSessionFile(cwd: string, id: string, home?: string): Promise<{ readonly file: string; readonly session: ParsedSession } | undefined> {
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
	const files = await Promise.all(names.map(async name => ({ file: path.join(folder, name), session: await readSessionFile(path.join(folder, name)) })));
	return files.filter((f): f is { file: string; session: ParsedSession } => f.session?.id === id).sort((a, b) => b.session.updatedAt - a.session.updatedAt)[0];
}

/**
 * Rewinds saved session `id` to just before one of the user's prompts, as the
 * CLI's /rewind does (which ACP doesn't offer): appends the CLI's own
 * `{"$rewindTo": <message id>}` record, which drops that message and
 * everything after it when the session is next loaded. The prompt is found by
 * its text: `fromEnd` is how many later prompts have the same text. Resolves
 * with whether it found the prompt; the session must be loaded again after.
 */
export async function rewindCliSession(cwd: string, id: string, prompt: string, fromEnd: number, home?: string): Promise<boolean> {
	const target = await rewindTarget(cwd, id, prompt, fromEnd, home);
	if (!target) {
		return false;
	}
	await fs.appendFile(target.file, `${JSON.stringify({ $rewindTo: target.messageId })}\n`);
	return true;
}

/** Whether {@link rewindCliSession} would find the prompt, without changing anything. */
export async function canRewindCliSession(cwd: string, id: string, prompt: string, fromEnd: number, home?: string): Promise<boolean> {
	return !!await rewindTarget(cwd, id, prompt, fromEnd, home).catch(() => undefined);
}

async function rewindTarget(cwd: string, id: string, prompt: string, fromEnd: number, home?: string): Promise<{ readonly file: string; readonly messageId: string } | undefined> {
	const newest = await newestSessionFile(cwd, id, home);
	const wanted = squashSpaces(prompt);
	if (!newest || !newest.file.endsWith('.jsonl') || !wanted) {
		return undefined;
	}
	const { all } = parseSessionRecords(await fs.readFile(newest.file, 'utf8'), false);
	// The CLI's message also carries what GeminiCode added to the prompt, such as context or a note about a shared page.
	const matches = all.filter(message => message.type === 'user' && squashSpaces(textOf(message.content)).includes(wanted));
	const target = matches[matches.length - 1 - fromEnd];
	return target ? { file: newest.file, messageId: target.id } : undefined;
}

function squashSpaces(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** One message of a saved conversation, as text: the user's prompts and the model's replies. */
export interface ConversationEntry {
	readonly role: 'user' | 'model';
	readonly text: string;
}

/**
 * The conversation saved for session `id` in `cwd`, as the user saw it:
 * prompts and the model's text, without the CLI's context, commands, thoughts
 * and tool results. Undefined when there is no file.
 */
export async function readCliConversation(cwd: string, id: string, home?: string): Promise<ConversationEntry[] | undefined> {
	const newest = await newestSessionFile(cwd, id, home);
	if (!newest) {
		return undefined;
	}
	const { all } = parseSessionRecords(await fs.readFile(newest.file, 'utf8'), newest.file.endsWith('.json'));
	const entries: ConversationEntry[] = [];
	for (const message of all) {
		const text = textOf(message.content).trim();
		if (message.type === 'user' && isPrompt(text)) {
			entries.push({ role: 'user', text });
		} else if (message.type === 'gemini' && text) {
			entries.push({ role: 'model', text });
		}
	}
	return entries;
}

/** How much of a carried conversation is given to the new session, in characters: the latest part when it is longer. */
const carriedConversationLimit = 40_000;

/** The note that gives a new session a conversation the agent could not reopen. */
export function carriedConversationNote(title: string, conversation: readonly ConversationEntry[]): string {
	let text = conversation.map(entry => `${entry.role === 'user' ? 'User' : 'You'}: ${entry.text}`).join('\n\n');
	if (text.length > carriedConversationLimit) {
		text = `…${text.slice(text.length - carriedConversationLimit)}`;
	}
	return `This continues an earlier conversation ("${title}") that could not be reopened. Here it is, for context; carry on from it.\n\n<earlier_conversation>\n${text}\n</earlier_conversation>`;
}

/**
 * The token counts saved for session `id` in `cwd`, from its newest file;
 * undefined when the CLI saved none (chat recording off, or nothing sent yet).
 */
export async function readSessionTokens(cwd: string, id: string, home?: string): Promise<SessionTokens | undefined> {
	return (await readSessionById(cwd, id, home))?.tokens;
}

/** What reopening session `id` in `cwd` by its id needs: its replay length. Reads only that session's files. */
export async function readCliSession(cwd: string, id: string, home?: string): Promise<{ readonly firstPrompt: string; readonly replayUpdates: number } | undefined> {
	const session = await readSessionById(cwd, id, home);
	return session && { firstPrompt: session.prompts[0] ?? '', replayUpdates: session.replayUpdates };
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
