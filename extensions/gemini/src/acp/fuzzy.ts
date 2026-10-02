/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Ranks workspace paths against what the user typed after "@". Runs on every
// keystroke over the cached file list, so it does no allocation per path
// beyond the lower-cased copy made once when the list is built.

export interface IndexedPath {
	/** Workspace-relative, with forward slashes. */
	readonly relative: string;
	readonly lower: string;
	/** Index in `lower` where the file name starts. */
	readonly nameStart: number;
}

export function indexPath(relative: string): IndexedPath {
	const normalized = relative.replace(/\\/g, '/');
	return { relative: normalized, lower: normalized.toLowerCase(), nameStart: normalized.lastIndexOf('/') + 1 };
}

/**
 * Scores `query` as a subsequence of the path, or returns undefined when it
 * does not match. Higher is better: matches in the file name, at the start
 * of words and in runs score more; long paths score a little less.
 */
export function scorePath(query: string, path: IndexedPath): number | undefined {
	if (!query) {
		return 0;
	}
	const { lower, nameStart } = path;
	// Prefer a match that lies entirely in the file name.
	const inName = matchFrom(query, lower, nameStart);
	const match = inName ?? matchFrom(query, lower, 0);
	if (match === undefined) {
		return undefined;
	}
	return match + (inName !== undefined ? 50 : 0) - lower.length * 0.1;
}

function matchFrom(query: string, lower: string, start: number): number | undefined {
	let score = 0;
	let position = start;
	let previous = -2;
	for (let i = 0; i < query.length; i++) {
		const found = lower.indexOf(query[i], position);
		if (found === -1) {
			return undefined;
		}
		score += 1;
		if (found === previous + 1) {
			score += 5;
		}
		const before = lower[found - 1];
		if (found === 0 || before === '/' || before === '.' || before === '-' || before === '_') {
			score += 8;
		}
		previous = found;
		position = found + 1;
	}
	return score;
}

/** The best `limit` paths for `query`, best first. */
export function rankPaths<T extends IndexedPath>(query: string, paths: readonly T[], limit: number): T[] {
	const lowerQuery = query.toLowerCase().replace(/\\/g, '/');
	const scored: { path: T; score: number }[] = [];
	for (const path of paths) {
		const score = scorePath(lowerQuery, path);
		if (score !== undefined) {
			scored.push({ path, score });
		}
	}
	scored.sort((a, b) => b.score - a.score || a.path.relative.length - b.path.relative.length);
	return scored.slice(0, limit).map(s => s.path);
}

/**
 * Combines glob patterns into one `{a,b,c}` pattern, as findFiles takes a
 * single exclude. VS Code globs cannot nest braces, so patterns that have
 * their own braces are expanded first (`*.{js,map}` to `*.js`, `*.map`).
 */
export function combineGlobs(patterns: Iterable<string>): string | undefined {
	const expanded = new Set<string>();
	for (const pattern of patterns) {
		for (const single of expandBraces(pattern)) {
			expanded.add(single);
		}
	}
	return expanded.size ? `{${[...expanded].join(',')}}` : undefined;
}

function expandBraces(pattern: string): string[] {
	const match = /\{([^{}]*)\}/.exec(pattern);
	if (!match) {
		return [pattern];
	}
	const before = pattern.slice(0, match.index);
	const after = pattern.slice(match.index + match[0].length);
	return match[1].split(',').flatMap(choice => expandBraces(before + choice + after));
}
