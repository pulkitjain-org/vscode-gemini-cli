/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// The Connections page is drawn again with every view, which arrives on the
// tools' state ticks. Focus stays on the control the user had, not on the
// first button of its row; and its tooltips are the themed ones.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLElement } from 'happy-dom';
import type { ConnectionRowView, ConnectionsStrings, ConnectionsView } from '../../src/host/connectionsProtocol';
import { hostExport, page, posted, sendToPage, startScript } from './pages';

const { document } = page;

function row(tool: 'jira' | 'gitlab', name: string): ConnectionRowView {
	return { tool, name, kind: 'connected', label: 'Connected', detail: 'Signed in as ada', pills: ['Cloud'], saved: true, needsToken: true, urlFromDefaults: false, canCreateToken: true };
}

function view(): ConnectionsView {
	return { rows: [row('jira', 'Jira'), row('gitlab', 'GitLab')] };
}

beforeAll(async () => {
	const ConnectionsPage = await hostExport<{ prototype: { shell(): { strings: ConnectionsStrings } } }>('src/host/connectionsPage.ts', 'ConnectionsPage');
	const strings = ConnectionsPage.prototype.shell().strings;
	document.body.className = 'settings-page connections-page';
	document.body.innerHTML = `<main id="page" class="settings connections"></main><script type="module" data-strings='${JSON.stringify(strings).replace(/'/g, '&#39;')}'></script>`;
	let saved: unknown;
	Object.assign(globalThis, {
		acquireVsCodeApi: () => ({ postMessage: (message: { type: string }) => posted.push(message), getState: () => saved, setState: (state: unknown) => saved = state }),
	});
	await startScript('connections');
	posted.length = 0;
});

const rowButtons = (tool: string) => [...document.querySelectorAll(`.tool-row[data-tool="${tool}"] .row-actions button`)] as HTMLElement[];

describe('the Connections page', () => {
	it('keeps focus on the very control the user had when a view draws it again', () => {
		sendToPage({ type: 'view', view: view() });
		const disconnect = rowButtons('gitlab')[1];
		disconnect.focus();
		const labels = rowButtons('gitlab').map(button => button.textContent?.trim());
		sendToPage({ type: 'view', view: view() });
		const after = document.activeElement as HTMLElement | null;
		expect({ labels, redrawn: after !== disconnect, focused: after?.textContent?.trim(), row: after?.closest('.tool-row')?.getAttribute('data-tool') })
			.toEqual({ labels: ['Replace Token', 'Disconnect'], redrawn: true, focused: 'Disconnect', row: 'gitlab' });
	});

	it('gives the Connect dialog\'s close button the themed tooltip and name, never a native title', () => {
		sendToPage({ type: 'view', view: view() });
		rowButtons('jira')[0].click();
		const close = document.querySelector('.dialog-head .icon-button') as HTMLElement;
		const shown = { titled: document.querySelectorAll('[title]').length, tip: close.dataset.tip, name: close.getAttribute('aria-label') };
		close.click();
		expect({ ...shown, closed: !document.querySelector('.dialog') }).toEqual({ titled: 0, tip: 'Close', name: 'Close', closed: true });
	});
});
