/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The prompts of direct requests (inline edit, commit messages and prompt
// enhancement), and cleaning up what the model sends back. No editor API, so
// it can be tested.

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

/** The recent conversation shown to prompt enhancement is cut to this many characters, newest kept. */
const maxHistoryLength = 4000;
/** And each message in it to this many. */
const maxHistoryMessageLength = 1500;

export interface EnhancePromptInput {
	/** What the user typed. */
	readonly draft: string;
	/** Names of the files and selections attached to it. */
	readonly attachments?: readonly string[];
	/** The chat so far, oldest first; only the last few messages are sent. */
	readonly history?: readonly { readonly role: 'user' | 'agent'; readonly text: string }[];
	readonly folder?: string;
	readonly branch?: string;
	/** The file in the editor, relative to the folder, and its language. */
	readonly activeFile?: string;
	/** The agent's approval mode, such as Plan. */
	readonly mode?: string;
}

export function enhancePromptPrompt(input: EnhancePromptInput): { readonly system: string; readonly prompt: string } {
	const system = [
		'You turn a request a developer typed for an AI coding agent into a clearer, more precise prompt for that agent.',
		'Rewrite the request; never answer it, carry it out, or write the code it asks for.',
		'Match the length to the request: a short, simple request stays a sentence or two;',
		'a larger one may use short labelled sections such as Goal, Context, Requirements, Constraints and Done when, only where they add something.',
		'Say what to do, where, and how to tell it is done. Use the context given (files, recent conversation) to resolve words like "it" or "the same".',
		'Keep every @mention, file path, identifier, code snippet, URL and number exactly as written.',
		'If the request starts with a /command, keep it first; never start with a /command the request does not start with.',
		'Write in the language the request is written in.',
		'Never invent file names, functions, APIs or facts that are not in the request or the context.',
		'Where something important is unclear, add a short Assumptions or Open questions part instead of guessing.',
		input.mode ? `The agent is in ${input.mode} mode; do not ask it for anything that mode does not allow.` : '',
		'Do not use any tools and do not read or change files: answer straight away.',
		'Answer with the new prompt only: no preamble, no explanation, no quotes or code fence around it.',
	].filter(Boolean).join(' ');
	const context = [
		input.folder ? `Folder: ${input.folder}` : '',
		input.branch ? `Branch: ${input.branch}` : '',
		input.activeFile ? `Open file: ${input.activeFile}` : '',
		input.attachments?.length ? `Attached: ${input.attachments.join(', ')}` : '',
	].filter(Boolean);
	const history = recentHistory(input.history ?? []);
	const prompt = [
		context.length ? `Context:\n${context.join('\n')}\n` : '',
		history ? `Recent conversation:\n${history}\n` : '',
		`Request to rewrite:\n<request>\n${input.draft}\n</request>`,
	].filter(Boolean).join('\n');
	return { system, prompt };
}

/** The newest messages that fit, oldest first. */
function recentHistory(messages: EnhancePromptInput['history'] & {}): string {
	const shown: string[] = [];
	let length = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = messages[i].text.trim();
		if (!text) {
			continue;
		}
		const cut = text.length > maxHistoryMessageLength ? `${text.slice(0, maxHistoryMessageLength)}…` : text;
		const line = `${messages[i].role === 'user' ? 'User' : 'Agent'}: ${cut}`;
		if (length + line.length > maxHistoryLength) {
			break;
		}
		shown.unshift(line);
		length += line.length;
	}
	return shown.join('\n');
}

/** `@word`s at the start of a word, without trailing punctuation; e-mail addresses are not mentions. */
function mentionsOf(text: string): string[] {
	return [...text.matchAll(/(?:^|\s)(@[^\s@]+)/g)].map(m => m[1].replace(/[.,;:!?)\]}'"]+$/, '')).filter(m => m.length > 1);
}

/**
 * The model's prompt without a preamble, request tags, quotes or a code fence
 * around it; the original when it sent nothing. A leading /command or an
 * @mention the model dropped is put back, and a leading /command it made up
 * is taken out, since the composer would run it.
 */
export function cleanEnhancedPrompt(reply: string, original: string): string {
	let text = reply.trim()
		// gemini-cli's notice of a mode change, sent as message text and run into the reply.
		.replace(/^\[MODE_UPDATE\] (?:default|autoEdit|yolo|plan)\s*/, '')
		.replace(/^(?:\*\*)?(?:here(?:'s| is)[^\n]*?|(?:enhanced|improved|rewritten|new) prompt)(?:\*\*)?:(?:\*\*)?\s*\n/i, '')
		.replace(/^<request>\s*/, '').replace(/\s*<\/request>$/, '')
		.trim();
	const fenced = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1$/.exec(text);
	if (fenced) {
		text = fenced[2].trim();
	}
	text = text.replace(/^"([\s\S]*)"$/, '$1').trim();
	if (!text) {
		return original;
	}
	const command = /^\s*(\/[\w:.-]+)/.exec(original)?.[1];
	if (!command) {
		// "/task Implement it" loses the word; in "/refactor the parser" it is the verb.
		text = text.replace(/^\/([\w:.-]+)\s+(\S)/, (_, word: string, next: string) =>
			/\p{Lu}/u.test(next) ? next : `${word[0].toUpperCase()}${word.slice(1)} ${next}`);
	} else if (!text.startsWith(command)) {
		text = `${command} ${text.replace(new RegExp(`(^|\\s)${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+|$)`), '$1').trim()}`;
	}
	const kept = new Set(mentionsOf(text));
	const dropped = [...new Set(mentionsOf(original))].filter(m => !kept.has(m));
	return dropped.length ? `${text}\n\n${dropped.join(' ')}` : text;
}

/** `gemini.inlineEdit.model` values that are not model names. */
export const latestFlashModel = 'latestFlash';
export const sameAsChatModel = 'sameAsChat';

/** Used when the installed CLI does not name its Flash models. */
export const knownFlash = { latest: 'gemini-3.8-flash', base: 'gemini-3.5-flash', codeAssist: 'gemini-3-flash' } as const;

export interface ModelChoice {
	/** The `gemini.inlineEdit.model` setting. */
	readonly setting: string;
	/** The model last picked in chat, if any. */
	readonly chatModel: string | undefined;
	/** The installed CLI's Flash models; `codeAssist` is the name Code Assist serves the base one under. */
	readonly cliFlash: { readonly latest?: string; readonly base?: string; readonly codeAssist?: string };
	/** Signed in with Google, so requests go to Code Assist rather than the Gemini API. */
	readonly codeAssist: boolean;
	/** The account was refused the latest Flash model earlier. */
	readonly latestRefused: boolean;
}

/**
 * The models to try, in order: the newest Flash model first, falling back to
 * the one every account has, unless the setting or the chat names another.
 * On Code Assist the CLI sends the base Flash model under its older name
 * unless the account has the newest one, so this does too.
 */
export function quickEditModels(choice: ModelChoice): string[] {
	const latest = choice.cliFlash.latest ?? knownFlash.latest;
	const base = choice.cliFlash.base ?? knownFlash.base;
	const fallback = choice.codeAssist ? choice.cliFlash.codeAssist ?? knownFlash.codeAssist : base;
	const setting = choice.setting.trim();
	let model: string | undefined = setting === latestFlashModel || !setting ? undefined : setting;
	if (setting === sameAsChatModel) {
		// Auto picks a model per request inside the CLI, so there is none to follow; Flash is what it uses for quick work.
		model = choice.chatModel && !/^auto(-|$)/.test(choice.chatModel) && choice.chatModel !== 'flash' ? choice.chatModel : undefined;
	}
	if (model) {
		return [model === base ? fallback : model];
	}
	return choice.latestRefused || latest === fallback ? [fallback] : [latest, fallback];
}
