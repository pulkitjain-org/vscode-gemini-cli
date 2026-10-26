/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the extension host accepts from its pages. A page only shows what the
// host sent it, so the host keeps what it sent (Home's commands, a chat's
// replies, the trace files it writes) and refuses anything else a page names:
// a page that went wrong, or script that got into one, can't use the host to
// run another command, a made-up shell command, or open any file.

import * as path from 'node:path';

/** A command action's key: the command with its arguments, as the page sends them back. */
export function commandActionKey(command: string, args: readonly unknown[] | undefined): string {
	return JSON.stringify([command, args ?? []]);
}

/** Adds the key of every command action (`{ kind: 'command', command, args }`) in `view`, however deep, to `into`. */
export function collectCommandActions(view: unknown, into: Set<string>): Set<string> {
	if (Array.isArray(view)) {
		view.forEach(item => collectCommandActions(item, into));
	} else if (view && typeof view === 'object') {
		const action = view as { readonly kind?: unknown; readonly command?: unknown; readonly args?: unknown };
		if (action.kind === 'command' && typeof action.command === 'string') {
			into.add(commandActionKey(action.command, Array.isArray(action.args) ? action.args : undefined));
		}
		Object.values(view).forEach(value => collectCommandActions(value, into));
	}
	return into;
}

/** Whether `file` is a trace GeminiCode records: `geminicode-trace-<stamp>.jsonl` in the home folder (traceCommand.ts). */
export function isTraceFile(file: unknown, home: string): boolean {
	return typeof file === 'string' && path.isAbsolute(file) && path.dirname(path.normalize(file)) === path.normalize(home) && /^geminicode-trace-[\w-]+\.jsonl$/.test(path.basename(file));
}

/** Text with every run of white space as one space, since Markdown takes a code block's indent away inside a list. */
function flattened(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** Whether a shell block `text` a page asks to run is in one of the chat's messages. */
export function isTranscriptBlock(text: unknown, messages: Iterable<string>): boolean {
	if (typeof text !== 'string' || !text.trim()) {
		return false;
	}
	const block = flattened(text);
	for (const message of messages) {
		if (flattened(message).includes(block)) {
			return true;
		}
	}
	return false;
}
