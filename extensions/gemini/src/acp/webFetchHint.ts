/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { contentBlockToText, type ToolCallModel } from './sessionUpdates';

/**
 * Whether `call` is the CLI's web fetch refusing a host on the user's machine
 * or network. gemini-cli's `web_fetch` refuses any host that resolves to a
 * private address (or doesn't resolve) before fetching, whatever the server
 * allows, and fails with "All requested URLs were skipped: [Blocked Host] …"
 * or "Access to blocked or private host … is not allowed." The chat then says
 * what can open such a page: the GeminiCode browser, which runs here.
 */
export function isBlockedWebFetch(call: ToolCallModel): boolean {
	if (call.status !== 'failed') {
		return false;
	}
	return call.content.some(c => c.type === 'content' && /\[Blocked Host\]|blocked or private host/i.test(contentBlockToText(c.content)));
}
