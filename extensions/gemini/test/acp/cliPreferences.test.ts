/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCliPreference, isCliTuning, isKeepChats, keepChatsPeriod, readCliPreferences, setCliDefaultModel, setCliPreference } from '../../src/acp/cliPreferences';
import { readSettingsFile } from '../../src/acp/projectSettings';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prefs-')); });
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe('cliPreferences', () => {
	it('reads the CLI defaults from empty settings', () => {
		expect(readCliPreferences({})).toEqual({ defaultApprovalMode: 'default', permanentApproval: false, planRouting: true, usageStatistics: true, keepChats: '30d', requestTimeoutMs: 60_000, compressionThreshold: 0.5, maxAttempts: 10, toolOutputChars: 40_000 });
	});

	it('reads set values, and forever when cleanup is off', () => {
		expect(readCliPreferences({
			security: { enablePermanentToolApproval: true },
			general: { plan: { modelRouting: false }, sessionRetention: { enabled: true, maxAge: '90d' } },
			privacy: { usageStatisticsEnabled: false },
		})).toEqual({ defaultApprovalMode: 'default', permanentApproval: true, planRouting: false, usageStatistics: false, keepChats: '90d', requestTimeoutMs: 60_000, compressionThreshold: 0.5, maxAttempts: 10, toolOutputChars: 40_000 });
		expect(readCliPreferences({ general: { sessionRetention: { enabled: false, maxAge: '7d' } } }).keepChats).toBe('forever');
	});

	it('reads the numbers the CLI is tuned by, and the CLI\'s default for one it would not take', () => {
		const read = readCliPreferences({ model: { name: 'gemini-3.8-pro', requestTimeoutMs: 180_000, compressionThreshold: 7 }, general: { maxAttempts: 3.5 }, tools: { truncateToolOutputThreshold: 20_000 } });
		expect([read.requestTimeoutMs, read.compressionThreshold, read.maxAttempts, read.toolOutputChars]).toEqual([180_000, 0.5, 10, 20_000]);
	});

	it('writes a tuned number beside its neighbours, and takes the key out again for the CLI\'s default', () => {
		const settings: Record<string, unknown> = { model: { name: 'gemini-3.8-pro' }, general: { vimMode: true } };
		applyCliPreference(settings, 'requestTimeoutMs', 180_000);
		applyCliPreference(settings, 'compressionThreshold', 0.3);
		applyCliPreference(settings, 'maxAttempts', 5);
		applyCliPreference(settings, 'toolOutputChars', 20_000);
		const tuned = JSON.parse(JSON.stringify(settings));
		applyCliPreference(settings, 'requestTimeoutMs', 60_000);
		applyCliPreference(settings, 'compressionThreshold', 0.5);
		applyCliPreference(settings, 'maxAttempts', 10);
		applyCliPreference(settings, 'toolOutputChars', 40_000);
		expect([tuned, settings]).toEqual([
			{ model: { name: 'gemini-3.8-pro', requestTimeoutMs: 180_000, compressionThreshold: 0.3 }, general: { vimMode: true, maxAttempts: 5 }, tools: { truncateToolOutputThreshold: 20_000 } },
			{ model: { name: 'gemini-3.8-pro' }, general: { vimMode: true }, tools: {} },
		]);
	});

	it('takes only numbers the CLI accepts', async () => {
		expect([
			isCliTuning('requestTimeoutMs', 120_000), isCliTuning('requestTimeoutMs', 500), isCliTuning('requestTimeoutMs', 120_000.5), isCliTuning('compressionThreshold', 0.35),
			isCliTuning('compressionThreshold', 1), isCliTuning('maxAttempts', 11), isCliTuning('maxAttempts', '5'), isCliTuning('toolOutputChars', 0),
		]).toEqual([true, false, false, true, false, false, false, false]);
		await expect(setCliPreference(path.join(dir, 'settings.json'), 'maxAttempts', 11)).rejects.toThrow(/maxAttempts/);
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

	it('reads a retention as a count and a unit', () => {
		expect(['12h', '30d', '1w', '6m', 'forever', '30', '30 days'].map(keepChatsPeriod)).toEqual([
			{ count: 12, unit: 'h' }, { count: 30, unit: 'd' }, { count: 1, unit: 'w' }, { count: 6, unit: 'm' }, undefined, undefined, undefined,
		]);
	});

	it('writes the user settings file, keeping its comments, and refuses one that is not JSON', async () => {
		const file = path.join(dir, 'settings.json');
		expect(await setCliPreference(file, 'permanentApproval', true)).toBe(true);
		expect(await readSettingsFile(file)).toEqual({ security: { enablePermanentToolApproval: true } });
		await fs.writeFile(file, '{\n  // mine\n}\n');
		expect(await setCliPreference(file, 'usageStatistics', false)).toBe(true);
		expect(await fs.readFile(file, 'utf8')).toContain('// mine');
		await fs.writeFile(file, '{\n  "a": \n}\n');
		expect(await setCliPreference(file, 'usageStatistics', false)).toBe(false);
		await expect(setCliPreference(file, 'keepChats', '1h')).rejects.toThrow();
	});

	it('sets the model the CLI starts on under model.name, keeping the rest of the model section', async () => {
		const file = path.join(dir, 'settings.json');
		await fs.writeFile(file, JSON.stringify({ model: { maxSessionTurns: 5 }, general: { vimMode: true } }));
		expect(await setCliDefaultModel(file, 'gemini-3.1-pro-preview')).toBe(true);
		expect(await readSettingsFile(file)).toEqual({ model: { maxSessionTurns: 5, name: 'gemini-3.1-pro-preview' }, general: { vimMode: true } });
	});
});
