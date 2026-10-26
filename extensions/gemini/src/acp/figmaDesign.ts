/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A Figma design with one frame for each screen size (XS, S, M, L, or
// Mobile, Tablet, Desktop), as designers lay them out side by side: the
// developer shares one link for each size, and the agent reads them one size
// at a time. Pure, for the chat's Add Figma Design dialog and its tests.

import { parseToolLink } from './toolLinks';

export interface DesignFrame {
	/** The screen size, as the team names it. */
	readonly size: string;
	readonly url: string;
}

/** The sizes offered when the team's defaults name none. */
export const defaultDesignSizes: readonly string[] = ['Mobile', 'Tablet', 'Desktop'];

/** The Figma frame links in `text`, in order, once each. */
export function figmaLinksIn(text: string): string[] {
	const found = (text.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []).filter(link => parseToolLink(link)?.tool === 'figma');
	return [...new Set(found.map(link => link.replace(/[.,;:!?]+$/, '')))];
}

/** The file a Figma link is in, or undefined when it isn't a Figma link. */
export function figmaFileOf(url: string): string | undefined {
	const ref = parseToolLink(url);
	return ref?.tool === 'figma' ? ref.fileKey : undefined;
}

/** The size for each of `count` new links, after the sizes `taken`: the team's sizes in order, skipping the ones used. */
export function nextSizes(count: number, sizes: readonly string[], taken: readonly string[]): string[] {
	const free = sizes.filter(size => !taken.includes(size));
	return Array.from({ length: count }, (_, i) => free[i] ?? sizes[sizes.length - 1] ?? '');
}

/** What may be wrong with a design: frames from another file than the first, and sizes used twice. */
export interface DesignWarnings {
	/** The sizes whose frame is in another file than the first frame's. */
	readonly otherFile: readonly string[];
	/** Sizes given to more than one frame. */
	readonly repeated: readonly string[];
}

export function designWarnings(frames: readonly DesignFrame[]): DesignWarnings {
	const first = frames.map(frame => figmaFileOf(frame.url)).find(Boolean);
	const counts = new Map<string, number>();
	for (const frame of frames) {
		counts.set(frame.size, (counts.get(frame.size) ?? 0) + 1);
	}
	return {
		otherFile: frames.filter(frame => first && figmaFileOf(frame.url) && figmaFileOf(frame.url) !== first).map(frame => frame.size),
		repeated: [...counts].filter(([, n]) => n > 1).map(([size]) => size),
	};
}

/** The design as the agent reads it in the prompt: each size's link, and how to use them. */
export function designPrompt(frames: readonly DesignFrame[]): string {
	return [
		'Figma design, one frame for each screen size:',
		...frames.map(frame => `- ${frame.size}: ${frame.url}`),
		'',
		'Read each with figma_design, passing its size as `viewport`, as you build that size, the smallest first; compare what you built with figma_screenshot for the same size.',
		'A large frame comes a few sections at a time: read the sections an answer lists as not read yet when you get to them, not all at once.',
		'Match each size to the project\'s own CSS breakpoints (its Tailwind config, SCSS variables or media queries); the frames\' widths are hints, not breakpoints to hard-code.',
		...designWarnings(frames).otherFile.length ? ['Some frames are in another Figma file: Figma\'s desktop app reads the file that is open, so ask the user to open that file when you get to them.'] : [],
	].join('\n');
}

/** A stable id for the design's chip, from its frames. */
export function designRefId(frames: readonly DesignFrame[]): string {
	return `figma-design:${frames.map(frame => {
		const ref = parseToolLink(frame.url);
		return ref?.tool === 'figma' ? `${ref.fileKey}/${ref.nodeId ?? ''}` : frame.url;
	}).join(',')}`;
}
