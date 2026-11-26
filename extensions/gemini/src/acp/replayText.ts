/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// When gemini-cli replays a saved session (`session/load`), it turns each
// message into text with its verbose converter, so thoughts, tool calls and
// tool results come through as markers such as `[Thought: true]`,
// `[Function Call: replace]` and `[Function Response: run_shell_command]`
// (`partToString` in gemini-cli 0.63). It sends the real thoughts and tool
// calls as well, so the markers are only noise. Only their exact forms are
// matched, so text that merely starts with a bracket is kept.

const marker = String.raw`\[(?:Thought: [^\]\n]{1,20}|Function (?:Call|Response): [\w.:/-]{1,128}|Executable Code|Code Execution Result|File Data|Video Metadata|(?:Image|Audio|Video|Media): [\w.+/-]{1,100}, \d+\.\d KB)\]`;
const leading = new RegExp(`^(?:\\s*${marker})+\\s*`);
const trailing = new RegExp(`\\s*(?:${marker}\\s*)+$`);
const only = new RegExp(`^(?:\\s*${marker})*\\s*$`);

/** `text` without the CLI's replay markers at its start and end; empty when it was only markers. */
export function withoutReplayMarkers(text: string): string {
	if (only.test(text)) {
		return '';
	}
	return text.replace(leading, '').replace(trailing, '');
}

/** Whether `text` has a replay marker at its start or end, to clean saved chats only when needed. */
export function hasReplayMarkers(text: string): boolean {
	return leading.test(text) || trailing.test(text);
}
