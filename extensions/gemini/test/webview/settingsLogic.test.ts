/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { ProjectSettingsView } from '../../src/host/chatProtocol';
import { draftOf, mergeRefresh, saveOf, threadTokens, unsavedChanges, withRepo } from '../../webview-src/settingsLogic';

const view: ProjectSettingsView = {
	name: 'acme',
	repos: [{ key: 'shop', folder: '/code/shop', label: '~/code/shop' }],
	defaults: { planFirst: false, branchPrefix: 'gemini/' },
	instructions: 'Use pnpm.',
	maxChars: 16000,
	files: [{ name: 'api.md', coordinator: true, threads: true, chars: 400 }],
	memoryFolder: '~/.geminicode/projects/p1/memory',
	repoRules: [],
	stats: { open: 1, merged: 2, added: 30, removed: 4 },
};

describe('project settings state', () => {
	it('counts each changed setting once', () => {
		let draft = draftOf(view);
		expect(unsavedChanges(view, draft)).toBe(0);
		draft = { ...draft, name: 'acme shop', instructions: 'Use pnpm. Run tests.' };
		draft = withRepo(draft, { key: 'cms', folder: '/code/cms', label: '~/code/cms' });
		draft = { ...draft, files: [], removedFiles: ['api.md'], defaults: { ...draft.defaults, planFirst: true } };
		expect(unsavedChanges(view, draft)).toBe(5);
	});

	it('adds a picked repository once, with a free name', () => {
		const draft = withRepo(withRepo(draftOf(view), { key: 'shop', folder: '/other/shop', label: '' }), { key: 'shop', folder: '/other/shop', label: '' });
		expect(draft.repos.map(repo => repo.key)).toEqual(['shop', 'shop-2']);
	});

	it('takes in a refresh without losing the user\'s edits', () => {
		const edited = { ...draftOf(view), name: 'mine', files: [{ name: 'api.md', coordinator: false, threads: true, chars: 400 }] };
		const after: ProjectSettingsView = {
			...view,
			instructions: 'Drafted by Gemini.',
			draftedAt: 9,
			files: [...view.files, { name: 'new.md', coordinator: true, threads: true }],
		};
		const merged = mergeRefresh(view, after, edited);
		expect(merged.name).toBe('mine');
		expect(merged.instructions).toBe('Drafted by Gemini.');
		expect(merged.files).toEqual([{ name: 'api.md', coordinator: false, threads: true, chars: 400 }, { name: 'new.md', coordinator: true, threads: true }]);
		const typed = mergeRefresh(view, after, { ...edited, instructions: 'My own.' });
		expect(typed.instructions).toBe('My own.');
	});

	it('saves what the popup shows, and estimates the threads\' memory', () => {
		const draft = { ...draftOf(view), name: ' acme ', defaults: { planFirst: true, branchPrefix: ' feature/ ' } };
		expect(saveOf(draft, true)).toEqual({
			name: 'acme',
			repos: [{ key: 'shop', folder: '/code/shop' }],
			defaults: { planFirst: true, branchPrefix: 'feature/' },
			instructions: 'Use pnpm.',
			files: [{ name: 'api.md', coordinator: true, threads: true }],
			removedFiles: [],
			reviewedDraft: true,
		});
		expect(threadTokens(draft)).toBe(Math.ceil((9 + 400) / 4));
	});
});
