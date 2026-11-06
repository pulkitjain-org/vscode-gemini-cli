/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: the comments the user leaves on a Markdown file an agent wrote,
// in upstream's rich Markdown editor, until they are sent to that agent. Only
// files the Gemini extension marks as an agent's accept comments. Pure, so the
// rules are tested without the workbench (geminiMarkdownComments.ts uses it).

import { IRange } from '../../../../editor/common/core/range.js';

export interface GeminiMarkdownComment {
	readonly id: string;
	readonly range: IRange;
	readonly body: string;
}

interface FileComments {
	readonly agent: string;
	readonly comments: readonly GeminiMarkdownComment[];
}

/** How many files the store remembers; the ones marked longest ago without comments go first. */
const maxFiles = 200;

function isRange(value: unknown): value is IRange {
	const range = value as IRange | undefined;
	return !!range && [range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn].every(n => Number.isInteger(n) && n >= 1);
}

function isComment(value: unknown): value is GeminiMarkdownComment {
	const comment = value as GeminiMarkdownComment | undefined;
	return !!comment && typeof comment.id === 'string' && !!comment.id && typeof comment.body === 'string' && isRange(comment.range);
}

export class GeminiMarkdownCommentStore {

	/** By the file's URI, in the order files were marked, oldest first. */
	private readonly files = new Map<string, FileComments>();

	/** `saved` is what `serialize` wrote; anything malformed in it is dropped. */
	constructor(saved?: string) {
		try {
			const parsed: unknown = JSON.parse(saved ?? '{}');
			for (const [uri, entry] of Object.entries(parsed ?? {})) {
				const { agent, comments } = (entry ?? {}) as { agent?: unknown; comments?: unknown };
				if (typeof agent === 'string' && agent) {
					this.files.set(uri, { agent, comments: Array.isArray(comments) ? comments.filter(isComment) : [] });
				}
			}
		} catch {
			// Start empty.
		}
	}

	/** Lets `uri`, written by agent `agent`, take comments; its comments so far stay. */
	allow(uri: string, agent: string): void {
		const entry = this.files.get(uri);
		this.files.delete(uri);
		this.files.set(uri, { agent, comments: entry?.comments ?? [] });
		this.prune();
	}

	accepts(uri: string): boolean {
		return this.files.has(uri);
	}

	agentOf(uri: string): string | undefined {
		return this.files.get(uri)?.agent;
	}

	comments(uri: string): readonly GeminiMarkdownComment[] {
		return this.files.get(uri)?.comments ?? [];
	}

	/** The files with comments waiting to be sent. */
	commented(): string[] {
		return [...this.files].filter(([, entry]) => entry.comments.length).map(([uri]) => uri);
	}

	/** False when `uri` doesn't take comments. */
	add(uri: string, comment: GeminiMarkdownComment): boolean {
		const entry = this.files.get(uri);
		if (!entry || !isComment(comment)) {
			return false;
		}
		this.files.set(uri, { ...entry, comments: [...entry.comments, comment] });
		return true;
	}

	delete(uri: string, id: string): boolean {
		const entry = this.files.get(uri);
		if (!entry?.comments.some(comment => comment.id === id)) {
			return false;
		}
		this.files.set(uri, { ...entry, comments: entry.comments.filter(comment => comment.id !== id) });
		return true;
	}

	/** Takes `uri`'s comments out to send them, with the agent they go to; undefined when it has none. */
	take(uri: string): { readonly agent: string; readonly comments: readonly GeminiMarkdownComment[] } | undefined {
		const entry = this.files.get(uri);
		if (!entry?.comments.length) {
			return undefined;
		}
		this.files.set(uri, { ...entry, comments: [] });
		return entry;
	}

	/** Puts back comments that didn't go, ahead of any added meanwhile. */
	restore(uri: string, comments: readonly GeminiMarkdownComment[]): void {
		const entry = this.files.get(uri);
		if (!entry) {
			return;
		}
		const later = entry.comments.filter(comment => !comments.some(each => each.id === comment.id));
		this.files.set(uri, { ...entry, comments: [...comments, ...later] });
	}

	serialize(): string {
		return JSON.stringify(Object.fromEntries(this.files));
	}

	private prune(): void {
		for (const [uri, entry] of this.files) {
			if (this.files.size <= maxFiles) {
				return;
			}
			if (!entry.comments.length) {
				this.files.delete(uri);
			}
		}
	}
}
