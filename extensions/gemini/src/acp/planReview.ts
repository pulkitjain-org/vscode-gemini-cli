/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Plan Review's Markdown: a plan split into the sections the user edits and
// comments on (a heading with what follows it, or, in a plan with no
// headings, each block between blank lines), a section's text replaced in
// the plan as it is now, the sections a revision changed, and the one
// message that hands the user's comments to the agent. Pure, for the host
// (planReviewPage.ts) and the page (webview-src/planReview.ts) alike.

export interface PlanSection {
	/** Stable while the plan is revised: the heading's text and how many times it came before, or the block's position. */
	readonly id: string;
	/** The heading's text, without its #s; unset for text before the first heading and for a plan without headings. */
	readonly heading?: string;
	/** The section's Markdown, its heading included. */
	readonly markdown: string;
	/** The first words after the heading, for the message's quote. */
	readonly opening: string;
	/** The section's first line in the plan, and the line after its last. */
	readonly start: number;
	readonly end: number;
}

/** A comment on a section, kept until it is sent and then until the user clears it. */
export interface PlanComment {
	readonly id: string;
	/** The section's id when the comment was made. */
	readonly section: string;
	readonly heading?: string;
	/** The text the user selected to comment on, or the section's opening words. */
	readonly quote: string;
	readonly text: string;
	readonly createdAt: number;
	/** When it went to the agent, in ms since the epoch. */
	readonly sentAt?: number;
}

const fence = /^\s{0,3}(```|~~~)/;
const headingLine = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/** The plan's sections, in order. */
export function planSections(markdown: string): PlanSection[] {
	const lines = markdown.split('\n');
	const starts: { line: number; heading?: string }[] = [];
	let inFence: string | undefined;
	lines.forEach((line, i) => {
		const open = fence.exec(line)?.[1];
		if (open) {
			inFence = inFence === undefined ? open : inFence === open ? undefined : inFence;
			return;
		}
		const heading = inFence === undefined ? headingLine.exec(line) : null;
		if (heading) {
			starts.push({ line: i, heading: heading[2] });
		}
	});
	if (!starts.length) {
		return blockSections(lines);
	}
	const sections: PlanSection[] = [];
	if (starts[0].line > 0 && lines.slice(0, starts[0].line).some(line => line.trim())) {
		sections.push(section('intro', undefined, lines, 0, starts[0].line));
	}
	const seen = new Map<string, number>();
	starts.forEach((start, i) => {
		const key = start.heading!.toLowerCase();
		const count = seen.get(key) ?? 0;
		seen.set(key, count + 1);
		sections.push(section(`h:${key}${count ? `#${count + 1}` : ''}`, start.heading, lines, start.line, starts[i + 1]?.line ?? lines.length));
	});
	return sections;
}

/** A plan without headings: each block between blank lines, a code block kept whole. */
function blockSections(lines: readonly string[]): PlanSection[] {
	const sections: PlanSection[] = [];
	let start: number | undefined;
	let inFence = false;
	for (let i = 0; i <= lines.length; i++) {
		const line = lines[i];
		if (line !== undefined && fence.test(line)) {
			inFence = !inFence;
		}
		const blank = line === undefined || (!inFence && !line.trim());
		if (!blank && start === undefined) {
			start = i;
		} else if (blank && start !== undefined) {
			sections.push(section(`b:${sections.length + 1}`, undefined, lines, start, i));
			start = undefined;
		}
	}
	return sections;
}

function section(id: string, heading: string | undefined, lines: readonly string[], start: number, end: number): PlanSection {
	const markdown = lines.slice(start, end).join('\n').replace(/\n+$/, '');
	const body = (heading ? lines.slice(start + 1, end) : lines.slice(start, end)).map(line => line.replace(/^\s*([-+*]|\d+[.)])\s+/, '')).join(' ');
	return { id, ...heading ? { heading } : {}, markdown, opening: opening(body), start, end };
}

/** The first words of `text` as plain text, for a quote: Markdown marks and code fences dropped. */
function opening(text: string, max = 60): string {
	const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/[`*_>#[\]]/g, '').replace(/\(\S+\)/g, '').replace(/\s+/g, ' ').trim();
	return plain.length > max ? `${plain.slice(0, max).replace(/\s+\S*$/, '')}…` : plain;
}

/** `markdown` with section `id` replaced by `text`; undefined when the plan no longer has that section. */
export function replaceSection(markdown: string, id: string, text: string): string | undefined {
	const target = planSections(markdown).find(each => each.id === id);
	if (!target) {
		return undefined;
	}
	const lines = markdown.split('\n');
	// The blank lines that separated it from the next section stay.
	const trailing = lines.slice(target.start, target.end).join('\n').match(/\n+$/)?.[0] ?? '';
	const replaced = text.replace(/\n+$/, '') + trailing;
	return [...lines.slice(0, target.start), ...replaced.split('\n'), ...lines.slice(target.end)].join('\n');
}

/** The sections of `after` that are new or differ from the section with the same id in `before`. */
export function changedSections(before: string, after: string): string[] {
	const old = new Map(planSections(before).map(each => [each.id, each.markdown.trim()]));
	return planSections(after).filter(each => old.get(each.id) !== each.markdown.trim()).map(each => each.id);
}

/** The words of the review message, localized by the host; `{0}`, `{1}` are its placeholders. */
export interface ReviewWords {
	/** `{0}` is the plan file's name. */
	readonly intro: string;
	/** `{0}` lists the sections the user edited. */
	readonly edited: string;
	readonly comments: string;
	/** `{0}` is a section's heading, `{1}` the text quoted; for a section without a heading, `{1}` only. */
	readonly onSection: string;
	readonly onText: string;
	/** `{0}` is the plan file's name: what Build This Plan sends after a review. */
	readonly build: string;
}

/**
 * The one message that hands a review to the agent: what the user edited and
 * every comment not sent yet, each with where it applies. Undefined when
 * there is nothing to send.
 */
export function reviewMessage(file: string, comments: readonly PlanComment[], edited: readonly string[], words: ReviewWords): string | undefined {
	const open = comments.filter(comment => !comment.sentAt);
	if (!open.length) {
		return undefined;
	}
	const lines = [format(words.intro, file)];
	if (edited.length) {
		lines.push('', format(words.edited, edited.map(heading => `"${heading}"`).join(', ')));
	}
	lines.push('', words.comments);
	open.forEach((comment, i) => {
		const where = comment.heading ? format(words.onSection, comment.heading, comment.quote) : format(words.onText, comment.quote);
		lines.push(`${i + 1}. ${where}: ${comment.text.trim()}`);
	});
	return lines.join('\n');
}

function format(template: string, ...values: string[]): string {
	return template.replace(/\{(\d+)\}/g, (match, index: string) => values[Number(index)] ?? match);
}
