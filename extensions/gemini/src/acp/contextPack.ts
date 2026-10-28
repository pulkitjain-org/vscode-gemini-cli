/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the workspace index knows around a set of files, written into the
// prompt of an agent that can't call the index tools itself: a merge request's
// reviewer works in a checkout the Gemini CLI never trusts, where MCP tools
// don't reach the model (FINDINGS.md). Paths only, never file contents, so the
// prompt stays small and the agent reads what it needs.

import type { RelatedResult } from './index/query';

/** The most files a context pack covers. */
export const contextPackFiles = 30;
/** The most paths listed for one file in each list. */
const perList = 5;

export interface ContextPackEntry {
	readonly file: string;
	/** What the index found for it; unset when it couldn't be asked, `known: false` when the index doesn't have the file. */
	readonly related?: RelatedResult & { readonly known: boolean };
}

function list(paths: readonly string[]): string {
	return paths.length > perList ? `${paths.slice(0, perList).join(', ')} (+${paths.length - perList} more)` : paths.join(', ');
}

/**
 * The context pack for `entries`, `total` files in all, or undefined when the
 * index knows nothing useful about any of them.
 */
export function contextPack(entries: readonly ContextPackEntry[], total = entries.length): string | undefined {
	const lines: string[] = [];
	for (const { file, related } of entries) {
		if (!related?.known) {
			continue;
		}
		const parts = [
			related.tests.length ? `tests: ${list(related.tests)}` : undefined,
			related.importedBy.length ? `used by: ${list(related.importedBy)}` : undefined,
			related.changedWith.length ? `usually changed with: ${list(related.changedWith.map(c => c.path))}` : undefined,
		].filter(Boolean);
		lines.push(parts.length ? `- ${file}: ${parts.join('; ')}` : `- ${file}: no tests, users or usual companions in the index`);
	}
	if (!lines.length) {
		return undefined;
	}
	return [
		`What the workspace index knows around the changed files${total > entries.length ? ` (the first ${entries.length} of ${total})` : ''}, from the repository's main checkout. You can't search the index from here, so it comes with this prompt. Paths only: read what matters, such as the tests of a changed file and the callers a change could break.`,
		...lines,
	].join('\n');
}
