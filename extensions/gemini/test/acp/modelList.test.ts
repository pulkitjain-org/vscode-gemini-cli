/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { proAccessFromQuota, terminalModelList } from '../../src/acp/modelList';

const choice = (id: string) => ({ id, name: id });
/** As gemini-cli 0.63 sends it to apps, with Flash preview twice. */
const fromCli = ['auto-gemini-3', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3-flash-preview'].map(choice);

describe('terminalModelList', () => {
	it('lists each model once, in the terminal\'s order, with Gemma last', () => {
		expect(terminalModelList(fromCli, { gemma: true }).map(c => c.id)).toEqual([
			'auto-gemini-3', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it',
		]);
	});

	it('leaves Gemma out when experimental.gemma is off, and Pro out without Pro access', () => {
		expect(terminalModelList(fromCli, { gemma: false, proAccess: false }).map(c => c.id)).toEqual([
			'auto-gemini-3', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite', 'gemini-2.5-flash',
		]);
	});

	it('reads Pro access from the quota only when there is one', () => {
		expect(proAccessFromQuota(undefined)).toBeUndefined();
		expect(proAccessFromQuota([])).toBeUndefined();
		expect(proAccessFromQuota(['gemini-2.5-flash'])).toBe(false);
		expect(proAccessFromQuota(['gemini-2.5-flash', 'gemini-3.1-pro-preview'])).toBe(true);
	});
});
