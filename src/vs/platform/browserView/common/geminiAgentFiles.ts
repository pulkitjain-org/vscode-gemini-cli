/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: a Gemini agent's page loads a file only when the agent may read it. The main
// process (electron-main/geminiAgentFiles.ts) holds each such load and asks the page's window
// (contrib/gemini/electron-browser/geminiBrowser.ts), which asks the Gemini extension. Checking
// the URL the agent opens is not enough: Electron gives `file:` pages more than a browser does,
// so a page can show other files in frames, or read them with fetch or a worker.

import { IBrowserViewOwner } from './browserView.js';

/** A Gemini agent's pages are owned by the session `gemini-agent:<key>`; the key is the extension's id for the agent. */
export const geminiAgentSessionPrefix = 'gemini-agent:';

/** The key of the Gemini agent that owns a page, if one does. */
export function geminiAgentOf(owner: IBrowserViewOwner): string | undefined {
	return owner.type === 'agent' && owner.sessionId.startsWith(geminiAgentSessionPrefix) ? owner.sessionId.slice(geminiAgentSessionPrefix.length) : undefined;
}

/** Main asks the window whether an agent's page may load a file: `(request: IGeminiAgentFileRequest)`. */
export const GeminiAgentFileRequestChannel = 'vscode:geminiAgentFileRequest';

/** The window answers: `(id: number, allowed: boolean)`. */
export const GeminiAgentFileAnswerChannel = 'vscode:geminiAgentFileAnswer';

export interface IGeminiAgentFileRequest {
	readonly id: number;
	/** The agent's key. */
	readonly agent: string;
	/** The `file:` URL the page is loading. */
	readonly url: string;
}
