/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Work started without being awaited: a keychain read at activation, a
// prune after the agent starts, Home's rebuild. A failure there used to be an
// unhandled rejection, which the extension host reports to no one; it now
// goes to the Gemini log with what was running.

import * as vscode from 'vscode';

let log: vscode.LogOutputChannel | undefined;

/** Where failures are written; set as the extension activates. */
export function setBackgroundLog(channel: vscode.LogOutputChannel): void {
	log = channel;
}

/** Runs `work` without waiting for it; a rejection is logged as `what` failing, never thrown. */
export function background(what: string, work: Promise<unknown>): void {
	work.catch(err => {
		const message = err instanceof Error ? err.stack ?? err.message : String(err);
		log?.error(`${what} failed: ${message}`);
	});
}
