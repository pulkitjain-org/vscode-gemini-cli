/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// Enhance's pill follows the end of the draft. The draft is copied into the
// mirror and measured only when it, or the input's width, changed; the text
// styles and line height are read once.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { HTMLElement, HTMLTextAreaElement } from 'happy-dom';
import { page, sendToPage, showChatPage, startScript } from './pages';

const { document } = page;
let updateSendState: () => void;

beforeAll(async () => {
	await showChatPage();
	await startScript('chat');
	updateSendState = (await startScript('inputBox')).updateSendState as typeof updateSendState;
	sendToPage({ type: 'reset', items: [], busy: false, status: { phase: 'ready', text: '' }, settings: {} });
});

const frame = () => new Promise<void>(resolve => page.requestAnimationFrame(() => resolve()));

describe('Enhance\'s pill', () => {
	it('copies and measures the draft once per change of text, not once per keystroke event, and reads the styles once', async () => {
		const input = document.getElementById('input') as unknown as HTMLTextAreaElement;
		const mirror = document.querySelector('.input-mirror') as HTMLElement;
		const copies = vi.spyOn(mirror, 'replaceChildren');
		const styles = vi.spyOn(globalThis as unknown as { getComputedStyle: typeof page.getComputedStyle }, 'getComputedStyle');
		input.value = 'Fix the cart total';
		updateSendState();
		await frame();
		const first = { copies: copies.mock.calls.length, styles: styles.mock.calls.length };
		for (let i = 0; i < 5; i++) {
			updateSendState();
			await frame();
		}
		const same = { copies: copies.mock.calls.length, styles: styles.mock.calls.length };
		input.value = 'Fix the cart total and the tax';
		updateSendState();
		await frame();
		const changed = { copies: copies.mock.calls.length, styles: styles.mock.calls.length, mirror: mirror.textContent };
		copies.mockRestore();
		styles.mockRestore();
		expect({ first, same, changed }).toEqual({
			first: { copies: 1, styles: 1 },
			same: { copies: 1, styles: 1 },
			changed: { copies: 2, styles: 1, mirror: 'Fix the cart total and the tax\u200b' },
		});
	});
});
