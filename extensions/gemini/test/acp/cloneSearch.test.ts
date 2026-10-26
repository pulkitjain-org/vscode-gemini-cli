/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { type CloneMemento, findClone, locateClone, recentFolders, RememberedClones } from '../../src/acp/cloneSearch';

/** A globalState in memory. */
function memento(initial: Record<string, unknown> = {}): CloneMemento & { readonly values: Record<string, unknown> } {
	const values = { ...initial };
	return {
		values,
		get: <T>(key: string) => values[key] as T | undefined,
		update: async (key: string, value: unknown) => {
			values[key] = value;
		},
	};
}

/** Clones by folder; records which folders were checked. */
function probeOf(clones: Record<string, string>) {
	const checked: string[] = [];
	const probe = async (folder: string) => {
		checked.push(folder);
		if (folder === '/broken') {
			throw new Error('not a repository');
		}
		return clones[folder] ? { project: clones[folder], remote: 'upstream' } : {};
	};
	return { probe, checked };
}

const gitlab = 'https://gitlab.example.com/';

describe('finding the clone a review checks out from', () => {
	it('looks in order and stops at the first clone, checking each folder once, never GeminiCode\'s own', async () => {
		const { probe, checked } = probeOf({ '/work/shop': 'Team/Shop', '/later/shop': 'team/shop' });
		let recentRead = false;
		const found = await findClone('team/shop', [
			() => ['/work/web', '/broken'],
			async () => ['/work/web', '/home/.geminicode/worktrees/shop/x', '/work/shop', '/work/api'],
			async () => {
				recentRead = true;
				return ['/later/shop'];
			},
		], probe, '/home/.geminicode');
		expect({ found, checked: checked.sort(), recentRead }).toEqual({
			found: { folder: '/work/shop', remote: 'upstream' },
			// The second stage's folders are checked together, so /work/api is too.
			checked: ['/broken', '/work/api', '/work/shop', '/work/web'],
			recentRead: false,
		});
	});

	it('remembers what it finds, uses the remembered clone first, and forgets one that no longer matches', async () => {
		const state = memento();
		const memory = new RememberedClones(state, gitlab);
		const first = probeOf({ '/recent/shop': 'team/shop' });
		const found = await locateClone('team/shop', memory, [() => ['/work/web'], async () => ['/recent/shop']], first.probe);
		const second = probeOf({ '/recent/shop': 'team/shop' });
		const again = await locateClone('Team/Shop', memory, [() => ['/work/web']], second.probe);
		const gone = probeOf({});
		const missing = await locateClone('team/shop', memory, [() => ['/work/web']], gone.probe);
		expect({ found, again, secondChecked: second.checked, missing, state: state.values }).toEqual({
			found: { folder: '/recent/shop', remote: 'upstream' },
			again: { folder: '/recent/shop', remote: 'upstream' },
			secondChecked: ['/recent/shop'],
			missing: undefined,
			state: { 'gemini.team.clones': {} },
		});
	});

	it('keeps each GitLab\'s clones apart', async () => {
		const state = memento();
		await new RememberedClones(state, gitlab).set('team/shop', '/a');
		await new RememberedClones(state, 'https://other.example.com').set('team/shop', '/b');
		expect([new RememberedClones(state, 'https://GitLab.example.com').get('TEAM/shop'), new RememberedClones(state, 'https://other.example.com').get('team/shop')]).toEqual(['/a', '/b']);
	});
});

describe('VS Code\'s recent folders', () => {
	it('lists local folders, most recent first, up to the limit, leaving out workspace files and remote folders', () => {
		const recent = {
			workspaces: [
				{ folderUri: { scheme: 'file', fsPath: '/work/shop', path: '/work/shop' } },
				{ workspace: { configPath: { scheme: 'file', path: '/work/all.code-workspace' } } },
				{ folderUri: { scheme: 'vscode-remote', path: '/srv/shop' } },
				{ folderUri: { $mid: 1, scheme: 'file', path: '/work/web' } },
				{ folderUri: { scheme: 'file', fsPath: '/work/api' } },
			],
			files: [{ fileUri: { scheme: 'file', path: '/work/notes.md' } }],
		};
		expect({ all: recentFolders(recent), two: recentFolders(recent, 2), none: [recentFolders(undefined), recentFolders({ workspaces: 'x' })] }).toEqual({
			all: ['/work/shop', '/work/web', '/work/api'],
			two: ['/work/shop', '/work/web'],
			none: [[], []],
		});
	});
});
