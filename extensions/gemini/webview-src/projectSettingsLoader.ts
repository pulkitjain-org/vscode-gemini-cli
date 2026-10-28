/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Project settings (projectSettings.ts), loaded the first time they open: only
// a project's chat has them, and every other chat opens without their code.

import type { ProjectRepoView, ProjectSettingsView } from '../src/host/chatProtocol';
import { button, setLabel } from './dom';
import { toneOf } from './repoTones';
import { selectMenu } from './selectMenu';
import { state, strings, vscode } from './view';

type Panel = typeof import('./projectSettings');

const url = document.querySelector<HTMLScriptElement>('script[data-strings]')?.dataset.projectSettings;
const host = { state, strings, vscode, button, setLabel, selectMenu, toneOf };
let loaded: Panel | undefined;
let loading: Promise<Panel | undefined> | undefined;

/** Opens Project settings with `view`, loading them first; while open, takes in what changed. */
export function showProjectSettings(view: ProjectSettingsView, show: boolean): void {
	if (loaded) {
		loaded.showProjectSettings(view, show, host);
		return;
	}
	// Not open yet: only a request to open them is worth loading for.
	if (!show) {
		return;
	}
	// eslint-disable-next-line no-restricted-syntax
	loading ??= url ? import(/* webpackIgnore: true */ url).then((module: Panel) => loaded = module, (err: unknown) => {
		// Not kept: opening them again tries again.
		loading = undefined;
		console.error('Project settings could not load', err);
		return undefined;
	}) : Promise.resolve(undefined);
	void loading.then(module => module?.showProjectSettings(view, show, host));
}

/** The folder Add repository picked, for the open settings. */
export function pickedRepository(repo: ProjectRepoView): void {
	loaded?.pickedRepository(repo, host);
}
