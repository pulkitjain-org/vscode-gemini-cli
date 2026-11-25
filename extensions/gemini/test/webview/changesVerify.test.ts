/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// The Changes panel's Verify card: the repository's checks on the agent's
// work, with the host's words and buttons that post what they ask for.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLElement, HTMLInputElement } from 'happy-dom';
import type { ChangesPanelView, VerifyView } from '../../src/host/panelProtocol';
import { page, posted, sendToPage, showChangesPage, startScript } from './pages';

const { document } = page;

const goal = { label: 'Keep going until checks pass', tip: 'After each turn', on: false };
const failed: VerifyView = {
	state: 'failed', text: 'Checks failed: npm test (exit code 1)', detail: 'This is an earlier version: the agent changed files since.',
	actions: [{ id: 'send', label: 'Send Failures to Agent' }, { id: 'run', label: 'Run Again' }, { id: 'output', label: 'Show Output' }], goal,
};
const view = (verify?: VerifyView): ChangesPanelView => ({ agent: { title: 'Agent', busy: false, canCommit: true }, totals: { files: 0, added: 0, removed: 0 }, files: [], ...verify ? { verify } : {} });
const card = () => document.querySelector('.verify-card') as HTMLElement | null;

beforeAll(async () => {
	await showChangesPage();
	await startScript('changes');
});

describe('the Changes panel\'s Verify card', () => {
	it('is not there for an agent whose repository names no checks', () => {
		sendToPage({ type: 'view', view: view() });
		expect(card()).toBeNull();
	});

	it('shows the result, why it may be out of date, and the buttons the host names, even with no changed files', () => {
		sendToPage({ type: 'view', view: view(failed) });
		const shown = card()!;
		expect({
			state: shown.classList.contains('failed'), text: shown.querySelector('.verify-text')!.textContent, detail: shown.querySelector('.verify-detail')!.textContent,
			buttons: ([...shown.querySelectorAll('button')] as HTMLElement[]).map(button => [button.textContent!.trim(), button.classList.contains('primary')]),
			goal: [shown.querySelector('.verify-goal')!.textContent, (shown.querySelector('.verify-goal input') as unknown as HTMLInputElement).checked],
		}).toEqual({
			state: true, text: 'Checks failed: npm test (exit code 1)', detail: 'This is an earlier version: the agent changed files since.',
			buttons: [['Send Failures to Agent', true], ['Run Again', false], ['Show Output', false]],
			goal: ['Keep going until checks pass', false],
		});
	});

	it('posts what each button asks for, and the goal\'s switch', () => {
		sendToPage({ type: 'view', view: view(failed) });
		posted.length = 0;
		for (const button of [...card()!.querySelectorAll('button')] as HTMLElement[]) {
			button.click();
		}
		(card()!.querySelector('.verify-goal input') as HTMLElement).dispatchEvent(new page.Event('change') as never);
		expect(posted).toEqual([{ type: 'verify', action: 'send' }, { type: 'verify', action: 'run' }, { type: 'verify', action: 'output' }, { type: 'verify', action: 'goal' }]);
	});

	it('shows a run in progress with Stop, and the goal on', () => {
		sendToPage({ type: 'view', view: view({ state: 'running', text: 'Running checks: npm test', actions: [{ id: 'stop', label: 'Stop' }], goal: { ...goal, on: true } }) });
		const shown = card()!;
		expect([shown.classList.contains('running'), shown.querySelector('.verify-detail'), shown.querySelector('button')!.textContent!.trim(), (shown.querySelector('.verify-goal input') as unknown as HTMLInputElement).checked]).toEqual([true, null, 'Stop', true]);
	});
});
