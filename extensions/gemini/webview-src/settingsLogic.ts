/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Project settings' state, apart from the DOM: the user's unsaved edits, how
// many there are, and how a refresh from the extension (a finished draft, an
// added file) joins them without losing any.

import type { ProjectDefaultsView, ProjectRepoView, ProjectSettingsSave, ProjectSettingsView } from '../src/host/chatProtocol';

type FileView = ProjectSettingsView['files'][number];

/** What the popup shows, edits included. */
export interface SettingsDraft {
	readonly name: string;
	readonly repos: readonly ProjectRepoView[];
	readonly defaults: ProjectDefaultsView;
	readonly instructions: string;
	readonly files: readonly FileView[];
	/** Context files the user removed; deleted on Save. */
	readonly removedFiles: readonly string[];
}

export function draftOf(view: ProjectSettingsView): SettingsDraft {
	return { name: view.name, repos: view.repos, defaults: view.defaults, instructions: view.instructions, files: view.files, removedFiles: [] };
}

/** How many settings differ from what is saved: each field, repository list and file counts once. */
export function unsavedChanges(view: ProjectSettingsView, draft: SettingsDraft): number {
	let count = 0;
	count += Number(draft.name.trim() !== view.name);
	count += Number(!sameRepos(draft.repos, view.repos));
	count += Number((draft.defaults.threadModel ?? '') !== (view.defaults.threadModel ?? ''));
	count += Number(draft.defaults.planFirst !== view.defaults.planFirst);
	count += Number(draft.defaults.branchPrefix.trim() !== view.defaults.branchPrefix);
	count += Number(draft.instructions !== view.instructions);
	for (const file of view.files) {
		const edited = draft.files.find(each => each.name === file.name);
		count += Number(draft.removedFiles.includes(file.name) || !!edited && (edited.coordinator !== file.coordinator || edited.threads !== file.threads));
	}
	return count;
}

/**
 * The popup's state after the extension sent `after` in place of `before`:
 * what the user left as it was takes the new value, and their edits stay.
 */
export function mergeRefresh(before: ProjectSettingsView, after: ProjectSettingsView, draft: SettingsDraft): SettingsDraft {
	const files = after.files.filter(file => !draft.removedFiles.includes(file.name)).map(file => {
		const was = before.files.find(each => each.name === file.name);
		const edited = draft.files.find(each => each.name === file.name);
		return was && edited && (edited.coordinator !== was.coordinator || edited.threads !== was.threads)
			? { ...file, coordinator: edited.coordinator, threads: edited.threads }
			: file;
	});
	return {
		name: draft.name === before.name ? after.name : draft.name,
		repos: sameRepos(draft.repos, before.repos) ? after.repos : draft.repos,
		defaults: sameDefaults(draft.defaults, before.defaults) ? after.defaults : draft.defaults,
		instructions: draft.instructions === before.instructions ? after.instructions : draft.instructions,
		files,
		removedFiles: draft.removedFiles.filter(name => after.files.some(file => file.name === name)),
	};
}

/** Adds a picked repository, once; a name already in the list gets a number. */
export function withRepo(draft: SettingsDraft, repo: ProjectRepoView): SettingsDraft {
	if (draft.repos.some(each => each.folder === repo.folder)) {
		return draft;
	}
	let key = repo.key;
	for (let n = 2; draft.repos.some(each => each.key === key); n++) {
		key = `${repo.key}-${n}`;
	}
	return { ...draft, repos: [...draft.repos, { ...repo, key }] };
}

export function saveOf(draft: SettingsDraft, reviewedDraft: boolean): ProjectSettingsSave {
	return {
		name: draft.name.trim(),
		repos: draft.repos.map(repo => ({ key: repo.key, folder: repo.folder })),
		defaults: { ...draft.defaults, branchPrefix: draft.defaults.branchPrefix.trim() },
		instructions: draft.instructions,
		files: draft.files.map(file => ({ name: file.name, coordinator: file.coordinator, threads: file.threads })),
		removedFiles: draft.removedFiles,
		...(reviewedDraft ? { reviewedDraft } : {}),
	};
}

/** About how many tokens the memory adds to each thread's first request, at four characters a token. */
export function threadTokens(draft: SettingsDraft): number {
	const chars = draft.instructions.trim().length + draft.files.filter(file => file.threads).reduce((sum, file) => sum + (file.chars ?? 0), 0);
	return Math.ceil(chars / 4);
}

function sameRepos(a: readonly ProjectRepoView[], b: readonly ProjectRepoView[]): boolean {
	return a.length === b.length && a.every((repo, i) => repo.folder === b[i].folder && repo.key === b[i].key);
}

function sameDefaults(a: ProjectDefaultsView, b: ProjectDefaultsView): boolean {
	return (a.threadModel ?? '') === (b.threadModel ?? '') && a.planFirst === b.planFirst && a.branchPrefix === b.branchPrefix;
}
