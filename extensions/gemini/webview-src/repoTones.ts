/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Each of a project's repositories has a colour of its own, the same on
// thread cards, in the New thread dialog, in Project settings and in the
// footer, so a repository reads at a glance. Colours follow the project's
// order of repositories once the side panel has sent it, else the name.

const toneCount = 6;
let order: readonly string[] = [];

/** The project's repositories, in order; the first gets the first colour. */
export function setRepoOrder(keys: readonly string[]): void {
	if (keys.join('\n') === order.join('\n')) {
		return;
	}
	order = keys;
	// What was drawn before the order came takes its colour from it now.
	document.querySelectorAll<HTMLElement>('[data-tone][data-repo]').forEach(node => node.dataset.tone = String(repoTone(node.dataset.repo!)));
}

/** The colour (0 to 5) for repository `key`. */
export function repoTone(key: string): number {
	const index = order.indexOf(key);
	if (index >= 0) {
		return index % toneCount;
	}
	let hash = 0;
	for (const char of key) {
		hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	}
	return hash % toneCount;
}

/** Gives `node` repository `key`'s colour, which media/chat.css reads as `--repo-tone`. */
export function toneOf<T extends HTMLElement>(node: T, key: string): T {
	node.dataset.repo = key;
	node.dataset.tone = String(repoTone(key));
	return node;
}
