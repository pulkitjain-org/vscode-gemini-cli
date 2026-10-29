/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Try in Workspace's decisions, apart from git and the editor
// (src/host/agents/agentTries.ts does both): what Take Back returns to and
// leaves behind, which conflicts still hold updating back, which edits are
// the user's to send, whether Restore would replace newer work and how the
// card offers it, and which files Source Control marks.

import * as path from 'node:path';
import type { AgentRecord, AgentTried, DiscardedRepo, TriedRepo } from './agents';

/** The tree Take Back puts a repository's tried files back to: what was kept, else the base, with the edits the user sent on top. */
/**
 * Whether a try was interrupted: Try in Workspace was writing the checkout
 * when the window ended. Its files may be half in; the next start takes
 * them back (`AgentTries.finishInterrupted`).
 */
export function interruptedTry(record: Pick<AgentRecord, 'tried'>): boolean {
	return record.tried?.state === 'applying';
}

export function takeBackTree(repo: TriedRepo): string {
	return repo.back ?? repo.kept ?? repo.base;
}

/** A repository's try as kept: its tree is the user's now, and nothing waits on an update. */
export function keptRepo(repo: TriedRepo): TriedRepo {
	const { kept: _kept, applied: _applied, back: _back, conflicts: _conflicts, unmerged: _unmerged, deferred: _deferred, mixed: _mixed, ...rest } = repo;
	return rest;
}

/**
 * What is left of a try once the repositories in `takenBack` (by key) were
 * taken back: nothing, or what had been kept there, kept again with the
 * edits the user sent since. A repository not taken back (a failure part
 * way) is still being tried.
 */
export function afterTakeBack(tried: AgentTried, takenBack: ReadonlySet<string>, at: number): AgentTried | undefined {
	const left = tried.repos.filter(repo => !takenBack.has(repo.key));
	if (left.length) {
		return { ...tried, repos: left, at };
	}
	const kept = tried.repos.filter(repo => repo.kept);
	return kept.length ? { state: 'kept', repos: kept.map(repo => keptRepo({ ...repo, tree: takeBackTree(repo) })), at } : undefined;
}

/**
 * A repository's try with its problems as they are now. `marked`: the
 * conflict files that still have markers. `taken`: the unmerged files that
 * now hold the thread's version. Returns `repo` itself when nothing changed.
 */
export function settleConflicts(repo: TriedRepo, marked: readonly string[], taken: readonly string[]): TriedRepo {
	const conflicts = (repo.conflicts ?? []).filter(file => marked.includes(file));
	const unmerged = (repo.unmerged ?? []).filter(file => !taken.includes(file));
	if (conflicts.length === (repo.conflicts?.length ?? 0) && unmerged.length === (repo.unmerged?.length ?? 0)) {
		return repo;
	}
	return withProblems(repo, { conflicts, unmerged, deferred: repo.deferred ?? [] });
}

/** `repo` with the problems an apply reported, each left out when there are none. */
export function withProblems(repo: TriedRepo, problems: { readonly conflicts: readonly string[]; readonly unmerged: readonly string[]; readonly deferred: readonly string[] }): TriedRepo {
	const { conflicts: _conflicts, unmerged: _unmerged, deferred: _deferred, ...rest } = repo;
	return {
		...rest,
		...problems.conflicts.length ? { conflicts: problems.conflicts } : {},
		...problems.unmerged.length ? { unmerged: problems.unmerged } : {},
		...problems.deferred.length ? { deferred: problems.deferred } : {},
	};
}

/** Whether the try's updates wait on conflict markers. */
export function paused(tried: AgentTried): boolean {
	return tried.repos.some(repo => repo.conflicts?.length);
}

/**
 * The user's edits to a repository's tried files, ready to send: the files
 * that differ from what Try last wrote (`edited`), less those still holding
 * conflict markers. Named with the repository's key in a thread with several.
 */
export function editsToSend(repo: TriedRepo, edited: readonly string[], marked: readonly string[], repositories: number): string[] {
	return edited.filter(file => !marked.includes(file)).map(file => repositories > 1 ? `${repo.key}/${file}` : file);
}

/**
 * Whether a discarded thread's folders hold anything but what Discard reset
 * them to, so Restore would replace newer work. `resets` and `now` are each
 * folder's trees; undefined where unknown, which counts as unchanged.
 */
export function foldersMoved(resets: readonly (string | undefined)[], now: readonly (string | undefined)[]): boolean {
	return resets.some((reset, i) => !!reset && !!now[i] && reset !== now[i]);
}

/**
 * How a thread card offers the work Discard Changes saved: as its main
 * button while the folder still holds what Discard left, from its ⋯ menu
 * once a later turn changed it (Restore then saves that newer work first).
 */
export function discardOffer(discarded: readonly DiscardedRepo[] | undefined): 'restore' | 'menu' | undefined {
	if (!discarded?.length) {
		return undefined;
	}
	return discarded.some(repo => repo.superseded) ? 'menu' : 'restore';
}

/** Each file a try has in a checkout, by absolute path, with the agent trying it: the files Source Control marks. */
export function triedPaths(agents: readonly AgentRecord[]): Map<string, { readonly id: string; readonly title: string }> {
	const found = new Map<string, { readonly id: string; readonly title: string }>();
	for (const record of agents) {
		if (record.tried?.state !== 'trying') {
			continue;
		}
		for (const repo of record.tried.repos) {
			for (const file of repo.files) {
				found.set(path.resolve(repo.repository, file), { id: record.id, title: record.title });
			}
		}
	}
	return found;
}

/** The keys whose values differ between `a` and `b`, added and removed ones included. */
export function changedKeys<K, V extends { readonly id: string; readonly title: string }>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): K[] {
	const changed = [...a.keys()].filter(key => b.get(key)?.id !== a.get(key)?.id || b.get(key)?.title !== a.get(key)?.title);
	return [...changed, ...[...b.keys()].filter(key => !a.has(key))];
}
