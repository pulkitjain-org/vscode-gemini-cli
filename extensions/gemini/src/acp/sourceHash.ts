/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A short hash of a source file's declarations, comments and spacing left
// out, so a test can tell that the messages between the chat view and its
// webview (chatProtocol.ts) changed without `chatProtocolVersion` moving.

import { createHash } from 'node:crypto';

/** The hash of `text` from the line holding `from` to the end, without comments and with whitespace collapsed. */
export function hashSource(text: string, from: string): string {
	const start = text.indexOf(from);
	const body = (start < 0 ? text : text.slice(text.lastIndexOf('\n', start) + 1))
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return createHash('sha256').update(body).digest('hex').slice(0, 12);
}
