/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The draft of a merge request review (src/host/teamFlows.ts and
// src/host/reviewComments.ts): the comments Gemini drafted and the user
// wrote, replies to the merge request's threads, and suggested changes, with
// what is needed to post them on the right lines. Nothing here calls GitLab
// or touches a file.

import type { ReviewFinding } from './teamFlowLogic';

export type FindingKind = ReviewFinding['kind'];

/** A suggested change: the text that replaces the comment's lines. */
export interface Suggestion {
	readonly text: string;
	readonly by: 'gemini' | 'you';
	/** Whether it is posted with the comment. */
	readonly include: boolean;
}

export interface DraftComment {
	readonly id: string;
	readonly by: 'gemini' | 'you';
	readonly kind?: FindingKind;
	/** The file's path in the merge request's new version; unset for a general comment. */
	readonly file?: string;
	/** Lines in the new version; `endLine` when the comment covers a range. */
	readonly line?: number;
	readonly endLine?: number;
	readonly title?: string;
	readonly comment: string;
	readonly checked: boolean;
	/** Gemini's comment, changed by the user: kept when Gemini reviews again. */
	readonly edited?: boolean;
	readonly suggestion?: Suggestion;
	/** The commented line's text when the comment was written, to find the line on a newer commit. */
	readonly anchor?: string;
	/** The commented line changed in a newer commit; the user looks before it is posted. */
	readonly lineChanged?: boolean;
}

/** A reply to one of the merge request's threads; an empty `text` with `resolve` only resolves it. */
export interface DraftReply {
	readonly id: string;
	readonly discussion: string;
	readonly by: 'gemini' | 'you';
	readonly text: string;
	readonly resolve: boolean;
	readonly checked: boolean;
	readonly edited?: boolean;
}

export interface ReviewDraft {
	readonly comments: readonly DraftComment[];
	readonly replies: readonly DraftReply[];
}

export const emptyDraft: ReviewDraft = { comments: [], replies: [] };

// --- The merge request's diff

export interface DiffLine {
	readonly type: 'context' | 'added' | 'removed';
	readonly oldLine?: number;
	readonly newLine?: number;
}

export interface Hunk {
	readonly newStart: number;
	/** The hunk's last line in the new version; below `newStart` when it only removes lines. */
	readonly newEnd: number;
	readonly lines: readonly DiffLine[];
}

/** The hunks of one file's diff as GitLab returns it (`@@ -a,b +c,d @@` and the lines). */
export function parseHunks(diff: string): Hunk[] {
	const hunks: Hunk[] = [];
	let lines: DiffLine[] = [];
	let oldLine = 0;
	let newLine = 0;
	let start = 0;
	const close = () => {
		if (start) {
			hunks.push({ newStart: start, newEnd: newLine - 1, lines });
		}
	};
	for (const text of diff.split('\n')) {
		const header = /^@@ -(?<old>\d+)(?:,\d+)? \+(?<new>\d+)(?:,(?<count>\d+))? @@/.exec(text);
		if (header?.groups) {
			close();
			oldLine = Number(header.groups.old);
			newLine = Number(header.groups.new);
			// "+0,0" is a hunk that adds nothing: its lines start after line 0.
			start = header.groups.count === '0' ? newLine + 1 : newLine;
			if (header.groups.count === '0') {
				newLine++;
			}
			lines = [];
			continue;
		}
		if (!start) {
			continue;
		}
		if (text.startsWith('+')) {
			lines.push({ type: 'added', newLine: newLine++ });
		} else if (text.startsWith('-')) {
			lines.push({ type: 'removed', oldLine: oldLine++ });
		} else if (text.startsWith(' ')) {
			lines.push({ type: 'context', oldLine: oldLine++, newLine: newLine++ });
		}
	}
	close();
	return hunks;
}

/** The new version's line ranges a comment can go on: those inside the diff. */
export function commentableRanges(hunks: readonly Hunk[]): { start: number; end: number }[] {
	return hunks.filter(h => h.newEnd >= h.newStart).map(h => ({ start: h.newStart, end: h.newEnd }));
}

/** Where line `line` of the new version sits in the diff: added, or unchanged with its old line. Unset outside the diff. */
export function lineInDiff(hunks: readonly Hunk[], line: number): { readonly added: boolean; readonly oldLine?: number } | undefined {
	for (const hunk of hunks) {
		const found = hunk.lines.find(l => l.newLine === line);
		if (found) {
			return found.type === 'added' ? { added: true } : { added: false, oldLine: found.oldLine };
		}
	}
	return undefined;
}

/** Whether lines `start` to `end` of the new version are all in one hunk, as a suggestion's must be. */
export function inOneHunk(hunks: readonly Hunk[], start: number, end: number): boolean {
	return hunks.some(h => start >= h.newStart && end <= h.newEnd);
}

// --- Gemini's findings and the user's edits

/**
 * The draft after Gemini (re)read its review: the user's own comments and
 * replies and Gemini's edited ones stay; Gemini's untouched ones are replaced
 * by `findings`, less any that repeat a comment kept. New ids start with `prefix`.
 */
export function mergeFindings(draft: ReviewDraft, findings: readonly ReviewFinding[], prefix: string, anchors: (file: string, line: number) => string | undefined = () => undefined): ReviewDraft {
	const comments = draft.comments.filter(c => c.by === 'you' || c.edited);
	const replies = draft.replies.filter(r => r.by === 'you' || r.edited);
	const repeats = (f: ReviewFinding) => comments.some(c => c.file === f.file && c.line === f.line && c.title === f.title);
	const added: DraftComment[] = [];
	const addedReplies: DraftReply[] = [];
	findings.forEach((f, i) => {
		const id = `${prefix}-${i}`;
		if (f.discussion) {
			if (!replies.some(r => r.discussion === f.discussion)) {
				addedReplies.push({ id, discussion: f.discussion, by: 'gemini', text: f.comment, resolve: false, checked: false });
			}
			return;
		}
		if (repeats(f)) {
			return;
		}
		const anchor = f.file && f.line ? anchors(f.file, f.line) : undefined;
		added.push({
			id, by: 'gemini', kind: f.kind, title: f.title, comment: f.comment, checked: f.kind !== 'nit',
			...f.file ? { file: f.file } : {},
			...f.line ? { line: f.line } : {},
			...f.line && f.endLine && f.endLine > f.line ? { endLine: f.endLine } : {},
			...f.suggestion !== undefined && f.line ? { suggestion: { text: f.suggestion, by: 'gemini', include: true } } : {},
			...anchor !== undefined ? { anchor } : {},
		});
	});
	return { comments: [...comments, ...added], replies: [...replies, ...addedReplies] };
}

/** Field names the Review page sets as the user types and ticks, by draft item. */
export const draftFieldPattern = /^(?:comment|check|suggestion|include|reply|resolve|rcheck):/;

/** The draft with what the user typed and ticked on the page (`field`) taken in. */
export function foldFields(draft: ReviewDraft, field: (name: string) => unknown): ReviewDraft {
	const text = (name: string): string | undefined => {
		const value = field(name);
		return typeof value === 'string' ? value : undefined;
	};
	const flag = (name: string): boolean | undefined => {
		const value = field(name);
		return typeof value === 'boolean' ? value : undefined;
	};
	return {
		comments: draft.comments.map(c => {
			const comment = text(`comment:${c.id}`);
			const suggestion = text(`suggestion:${c.id}`);
			const include = flag(`include:${c.id}`);
			const changed = (comment !== undefined && comment !== c.comment) || (suggestion !== undefined && suggestion !== c.suggestion?.text);
			return {
				...c,
				comment: comment ?? c.comment,
				checked: flag(`check:${c.id}`) ?? c.checked,
				...c.suggestion ? { suggestion: { text: suggestion ?? c.suggestion.text, by: suggestion !== undefined && suggestion !== c.suggestion.text ? 'you' : c.suggestion.by, include: include ?? c.suggestion.include } } : {},
				...changed && c.by === 'gemini' ? { edited: true } : {},
			};
		}),
		replies: draft.replies.map(r => {
			const reply = text(`reply:${r.id}`);
			return {
				...r,
				text: reply ?? r.text,
				resolve: flag(`resolve:${r.id}`) ?? r.resolve,
				checked: flag(`rcheck:${r.id}`) ?? r.checked,
				...reply !== undefined && reply !== r.text && r.by === 'gemini' ? { edited: true } : {},
			};
		}),
	};
}

/** How many ticked comments are Gemini's and the user's, and how many replies and resolves are ticked. */
export function draftCounts(draft: ReviewDraft): { readonly gemini: number; readonly you: number; readonly comments: number; readonly replies: number } {
	const ticked = draft.comments.filter(c => c.checked);
	const gemini = ticked.filter(c => c.by === 'gemini' && !c.edited).length;
	return { gemini, you: ticked.length - gemini, comments: ticked.length, replies: draft.replies.filter(r => r.checked).length };
}

// --- Suggested changes

/** A fence longer than any run of backticks in `text`, so the text can't close it. */
function fenceFor(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
	return '`'.repeat(Math.max(3, longest + 1));
}

/** The text posted for `comment`: with its suggestion as GitLab's `suggestion:-0+N` block, which replaces lines `line` to `endLine`. */
export function commentBody(comment: DraftComment): string {
	const suggestion = comment.suggestion;
	if (!suggestion?.include || !comment.line) {
		return comment.comment;
	}
	const fence = fenceFor(suggestion.text);
	const below = Math.max(0, (comment.endLine ?? comment.line) - comment.line);
	return `${comment.comment.trimEnd()}\n\n${fence}suggestion:-0+${below}\n${suggestion.text}\n${fence}`;
}

/** The comment and its suggestion in one text to edit, as the editor's comment box shows it. */
export function editableText(comment: DraftComment): string {
	if (!comment.suggestion) {
		return comment.comment;
	}
	const fence = fenceFor(comment.suggestion.text);
	return `${comment.comment.trimEnd()}\n\n${fence}suggestion\n${comment.suggestion.text}\n${fence}`;
}

/** Splits text written in the editor into the comment and a trailing ```suggestion block, when it has one. */
export function splitSuggestion(text: string): { readonly comment: string; readonly suggestion?: string } {
	const match = /(?:^|\n)(?<fence>`{3,})suggestion(?::-?\d+\+\d+)?[ \t]*\n(?<body>[\s\S]*?)\n?\k<fence>[ \t]*$/.exec(text.trimEnd());
	if (!match?.groups) {
		return { comment: text.trim() };
	}
	return { comment: text.slice(0, match.index).trim(), suggestion: match.groups.body };
}

// --- Paths

/** A long path's last `keep` parts after "…/", for a card's header; short paths as they are. */
export function shortPath(file: string, keep = 3): string {
	const parts = file.split('/');
	return parts.length > keep ? `…/${parts.slice(-keep).join('/')}` : file;
}

/** Each path's name, with the shortest end of its folder that tells it apart from others with the same name. */
export function fileLabels(paths: readonly string[]): Map<string, { readonly dir: string; readonly name: string }> {
	const labels = new Map<string, { dir: string; name: string }>();
	for (const file of paths) {
		const parts = file.split('/');
		const name = parts[parts.length - 1];
		const folders = parts.slice(0, -1);
		const others = paths.filter(p => p !== file && p.split('/').pop() === name).map(p => p.split('/').slice(0, -1));
		let dir = '';
		for (let n = 1; others.length && n <= folders.length; n++) {
			const end = folders.slice(-n).join('/');
			dir = `${end}/`;
			if (!others.some(o => o.slice(-n).join('/') === end)) {
				break;
			}
		}
		labels.set(file, { dir, name });
	}
	return labels;
}

// --- A newer commit

/**
 * Where a comment's line is in a newer version of its file (`lines`): the
 * same line when its text is unchanged, else the nearest line with the same
 * text; `changed` when the text is nowhere.
 */
export function relocate(line: number, anchor: string | undefined, lines: readonly string[]): { readonly line: number; readonly changed: boolean } {
	if (anchor === undefined) {
		return { line, changed: false };
	}
	const same = (n: number) => n >= 1 && n <= lines.length && lines[n - 1].trimEnd() === anchor.trimEnd();
	if (same(line)) {
		return { line, changed: false };
	}
	for (let d = 1; d < lines.length; d++) {
		if (same(line - d)) {
			return { line: line - d, changed: false };
		}
		if (same(line + d)) {
			return { line: line + d, changed: false };
		}
	}
	return { line: Math.min(Math.max(1, line), Math.max(1, lines.length)), changed: true };
}

/** The draft on a newer commit: line comments moved to where their lines are now, flagged when a line changed. */
export function moveDraft(draft: ReviewDraft, fileLines: (file: string) => readonly string[] | undefined): ReviewDraft {
	return {
		...draft,
		comments: draft.comments.map(c => {
			const lines = c.file && c.line ? fileLines(c.file) : undefined;
			if (!lines || !c.line) {
				return c;
			}
			const moved = relocate(c.line, c.anchor, lines);
			const shift = moved.line - c.line;
			return {
				...c,
				line: moved.line,
				...c.endLine ? { endLine: c.endLine + shift } : {},
				...moved.changed ? { lineChanged: true, checked: false } : {},
			};
		}),
	};
}

// --- Posting

export type PostItem =
	| { readonly kind: 'comment'; readonly id: string; readonly file?: string; readonly line?: number; readonly oldLine?: number; readonly text: string }
	| { readonly kind: 'reply'; readonly id: string; readonly discussion: string; readonly text: string; readonly resolve: boolean }
	| { readonly kind: 'resolve'; readonly id: string; readonly discussion: string };

/**
 * What posting the draft sends, in order: each ticked comment (on its line
 * when the line is in the diff, else as a general comment that names it),
 * then each ticked reply or resolve. `hunks` gives a file's diff.
 */
export function postItems(draft: ReviewDraft, hunks: (file: string) => readonly Hunk[] | undefined): PostItem[] {
	const items: PostItem[] = [];
	for (const c of draft.comments.filter(c => c.checked && (c.comment.trim() || c.suggestion?.include))) {
		const body = commentBody(c);
		if (!c.file) {
			items.push({ kind: 'comment', id: c.id, text: body });
			continue;
		}
		const place = c.line ? lineInDiff(hunks(c.file) ?? [], c.line) : undefined;
		if (c.line && place) {
			items.push({ kind: 'comment', id: c.id, file: c.file, line: c.line, ...place.oldLine ? { oldLine: place.oldLine } : {}, text: body });
		} else {
			items.push({ kind: 'comment', id: c.id, text: `**${c.file}${c.line ? `:${c.line}` : ''}**\n\n${c.comment}` });
		}
	}
	for (const r of draft.replies.filter(r => r.checked)) {
		if (r.text.trim()) {
			items.push({ kind: 'reply', id: r.id, discussion: r.discussion, text: r.text, resolve: r.resolve });
		} else if (r.resolve) {
			items.push({ kind: 'resolve', id: r.id, discussion: r.discussion });
		}
	}
	return items;
}

/** The draft without the items already posted, so pressing the button again doesn't post them twice. */
export function withoutPosted(draft: ReviewDraft, posted: ReadonlySet<string>): ReviewDraft {
	return { comments: draft.comments.filter(c => !posted.has(c.id)), replies: draft.replies.filter(r => !posted.has(r.id)) };
}

// --- The merge request's threads

export interface ThreadNote {
	readonly path?: string;
	readonly line?: number;
	readonly oldLine?: number;
	/** The head commit the note was written on. */
	readonly headSha?: string;
}

/**
 * Where a thread shows: on its line in the diff when it was written on the
 * shown head (GitLab moves a thread's position while its line is unchanged),
 * else outdated, or on a removed line; general threads have no line.
 */
export function threadPlace(first: ThreadNote, head: string): { readonly file?: string; readonly line?: number; readonly outdated?: boolean; readonly removedLine?: boolean } {
	if (!first.path) {
		return {};
	}
	if (first.headSha && head && first.headSha !== head) {
		return { file: first.path, ...first.line ? { line: first.line } : {}, outdated: true };
	}
	if (!first.line) {
		return { file: first.path, removedLine: !!first.oldLine };
	}
	return { file: first.path, line: first.line };
}
