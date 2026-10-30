/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The frame around other people's text in what an agent reads: tool results
// (teamTools.ts), the prompts the team flows write (teamFlowLogic.ts) and
// what a page in the browser hands over (pageContext.ts, browserMcp.ts).
// Kept apart so a prompt module can use it without the tools' connectors.

import type { TeamToolId } from './teamHttp';

/**
 * Text that came from outside (a ticket, a merge request, a job log, a
 * design), marked so the model treats it as something to read, not as
 * instructions. The frame is plain text; the server's instructions say what
 * it means. An `<external>` or `</external>` tag inside the text is escaped,
 * so the text cannot close its frame early and go on as if it were outside it.
 */
export function external(source: TeamToolId | 'page', ref: string, text: string): string {
	return `<external source="${source}" ref="${ref.replace(/["<>\r\n]/g, '')}">\n${text.replace(/<(\/?external)\b/gi, '&lt;$1')}\n</external>`;
}
