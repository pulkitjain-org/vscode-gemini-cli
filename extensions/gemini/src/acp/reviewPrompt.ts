/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// "Review my changes": the request for an agent that reviews the uncommitted
// diff without editing anything.

import type { Attachment } from './attachments';
import { git } from './worktrees';

/** Diffs past this many characters are cut; the agent can run git itself for the rest. */
export const maxReviewDiff = 100_000;

export interface WorkingChanges {
	/** `git diff HEAD`: staged and unstaged changes to tracked files. */
	readonly diff: string;
	/** New files Git does not track yet. */
	readonly untracked: readonly string[];
}

/** The repository's uncommitted changes. A repository without commits yet diffs what is staged. */
export async function workingChanges(repository: string): Promise<WorkingChanges> {
	const [diff, untracked] = await Promise.all([
		git(repository, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
			() => git(repository, ['diff', 'HEAD', '--no-color', '--no-ext-diff']),
			// No commits yet; any other failure (such as a diff too large to read) is reported, not narrowed to what is staged.
			() => git(repository, ['diff', '--cached', '--no-color', '--no-ext-diff'])),
		git(repository, ['ls-files', '--others', '--exclude-standard']),
	]);
	return { diff, untracked: untracked.split('\n').filter(Boolean) };
}

/** What "Review my changes" sends: the instructions, with the diff attached as a file. */
export interface ReviewRequest {
	readonly text: string;
	readonly attachments: readonly Attachment[];
}

export function reviewRequest(changes: WorkingChanges): ReviewRequest {
	const cut = changes.diff.length > maxReviewDiff;
	const parts = [
		'Review my uncommitted changes in this repository, as a careful senior reviewer would. Do not edit, create or delete any files, and do not run commands that change anything.',
		'Look for bugs, edge cases, security problems, risky changes, missing tests and unclear code. Read the surrounding code where the diff alone is not enough.',
		'Reply with a one-paragraph summary of what the changes do, then your findings ordered by severity. Give each finding the file and line, what is wrong and a suggested fix. Say so plainly if you find nothing worth changing.',
	];
	if (changes.diff.trim()) {
		parts.push(cut
			? `The attached diff against HEAD was cut at ${maxReviewDiff} characters. Run \`git diff HEAD\` to read the rest.`
			: 'The diff against HEAD is attached.');
	}
	if (changes.untracked.length) {
		const shown = changes.untracked.slice(0, 50);
		const more = changes.untracked.length - shown.length;
		parts.push(`New files not yet added to Git; read them too:\n${shown.map(f => `- ${f}`).join('\n')}${more > 0 ? `\n- and ${more} more (\`git ls-files --others --exclude-standard\`)` : ''}`);
	}
	const attachments: Attachment[] = changes.diff.trim()
		? [{ kind: 'document', name: 'uncommitted.diff', mimeType: 'text/x-diff', text: cut ? changes.diff.slice(0, maxReviewDiff) : changes.diff }]
		: [];
	return { text: parts.join('\n\n'), attachments };
}
