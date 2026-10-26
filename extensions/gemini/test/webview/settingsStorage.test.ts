/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// Project Helpers' Storage section: its rows, Clean Up and the logs' menu,
// and sizes asked for only once the section is in view.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLElement } from 'happy-dom';
import type { FromSettingsPage, SettingsPageStrings, StorageView } from '../../src/host/panelProtocol';
import { page, startScript } from './pages';

type StorageSection = (view: StorageView, strings: Partial<SettingsPageStrings>, post: (message: FromSettingsPage) => void) => HTMLElement;

const strings: Partial<SettingsPageStrings> = { storage: 'Storage', storageHint: 'What GeminiCode keeps on this Mac.', storageMeasuring: 'Measuring…', keepLogs: 'Keep logs for' };
const keepLogs = { value: '90', choices: [{ value: '30', label: 'Keep for 30 days' }, { value: '90', label: 'Keep for 90 days (default)' }, { value: '0', label: 'Keep everything' }] };
const rows: StorageView['rows'] = [
	{ id: 'worktrees', label: 'Agent worktrees', detail: '12 folders in ~/.geminicode/worktrees · 4 belong to merged or removed agents', size: '2.3 GB' },
	{ id: 'index', label: 'Workspace indexes', detail: '3 folders · unused ones are deleted after 30 days', size: '412 MB', action: { kind: 'showIndex', label: 'Show' } },
	{ id: 'logs', label: 'Logs and audit records', detail: 'The audit log', size: '1.2 MB', action: { kind: 'openFolder', label: 'Open Folder' } },
];

let storageSection: StorageSection;
/** What IntersectionObserver was asked to watch, with its callback. */
const observers: { readonly callback: (entries: { isIntersecting: boolean }[]) => void; watched: unknown[]; disconnected: boolean }[] = [];

beforeAll(async () => {
	Object.assign(globalThis, {
		IntersectionObserver: class {
			private readonly entry: (typeof observers)[number];
			constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
				this.entry = { callback, watched: [], disconnected: false };
				observers.push(this.entry);
			}
			observe(node: unknown) {
				this.entry.watched.push(node);
			}
			disconnect() {
				this.entry.disconnected = true;
			}
		},
	});
	storageSection = (await startScript('settingsStorage')).storageSection as StorageSection;
});

function buttonNamed(root: HTMLElement, text: string): HTMLElement | undefined {
	return [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === text) as HTMLElement | undefined;
}

describe('the Storage section', () => {
	it('asks for the sizes only once it scrolls into view', () => {
		const sent: FromSettingsPage[] = [];
		const node = storageSection({ state: 'waiting', rows: rows.map(row => ({ ...row, detail: '', size: '' })), keepLogs }, strings, message => sent.push(message));
		page.document.body.append(node);
		const before = [...sent];
		observers.at(-1)!.callback([{ isIntersecting: true }]);
		expect({ before, after: sent, measuring: node.textContent?.includes('Measuring…'), disconnected: observers.at(-1)!.disconnected }).toEqual({ before: [], after: [{ type: 'measureStorage' }], measuring: true, disconnected: true });
	});

	it('shows each area with its size, and sends Clean Up, Show, Open Folder and the days kept', () => {
		const sent: FromSettingsPage[] = [];
		const watching = observers.length;
		const node = storageSection({ state: 'ready', rows, cleanup: 'Clean Up 4...', keepLogs }, strings, message => sent.push(message));
		buttonNamed(node, 'Clean Up 4...')?.click();
		buttonNamed(node, 'Show')?.click();
		buttonNamed(node, 'Open Folder')?.click();
		const select = node.querySelector('select')!;
		select.value = '30';
		select.dispatchEvent(new page.Event('change'));
		expect({
			sizes: [...node.querySelectorAll('.storage-size')].map(size => size.textContent),
			detail: node.querySelector('.storage-worktrees .row-detail')?.textContent,
			sent,
			watching: observers.length - watching,
		}).toEqual({
			sizes: ['2.3 GB', '412 MB', '1.2 MB'],
			detail: rows[0].detail,
			sent: [{ type: 'cleanUp' }, { type: 'storageAction', action: 'showIndex' }, { type: 'storageAction', action: 'openFolder' }, { type: 'setKeepLogs', days: '30' }],
			watching: 0,
		});
	});
});
