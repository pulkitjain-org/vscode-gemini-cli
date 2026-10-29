/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A plan the Gemini CLI deleted when it reopened its session (sessionFolder.ts),
// written again: from Plan Review's copy, which has the user's own edits,
// unless the agent wrote the plan after it; else from the write and replace
// calls the session saved, which may differ a little from the file (the
// CLI's replace forgives whitespace). In the on-demand bundle: the session's
// files are read by the extension bundle's own reader, passed in.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MessageRecord } from './cliSessions';
import { projectTempDirName } from './cli/formats';
import { keptPlan } from './planReviewStore';

/** What a rebuild reads of the CLI's files, for one folder. */
export interface SessionReader {
	/** The CLI's own folder, `~/.gemini`. */
	readonly home: string;
	/** Session `id`'s folder; undefined when there is none. */
	folder(id: string): Promise<string | undefined>;
	/** Session `id`'s saved messages; undefined when it has none. */
	messages(id: string): Promise<readonly MessageRecord[] | undefined>;
	/** Plan Review's state folder (planReviewStore.ts), whose copy of a plan the user edited is preferred. */
	readonly reviews?: string;
}

/**
 * Writes `file`, a file in a session's folder (a plan), again when it is
 * missing: Plan Review's copy, unless a call the session saved is later;
 * else the session's last `write_file`, then the `replace` calls after it.
 * `cwd` is the folder the session works in, which saved paths are relative
 * to. Resolves with where the text came from; undefined when the file is
 * there, isn't a session's, or nothing can rebuild it.
 */
export async function rebuildSessionFile(cwd: string, file: string, reader: SessionReader): Promise<'review' | 'history' | undefined> {
	const tmp = path.join(reader.home, projectTempDirName);
	const [project, id, ...rest] = path.relative(tmp, file).split(path.sep);
	if (!rest.length || project === '..' || await reader.folder(id) !== path.join(tmp, project, id)) {
		return undefined;
	}
	const messages = await reader.messages(id);
	const replayed = messages && replay(messages, cwd, file);
	const kept = reader.reviews ? await keptPlan(reader.reviews, file).catch(() => undefined) : undefined;
	const source = kept && !(replayed?.at !== undefined && replayed.at > kept.at) ? 'review' : replayed ? 'history' : undefined;
	if (!source) {
		return undefined;
	}
	try {
		await fs.mkdir(path.dirname(file), { recursive: true });
		// `wx`: never over a file that is there.
		await fs.writeFile(file, source === 'review' ? kept!.text : replayed!.text, { flag: 'wx' });
		return source;
	} catch {
		return undefined;
	}
}

/** One tool call as the CLI saves it in a message. */
interface SavedCall {
	readonly name?: unknown;
	readonly status?: unknown;
	readonly args?: Record<string, unknown>;
}

/** `file`'s text after the successful writes and replaces `messages` saved for it; undefined when they don't make it. */
export function replayWrites(messages: readonly MessageRecord[], cwd: string, file: string): string | undefined {
	return replay(messages, cwd, file)?.text;
}

/** As {@link replayWrites}, with when the last of those calls was saved, if the CLI saved that. */
function replay(messages: readonly MessageRecord[], cwd: string, file: string): { readonly text: string; readonly at?: number } | undefined {
	let text: string | undefined;
	let at: number | undefined;
	for (const message of messages) {
		const calls = Array.isArray(message.toolCalls) ? message.toolCalls as SavedCall[] : [];
		for (const { name, status, args } of calls) {
			// The CLI saves the path as the model gave it, often relative to `cwd`.
			if (status !== 'success' || typeof args?.file_path !== 'string' || path.resolve(cwd, args.file_path) !== file) {
				continue;
			}
			const { content, old_string: before, new_string: after } = args;
			const time = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
			at = Number.isNaN(time) ? undefined : time;
			if (name === 'write_file' && typeof content === 'string') {
				text = content;
			} else if (name === 'replace' && typeof before === 'string' && typeof after === 'string') {
				if (text === undefined) {
					// An empty `old_string` creates the file.
					text = before === '' ? after : undefined;
				} else if (before === '' || !text.includes(before)) {
					// A change that no longer applies: the rest can't be trusted either.
					return undefined;
				} else {
					text = args.allow_multiple === true || Number(args.expected_replacements) > 1 ? text.split(before).join(after) : text.replace(before, () => after);
				}
			}
		}
	}
	return text === undefined ? undefined : { text, ...at !== undefined ? { at } : {} };
}
