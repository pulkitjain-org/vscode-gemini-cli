/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { proAccessFromQuota, terminalModelList } from '../../src/acp/modelList';

const choice = (id: string) => ({ id, name: id });
const ids = (list: readonly { id: string }[]) => list.map(c => c.id);
/** As gemini-cli 0.63 sends it on Google sign-in with the latest Flash: the preview Flash and the default Flash are the same model. */
const googleSignIn = ['auto', 'gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-2.5-pro', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'].map(choice);
/** As gemini-cli 0.63 sends it with an API key (realAgentModels.test.ts checks this against the CLI). */
const apiKey = ['auto', 'gemini-3.1-pro-preview-customtools', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'].map(choice);

describe('terminalModelList', () => {
	it('matches the terminal on Google sign-in: the preview Flash keeps its place, once', () => {
		expect(ids(terminalModelList(googleSignIn, { gemma: true }))).toEqual([
			'auto', 'gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-2.5-pro', 'gemini-3.1-flash-lite', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it',
		]);
	});

	it('matches the terminal with an API key: Flash-Lite before Flash', () => {
		expect(ids(terminalModelList(apiKey, { gemma: true }))).toEqual([
			'auto', 'gemini-3.1-pro-preview-customtools', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it',
		]);
	});

	it('matches the terminal without preview access', () => {
		const list = ['auto', 'gemini-2.5-pro', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'].map(choice);
		expect(ids(terminalModelList(list, { gemma: true }))).toEqual(['auto', 'gemini-2.5-pro', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it']);
	});

	it('leaves Gemma out when experimental.gemma is off, and Pro out without Pro access', () => {
		expect(ids(terminalModelList(googleSignIn, { gemma: false, proAccess: false }))).toEqual(['auto', 'gemini-3.8-flash', 'gemini-3.1-flash-lite']);
	});

	it('keeps a dynamic model list as the CLI sends it, apart from Pro', () => {
		const list = [{ id: 'auto', name: 'Auto', tier: 'auto' }, { id: 'gemini-3.1-pro-preview', name: 'Pro', tier: 'pro' }, { id: 'gemini-3.8-flash', name: 'Flash', tier: 'flash' }, { id: 'gemini-3.1-flash-lite', name: 'Lite', tier: 'flash-lite' }];
		expect(ids(terminalModelList(list, { gemma: true }))).toEqual(['auto', 'gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-3.1-flash-lite']);
		expect(ids(terminalModelList(list, { gemma: true, proAccess: false }))).toEqual(['auto', 'gemini-3.8-flash', 'gemini-3.1-flash-lite']);
	});

	it('reads Pro access from the quota only when there is one', () => {
		expect(proAccessFromQuota(undefined)).toBeUndefined();
		expect(proAccessFromQuota([])).toBeUndefined();
		expect(proAccessFromQuota(['gemini-2.5-flash'])).toBe(false);
		expect(proAccessFromQuota(['gemini-2.5-flash', 'gemini-3.1-pro-preview'])).toBe(true);
	});
});
