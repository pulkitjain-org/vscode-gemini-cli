/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which links rendered Markdown may hold, as markdown-it's `validateLink`.
// Only web pages and mail: a link to another URL scheme (geminicode://,
// vscode://, file:) would hand whatever a reply says to an app's URL handler.

/** Whether `url` may be a link in rendered Markdown: http, https or mailto. Anything else shows as text. */
export function isSafeLink(url: string): boolean {
	return /^(https?|mailto):/i.test(url.trim());
}
