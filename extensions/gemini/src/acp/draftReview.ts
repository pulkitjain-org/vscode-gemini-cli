/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the user decided on a draft of a new version of a Confluence page,
// and the page that publishing makes from it. The agent reads a page as text
// and writes the whole page as Markdown, so every block Markdown can't
// write (a macro, table, mention, image, panel, status, date, card, emoji,
// coloured or commented text) would come back removed. Such blocks are put
// back where they were and shown as kept; only the user, deleting one in
// Edit, takes one out. Publishing sends the page as it is with only the
// changes the user kept. Pure, for the Review Page's webview, the publish
// and their tests.

import type { AdfNode } from './confluence';
import { blockChanges, type BlockPart, type MergeConflict } from './blockMerge';

/** The user's decisions on a draft, kept with it so closing the Review Page loses none. */
export interface DraftReview {
	/** The changes kept, by `BlockChange.key`. */
	readonly kept?: readonly string[];
	/** The stretches of the page the agent's draft removed or rewrote that hold what Markdown can't write: put back, by block index in the page. */
	readonly held?: readonly number[];
	/** Where the page changed since the draft and both changed the same part, until the user picks. */
	readonly conflicts?: readonly MergeConflict[];
}

const markdownNodes = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock', 'rule', 'text', 'hardBreak']);
const markdownMarks = new Set(['strong', 'em', 'strike', 'code', 'link']);

/** Whether the agent's Markdown can write `node` as it is: no macro, table, mention, image, panel, colour or comment in it. */
export function markdownCarries(node: AdfNode): boolean {
	return markdownNodes.has(node.type)
		&& !node.marks?.some(mark => !markdownMarks.has(mark.type) || mark.type === 'link' && Object.keys(mark.attrs ?? {}).some(name => name !== 'href'))
		&& (node.content ?? []).every(markdownCarries);
}

/**
 * The agent's draft (`draft`, made from `base`) with every stretch of the
 * page it removed or rewrote that holds a block Markdown can't write put
 * back as it was, and the agent's blocks for that stretch after it: an
 * insertion the user takes only by choosing it (`rewritesHeld`), never by
 * Keep All. `held` is where the stretches put back are in the page.
 */
export function holdBlocks(base: readonly AdfNode[], draft: readonly AdfNode[]): { readonly content: AdfNode[]; readonly held: number[] } {
	const content: AdfNode[] = [];
	const held: number[] = [];
	for (const part of blockChanges(base, draft)) {
		if (part.kind === 'same') {
			content.push(part.node);
		} else if (part.removed.every(markdownCarries)) {
			content.push(...part.added);
		} else {
			content.push(...part.removed, ...part.added);
			held.push(...part.removed.map((_, i) => part.at + i));
		}
	}
	return { content, held };
}

/** Whether `part` is the agent's version of a stretch put back (`held`): the page's version stays unless the user takes it. */
export function rewritesHeld(part: BlockPart, held: readonly number[]): boolean {
	return part.kind === 'change' && !part.removed.length && held.includes(part.at - 1);
}

/** The changes Keep All keeps: all but the agent's versions of stretches put back. */
export function keepAllKeys(parts: readonly BlockPart[], held: readonly number[]): string[] {
	return parts.flatMap(part => part.kind === 'change' && !rewritesHeld(part, held) ? [part.key] : []);
}

/**
 * The draft with the agent's version (change `key`) taken in place of the
 * stretch put back before it, and what is still put back. The change it
 * makes starts at `from`, for the user's choice to be kept.
 */
export function takeRewrite(parts: readonly BlockPart[], held: readonly number[], key: string): { readonly content: AdfNode[]; readonly held: number[]; readonly from: number } {
	const change = parts.find(part => part.kind === 'change' && part.key === key)!;
	let from = change.at;
	while (held.includes(from - 1)) {
		from--;
	}
	return {
		content: parts.flatMap(part => part.kind === 'same' ? part.at >= from && part.at < change.at ? [] : [part.node] : part.added),
		held: held.filter(i => i < from || i >= change.at),
		from,
	};
}

/** What `nodes` hold that Markdown can't write, by kind (`mention`, `extension`, `table`, `media`, `annotation`, `textColor`…), each once. */
export function lostKinds(nodes: readonly AdfNode[]): string[] {
	const kinds = new Set<string>();
	const visit = (node: AdfNode) => {
		if (!markdownNodes.has(node.type)) {
			kinds.add(kindOf(node.type));
		}
		node.marks?.forEach(mark => markdownMarks.has(mark.type) || kinds.add(kindOf(mark.type)));
		node.content?.forEach(visit);
	};
	nodes.forEach(visit);
	return [...kinds];
}

function kindOf(type: string): string {
	return /Extension$/.test(type) ? 'extension' : /^media/.test(type) ? 'media' : /^(block|embed)Card$/.test(type) ? 'inlineCard' : type === 'backgroundColor' ? 'textColor' : /^table/.test(type) ? 'table' : type;
}

/**
 * `nodes` as Confluence takes them: a heading in a list item (which Markdown
 * such as `- # Step` makes) becomes bold text, and code text keeps no mark
 * but a link or an inline comment.
 */
export function confluenceSafe(nodes: readonly AdfNode[]): AdfNode[] {
	return nodes.map(function safe(node: AdfNode): AdfNode {
		let content = node.content?.map(safe);
		if (node.type === 'listItem' && content?.some(child => child.type === 'heading')) {
			content = content.map(child => child.type === 'heading' ? { type: 'paragraph', ...child.content ? { content: child.content.map(bold) } : {} } : child);
			// The empty paragraph a list item gets to start with, before a heading, isn't needed once the heading is a paragraph.
			if (content.length > 1 && content[0].type === 'paragraph' && !content[0].content?.length) {
				content.shift();
			}
		}
		const marks = node.marks && codeMarks(node.marks);
		return { ...node, ...content ? { content } : {}, ...marks ? { marks } : {} };
	});
}

type Mark = NonNullable<AdfNode['marks']>[number];

/** Code text takes no other marks in Confluence but a link or an inline comment. */
export function codeMarks(marks: readonly Mark[]): Mark[] {
	return marks.some(m => m.type === 'code') ? marks.filter(m => m.type === 'code' || m.type === 'link' || m.type === 'annotation') : [...marks];
}

/** A list item's heading's text, bold. */
export function bold(node: AdfNode): AdfNode {
	return node.type !== 'text' || node.marks?.some(m => m.type === 'strong' || m.type === 'code') ? node : { ...node, marks: [{ type: 'strong' }, ...node.marks ?? []] };
}

/** The page publishing makes: `base` with only the changes in `kept`; any other change leaves the page's blocks as they are. */
export function publishBlocks(parts: readonly BlockPart[], kept: ReadonlySet<string>): AdfNode[] {
	return parts.flatMap(part => part.kind === 'same' ? [part.node] : kept.has(part.key) ? part.added : part.removed);
}

/** The draft with change `key` undone: the page's blocks back there. */
export function undoBlocks(parts: readonly BlockPart[], key: string): AdfNode[] {
	return parts.flatMap(part => part.kind === 'same' ? [part.node] : part.key === key ? part.removed : part.added);
}

/** The changes not yet kept or undone; the agent's version of a stretch put back waits for no one: the page's stays. */
export function undecided(parts: readonly BlockPart[], kept: ReadonlySet<string>, held: readonly number[] = []): number {
	return parts.filter(part => part.kind === 'change' && !kept.has(part.key) && !rewritesHeld(part, held)).length;
}

/**
 * The kept changes after the user edited the draft in Edit (`before` to
 * `after`): an edit of their own is kept, unless it touches a change of the
 * agent's they haven't decided on, which stays for them to decide.
 */
export function keepEdits(before: readonly BlockPart[], after: readonly BlockPart[], kept: ReadonlySet<string>): Set<string> {
	const known = new Set<string>();
	const open: { from: number; to: number }[] = [];
	for (const part of before) {
		if (part.kind === 'change') {
			known.add(part.key);
			if (!kept.has(part.key)) {
				open.push({ from: part.at, to: part.at + part.removed.length });
			}
		}
	}
	const next = new Set<string>();
	for (const part of after) {
		if (part.kind !== 'change') {
			continue;
		}
		const to = part.at + part.removed.length;
		if (kept.has(part.key) || !known.has(part.key) && !open.some(o => o.from <= to && part.at <= o.to)) {
			next.add(part.key);
		}
	}
	return next;
}
