/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// The Changes panel's folding: a new file's lines are all additions, so it
// starts folded; an edited file starts open; the user's pick is kept.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLElement } from 'happy-dom';
import type { ChangedFileView, ChangesPanelView } from '../../src/host/panelProtocol';
import { page, sendToPage, showChangesPage, startScript } from './pages';

const { document } = page;

function file(name: string, created: boolean): ChangedFileView {
	return { path: `/work/shop/${name}`, name, dir: '', created, added: 3, removed: created ? 0 : 1, hunks: [] };
}

const view: ChangesPanelView = {
	agent: { title: 'Agent', busy: false, canCommit: true },
	totals: { files: 2, added: 6, removed: 1 },
	files: [file('review_report.md', true), file('cart.ts', false)],
};

/** Each file's name and whether its lines are folded away. */
function shown(): [string, boolean][] {
	return ([...document.querySelectorAll('section.file')] as HTMLElement[]).map(section => [section.querySelector('.name')!.textContent!, section.classList.contains('folded')]);
}

function header(name: string): HTMLElement {
	return ([...document.querySelectorAll('section.file')] as HTMLElement[]).find(section => section.querySelector('.name')!.textContent === name)!.querySelector('.file-header') as HTMLElement;
}

beforeAll(async () => {
	await showChangesPage();
	await startScript('changes');
});

describe('Changes panel folding', () => {
	it('starts a new file folded and an edited one open, then keeps what the user picked across updates', () => {
		sendToPage({ type: 'view', view });
		const first = shown();
		header('review_report.md').click();
		header('cart.ts').click();
		sendToPage({ type: 'view', view });
		expect({ first, picked: shown() }).toEqual({
			first: [['review_report.md', true], ['cart.ts', false]],
			picked: [['review_report.md', false], ['cart.ts', true]],
		});
	});
});
