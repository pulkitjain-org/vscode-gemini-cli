/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCliPreference, isKeepChats, readCliPreferences, setCliPreference } from '../../src/acp/cliPreferences';
import { readSettingsFile } from '../../src/acp/projectSettings';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prefs-')); });
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe('cliPreferences', () => {
	it('reads the CLI defaults from empty settings', () => {
		expect(readCliPreferences({})).toEqual({ permanentApproval: false, planRouting: true, usageStatistics: true, keepChats: '30d' });
	});

	it('reads set values, and forever when cleanup is off', () => {
		expect(readCliPreferences({
			security: { enablePermanentToolApproval: true },
			general: { plan: { modelRouting: false }, sessionRetention: { enabled: true, maxAge: '90d' } },
			privacy: { usageStatisticsEnabled: false },
		})).toEqual({ permanentApproval: true, planRouting: false, usageStatistics: false, keepChats: '90d' });
		expect(readCliPreferences({ general: { sessionRetention: { enabled: false, maxAge: '7d' } } }).keepChats).toBe('forever');
	});

	it('sets one key and keeps its neighbours', () => {
		const settings: Record<string, unknown> = { general: { vimMode: true, sessionRetention: { maxCount: 50 } } };
		applyCliPreference(settings, 'keepChats', '7d');
		applyCliPreference(settings, 'planRouting', false);
		expect(settings).toEqual({ general: { vimMode: true, sessionRetention: { maxCount: 50, enabled: true, maxAge: '7d' }, plan: { modelRouting: false } } });
		applyCliPreference(settings, 'keepChats', 'forever');
		expect((settings.general as { sessionRetention: unknown }).sessionRetention).toEqual({ maxCount: 50, enabled: false, maxAge: '7d' });
	});

	it('accepts only retentions the CLI keeps', () => {
		expect(['1d', '30d', '2w', '6m', '24h', 'forever'].every(isKeepChats)).toBe(true);
		expect(['12h', '30', 'd', '0d', '30 days'].some(isKeepChats)).toBe(false);
	});

	it('writes the user settings file and refuses one with comments', async () => {
		const file = path.join(dir, 'settings.json');
		expect(await setCliPreference(file, 'permanentApproval', true)).toBe(true);
		expect(await readSettingsFile(file)).toEqual({ security: { enablePermanentToolApproval: true } });
		await fs.writeFile(file, '{\n  // mine\n}\n');
		expect(await setCliPreference(file, 'usageStatistics', false)).toBe(false);
		await expect(setCliPreference(file, 'keepChats', '1h')).rejects.toThrow();
	});
});
