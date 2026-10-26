/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// A team flow's page is drawn again whenever its state changes. Someone
// typing in it keeps their place: focus, caret and selection.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLInputElement, HTMLTextAreaElement } from 'happy-dom';
import type { OpenMrView } from '../../src/host/teamFlowProtocol';
import { page, sendToPage, showTeamFlowPage, startScript } from './pages';

const { document } = page;

const openMr: OpenMrView = {
	kind: 'openMr', project: 'shop/web', source: 'fix-cart', host: 'gitlab.example.com', account: 'ada',
	targets: [{ branch: 'main', release: false, suggested: true, usual: true }], target: 'main', moreTargets: false,
	title: 'Fix cart', description: '', descriptionRev: 0, generating: true,
	attachments: [], reviewers: [], members: [], updateJira: false, deleteBranch: true, draft: false,
};

const field = (key: string) => document.querySelector(`[data-focus-key="${key}"]`) as HTMLInputElement | HTMLTextAreaElement;

beforeAll(async () => {
	await showTeamFlowPage();
	await startScript('teamFlow');
});

describe('a team flow\'s page', () => {
	it('keeps focus and the selection in the title while the generated description arrives', () => {
		sendToPage({ type: 'state', state: { view: openMr } });
		const title = field('title') as HTMLInputElement;
		title.focus();
		title.value = 'Fix the cart total';
		title.dispatchEvent(new page.Event('input'));
		title.setSelectionRange(4, 8);
		sendToPage({ type: 'state', state: { view: { ...openMr, generating: false, description: 'Fixes the total.', descriptionRev: 1 } } });
		const drawn = field('title') as HTMLInputElement;
		expect({
			redrawn: drawn !== title,
			focused: document.activeElement === drawn,
			value: drawn.value,
			selection: [drawn.selectionStart, drawn.selectionEnd],
			description: field('description').value,
		}).toEqual({ redrawn: true, focused: true, value: 'Fix the cart total', selection: [4, 8], description: 'Fixes the total.' });
	});
});
