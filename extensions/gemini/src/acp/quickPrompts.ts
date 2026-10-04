/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The prompts of direct requests (inline edit and commit messages), and
// cleaning up what the model sends back. No editor API, so it can be tested.

/** Lines of the file shown around the selection, so the edit fits in. */
const contextLines = 80;

export interface InlineEditInput {
	readonly path: string;
	readonly languageId: string;
	readonly lines: readonly string[];
	/** The lines to rewrite, `[start, end)`, 0-based. */
	readonly start: number;
	readonly end: number;
	readonly instruction: string;
}

export function inlineEditPrompt(input: InlineEditInput): { readonly system: string; readonly prompt: string } {
	const before = input.lines.slice(Math.max(0, input.start - contextLines), input.start).join('\n');
	const selection = input.lines.slice(input.start, input.end).join('\n');
	const after = input.lines.slice(input.end, input.end + contextLines).join('\n');
	const system = [
		'You rewrite a part of a source file as the user asks.',
		'Answer with the new text for the part between <selection> and </selection> only: no code fences, no explanation, nothing from outside it.',
		'Keep its indentation, style and line endings. Change nothing the request does not need.',
		'If the request asks a question instead of a change, answer with the part unchanged.',
	].join(' ');
	const prompt = [
		`File: ${input.path} (${input.languageId})`,
		'',
		before ? `${before}\n<selection>\n${selection}\n</selection>` : `<selection>\n${selection}\n</selection>`,
		after,
		'',
		`Request: ${input.instruction}`,
	].join('\n');
	return { system, prompt };
}

/** The model's rewrite without a code fence or selection tags around it, ending like the original did. */
export function cleanEdit(reply: string, original: string): string {
	let text = reply.replace(/^\s*<selection>\n?/, '').replace(/\n?<\/selection>\s*$/, '');
	const fenced = /^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/.exec(text);
	if (fenced) {
		text = fenced[2];
	}
	text = text.replace(/\n+$/, '');
	const trailing = /\n*$/.exec(original)?.[0] ?? '';
	return text + trailing;
}

/** Diffs longer than this are cut; the model still gets the list of files. */
const maxDiffLength = 40_000;

export function commitMessagePrompt(diff: string, recentSubjects: readonly string[]): { readonly system: string; readonly prompt: string } {
	const files = [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map(m => m[1]);
	const shown = diff.length > maxDiffLength ? `${diff.slice(0, maxDiffLength)}\n[diff cut short; files changed: ${files.join(', ')}]` : diff;
	const system = [
		'You write git commit messages.',
		'Answer with the message only: a subject line of at most 72 characters in the imperative mood, then, if the change needs it, a blank line and a short body wrapped at 72 characters saying what changed and why.',
		'No code fences, no quotes, no trailers.',
		recentSubjects.length ? 'Match the style of the repository\'s recent subjects.' : '',
	].filter(Boolean).join(' ');
	const prompt = [
		recentSubjects.length ? `Recent subjects:\n${recentSubjects.map(s => `- ${s}`).join('\n')}\n` : '',
		`Diff:\n${shown}`,
	].join('\n');
	return { system, prompt };
}

export function cleanCommitMessage(reply: string): string {
	let text = reply.trim();
	const fenced = /^(`{3,})[^\n]*\n([\s\S]*?)\n?\1$/.exec(text);
	if (fenced) {
		text = fenced[2].trim();
	}
	return text.replace(/^["'](.*)["']$/s, '$1');
}
