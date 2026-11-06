/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// "Review my changes": the request for an agent that reviews the uncommitted
// diff without editing anything.

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Attachment } from './attachments';
import { git } from './worktrees';

/**
 * Diffs past this many characters are cut; the agent reads the rest a file
 * at a time. 100,000 characters is about 25,000 tokens: well inside the
 * model's limit with the rest of the prompt, and over twice the 40,000
 * characters the CLI's own tool-output cap allows a single `git diff` the
 * agent runs (cliPatches.ts), so a review prompt is never the largest
 * thing in the context, and a diff that is cut here would have been cut
 * harder by the tool.
 */
export const maxReviewDiff = 100_000;

export interface WorkingChanges {
	/** `git diff HEAD`: staged and unstaged changes to tracked files, read only a little past `maxReviewDiff`. */
	readonly diff: string;
	/** New files Git does not track yet. */
	readonly untracked: readonly string[];
	/** The tracked files the diff changes, read only when the diff is cut, so the agent can read each on its own. */
	readonly files?: readonly string[];
}

/**
 * The repository's uncommitted changes. A repository without commits yet
 * diffs what is staged. The diff is read as it comes and git stopped once
 * it is past `maxReviewDiff`: a huge diff is never held whole, and never
 * fails the review for being too large to read.
 */
export async function workingChanges(repository: string): Promise<WorkingChanges> {
	// No commits yet: what is staged.
	const against = await git(repository, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => ['HEAD'], () => ['--cached']);
	const [diff, untracked] = await Promise.all([
		gitUpTo(repository, ['diff', ...against, '--no-color', '--no-ext-diff'], maxReviewDiff),
		git(repository, ['ls-files', '--others', '--exclude-standard']),
	]);
	const files = diff.length > maxReviewDiff ? (await git(repository, ['diff', ...against, '--name-only'])).split('\n').filter(Boolean) : undefined;
	return { diff, untracked: untracked.split('\n').filter(Boolean), ...files ? { files } : {} };
}

/** Git's output, read as it comes and stopped once it is longer than `limit` characters; rejects with git's stderr otherwise. */
function gitUpTo(cwd: string, args: readonly string[], limit: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
		const decoder = new StringDecoder('utf8');
		let text = '';
		let stderr = '';
		let enough = false;
		child.stdout.on('data', (chunk: Buffer) => {
			if (enough) {
				return;
			}
			text += decoder.write(chunk);
			if (text.length > limit) {
				enough = true;
				child.kill();
			}
		});
		child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk); });
		child.on('error', reject);
		child.on('close', code => {
			if (enough || code === 0) {
				resolve(enough ? text : text + decoder.end());
			} else {
				reject(new Error(stderr.trim() || `git ${args[0]} exited with ${code}`));
			}
		});
	});
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
		if (cut) {
			// Never the whole diff in one command (ARCHITECTURE.md): the files are listed, to read one or two at a time.
			const shown = (changes.files ?? []).slice(0, 100);
			const more = (changes.files?.length ?? 0) - shown.length;
			parts.push([
				`The attached diff against HEAD was cut at ${maxReviewDiff} characters. Read the rest one or two files at a time with \`git diff HEAD -- <file>\`, never \`git diff HEAD\` whole.`,
				...shown.length ? [`The changed files:\n${shown.map(f => `- ${f}`).join('\n')}${more > 0 ? `\n- and ${more} more (\`git diff HEAD --name-only\`)` : ''}`] : [],
			].join('\n'));
		} else {
			parts.push('The diff against HEAD is attached.');
		}
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
