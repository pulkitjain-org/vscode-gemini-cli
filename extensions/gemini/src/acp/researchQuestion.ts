/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The /research command's question, apart from research.ts, so the chat can
// recognize the command without loading the research engine (dist/onDemand.js).

/** The question as the slash command gives it: `/research where are tokens logged?`. */
export function researchQuestionOf(text: string): string | undefined {
	const match = /^\/research(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? match[1]?.trim() ?? '' : undefined;
}
