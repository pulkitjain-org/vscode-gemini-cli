/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { effectiveStartMode, nextApprovalMode } from '../../src/acp/chatTurns';
import { readCliPreferences } from '../../src/acp/cliPreferences';
import { cliModeList, startModeList } from '../../src/acp/sessionSettings';

const allButYolo = (id: string) => id !== 'yolo';

describe('the modes a new agent may start in', () => {
	it('are what a session offered, in its words, else the CLI\'s own list, less what policy turns off', () => {
		const offered = [{ id: 'default', name: 'Default', description: 'Prompts for approval' }, { id: 'plan', name: 'Plan', description: 'Read-only mode' }];
		expect(startModeList(offered, () => true)).toEqual(offered);
		expect(startModeList(undefined, () => true)).toEqual(cliModeList);
		expect(startModeList([], allButYolo).map(mode => mode.id)).toEqual(['default', 'autoEdit', 'plan']);
	});

	it('start in GeminiCode\'s setting when it is set, else in the CLI\'s default, never YOLO from the CLI', () => {
		expect({
			own: effectiveStartMode('autoEdit', 'plan', () => true),
			ownDefault: effectiveStartMode('default', 'plan', () => true),
			cli: effectiveStartMode(undefined, 'plan', () => true),
			cliDefault: effectiveStartMode(undefined, 'default', () => true),
			cliYolo: effectiveStartMode(undefined, 'yolo', () => true),
			denied: effectiveStartMode(undefined, 'autoEdit', () => false),
			unknown: effectiveStartMode('turbo', 'plan', () => true),
		}).toEqual({ own: 'autoEdit', ownDefault: undefined, cli: 'plan', cliDefault: undefined, cliYolo: undefined, denied: undefined, unknown: undefined });
	});

	it('read the CLI\'s default approval mode from its settings, YOLO as the CLI does: not at all', () => {
		expect(readCliPreferences({ general: { defaultApprovalMode: 'plan' } }).defaultApprovalMode).toBe('plan');
		expect(readCliPreferences({ general: { defaultApprovalMode: 'yolo' } }).defaultApprovalMode).toBe('default');
		expect(readCliPreferences({}).defaultApprovalMode).toBe('default');
	});
});

describe('Shift+Tab', () => {
	const settings = { mode: { currentId: 'default', available: cliModeList } };

	it('cycles Default, Auto Edit and Plan, never YOLO, and skips Plan while a turn runs', () => {
		expect(nextApprovalMode(settings)).toBe('autoEdit');
		expect(nextApprovalMode({ mode: { ...settings.mode, currentId: 'autoEdit' } })).toBe('plan');
		expect(nextApprovalMode({ mode: { ...settings.mode, currentId: 'autoEdit' } }, true)).toBe('default');
		expect(nextApprovalMode({ mode: { ...settings.mode, currentId: 'plan' } })).toBe('default');
		expect(nextApprovalMode({ mode: { ...settings.mode, currentId: 'yolo' } })).toBe('plan');
	});
});
