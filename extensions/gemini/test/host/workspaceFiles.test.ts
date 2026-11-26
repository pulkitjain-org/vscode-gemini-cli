/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => import('./vscodeStub'));
import { WorkspaceFileIndex } from '../../src/host/workspaceFiles';
import { Uri, workspace } from './vscodeStub';

// The @ picker's list, when the workspace index supplies it.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	workspace.workspaceFolders = [{ uri: Uri.file('/work/shop'), name: 'shop', index: 0 }];
	(workspace as { asRelativePath: (uri: unknown) => string }).asRelativePath = uri => String((uri as Uri).fsPath).replace('/work/shop/', '');
});

afterEach(() => {
	vi.useRealTimers();
	workspace.workspaceFolders = undefined;
});

/** An index whose list can be changed, and whose reads can be held back. */
function fakeIndex(files: string[]) {
	const state = { files, reads: 0, hold: undefined as Promise<void> | undefined };
	const index = new WorkspaceFileIndex(async () => {
		state.reads++;
		await state.hold;
		return state.files;
	});
	const names = async (query: string) => (await index.search(query, 10)).map(match => match.relative);
	return { state, names };
}

describe('the @ picker\'s file list from the workspace index', () => {
	it('reads the list once for a run of keystrokes', async () => {
		const { state, names } = fakeIndex(['src/cart.ts', 'src/tax.ts']);
		expect([await names('cart'), await names('tax'), state.reads]).toEqual([['src/cart.ts'], ['src/tax.ts'], 1]);
	});

	it('answers from the list in hand while an old one is read again, then from the new one', async () => {
		const { state, names } = fakeIndex(['src/cart.ts']);
		await names('cart');
		vi.setSystemTime(Date.now() + 11_000);
		state.files = ['src/cart.ts', 'src/cartTotals.ts'];
		let release = () => { };
		state.hold = new Promise(resolve => release = resolve);
		// The re-read has not come back: the keystroke is answered at once, from the old list, and a second one starts no second read.
		const during = [await names('cart'), await names('cart')];
		const reads = state.reads;
		release();
		await vi.waitFor(async () => expect(await names('cart')).toHaveLength(2));
		expect([during, reads, state.reads]).toEqual([[['src/cart.ts'], ['src/cart.ts']], 2, 2]);
	});

	it('keeps the list in hand when a re-read fails', async () => {
		const { state, names } = fakeIndex(['src/cart.ts']);
		await names('cart');
		vi.setSystemTime(Date.now() + 11_000);
		state.hold = Promise.reject(new Error('the indexer is gone'));
		state.hold.catch(() => undefined);
		const during = await names('cart');
		await vi.waitFor(() => expect(state.reads).toBe(2));
		await new Promise(resolve => setImmediate(resolve));
		expect([during, await names('cart'), state.reads]).toEqual([['src/cart.ts'], ['src/cart.ts'], 2]);
	});
});
