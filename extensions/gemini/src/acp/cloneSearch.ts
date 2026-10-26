/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Finding the local clone of a GitLab project that a merge request's review
// or fix checks its branch out from. Looked for in order, stopping at the
// first clone: the one remembered for the project, the window's folders, the
// folders agents have used, then VS Code's recent folders. What is found is
// remembered; a remembered folder that is no longer a clone is forgotten.

import { comparablePath } from './fsUtil';
import { isInside } from './fileAccess';

/** A clone of the project, and the remote that points at it on GitLab. */
export interface FoundClone {
	readonly folder: string;
	readonly remote: string;
}

/** What `folder` is a clone of on GitLab, if anything (`gitlabProjectOf`). */
export type CloneProbe = (folder: string) => Promise<{ readonly project?: string; readonly remote?: string } | undefined>;

/** Folders to look in, read only when the ones before held no clone. */
export type CloneStage = () => readonly string[] | Promise<readonly string[]>;

/** Folders checked at once: each check runs two git commands. */
const batchSize = 8;

/** How many of VS Code's recent folders are checked. */
export const recentFoldersLimit = 30;

/** The state the remembered clones live in (the extension's globalState). */
export interface CloneMemento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

const clonesKey = 'gemini.team.clones';

/** The clone remembered for each project of a GitLab, keyed by GitLab and project. */
export class RememberedClones {

	constructor(private readonly state: CloneMemento | undefined, private readonly gitlabUrl: string) { }

	get(project: string): string | undefined {
		return this.state?.get<Record<string, string>>(clonesKey)?.[this.key(project)];
	}

	/** Remembers `folder` for `project`, or forgets the project's clone when undefined. */
	async set(project: string, folder: string | undefined): Promise<void> {
		if (!this.state) {
			return;
		}
		const { [this.key(project)]: _old, ...others } = this.state.get<Record<string, string>>(clonesKey) ?? {};
		await this.state.update(clonesKey, folder ? { ...others, [this.key(project)]: folder } : others);
	}

	private key(project: string): string {
		return `${this.gitlabUrl.replace(/\/+$/, '').toLowerCase()} ${project.toLowerCase()}`;
	}
}

/**
 * The first clone of `project` in `stages`, checked in order, a few folders
 * at once. A folder is checked once however many stages list it; folders
 * inside `skip` (GeminiCode's own worktrees and checkouts) never are.
 */
export async function findClone(project: string, stages: readonly CloneStage[], probe: CloneProbe, skip?: string): Promise<FoundClone | undefined> {
	const wanted = project.toLowerCase();
	const seen = new Set<string>();
	for (const stage of stages) {
		const listed = await Promise.resolve().then(stage).catch(() => [] as readonly string[]);
		const folders = listed.filter(folder => {
			const key = comparablePath(folder);
			const fresh = !seen.has(key) && !(skip && isInside(skip, folder));
			seen.add(key);
			return fresh;
		});
		for (let start = 0; start < folders.length; start += batchSize) {
			const batch = folders.slice(start, start + batchSize);
			const found = await Promise.all(batch.map(folder => probe(folder).catch(() => undefined)));
			const at = found.findIndex(local => local?.project?.toLowerCase() === wanted);
			if (at >= 0) {
				return { folder: batch[at], remote: found[at]?.remote ?? 'origin' };
			}
		}
	}
	return undefined;
}

/**
 * The clone of `project`: the remembered one first, then `stages`. Remembers
 * what is found, and forgets a remembered folder that is no longer a clone.
 */
export async function locateClone(project: string, memory: RememberedClones, stages: readonly CloneStage[], probe: CloneProbe, skip?: string): Promise<FoundClone | undefined> {
	const remembered = memory.get(project);
	const found = await findClone(project, [() => remembered ? [remembered] : [], ...stages], probe, skip);
	if (found?.folder !== remembered) {
		await memory.set(project, found?.folder);
	}
	return found;
}

/**
 * The local folders of VS Code's recently opened list
 * (`_workbench.getRecentlyOpened`: `{ workspaces: [{ folderUri? }] }`),
 * most recent first, at most `limit`. Workspace files and remote folders are
 * left out.
 */
export function recentFolders(recent: unknown, limit = recentFoldersLimit): string[] {
	const workspaces = (recent as { readonly workspaces?: unknown } | undefined)?.workspaces;
	const folders: string[] = [];
	for (const entry of Array.isArray(workspaces) ? workspaces : []) {
		const uri = (entry as { readonly folderUri?: { readonly scheme?: unknown; readonly fsPath?: unknown; readonly path?: unknown } } | undefined)?.folderUri;
		const folder = uri?.scheme === 'file' ? (typeof uri.fsPath === 'string' ? uri.fsPath : uri.path) : undefined;
		if (typeof folder === 'string' && folder) {
			folders.push(folder);
		}
		if (folders.length >= limit) {
			break;
		}
	}
	return folders;
}
