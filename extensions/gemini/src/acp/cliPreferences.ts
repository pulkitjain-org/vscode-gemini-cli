/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A few of the Gemini CLI's own settings that GeminiCode offers on Project
// Helpers. They live in the user's ~/.gemini/settings.json, so the terminal
// CLI sees the same values. Keys and defaults mirror gemini-cli 0.63
// (`settingsSchema.ts`); a project's .gemini/settings.json can still override
// them, as in the CLI.

import { isRecord, updateSettingsFile } from './projectSettings';

/** How long the CLI keeps saved chats: a `general.sessionRetention.maxAge` such as "30d", or `forever` when cleanup is off. */
export type KeepChats = string;

export const keepChatsForever = 'forever';
/** The choices the page offers; a value set by hand is shown as well. */
export const keepChatsChoices: readonly KeepChats[] = ['7d', '30d', '90d', keepChatsForever];
/** The CLI's default retention. */
export const defaultKeepChats = '30d';

export interface CliPreferences {
	/** `security.enablePermanentToolApproval`: permission prompts offer "Allow for all future sessions". */
	readonly permanentApproval: boolean;
	/** `general.plan.modelRouting`: Plan mode plans with Pro and builds with Flash. */
	readonly planRouting: boolean;
	/** `privacy.usageStatisticsEnabled`: the CLI sends usage statistics. */
	readonly usageStatistics: boolean;
	/** `general.sessionRetention`: how long saved chats are kept. */
	readonly keepChats: KeepChats;
}

export type CliPreference = keyof CliPreferences;

function at(settings: Record<string, unknown>, ...keys: string[]): unknown {
	let value: unknown = settings;
	for (const key of keys) {
		value = isRecord(value) ? value[key] : undefined;
	}
	return value;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

/** The preferences a settings object sets, with the CLI's defaults for the rest. */
export function readCliPreferences(settings: Record<string, unknown>): CliPreferences {
	const retention = at(settings, 'general', 'sessionRetention');
	const maxAge = isRecord(retention) && typeof retention.maxAge === 'string' && retention.maxAge.trim() ? retention.maxAge.trim() : defaultKeepChats;
	return {
		permanentApproval: bool(at(settings, 'security', 'enablePermanentToolApproval'), false),
		planRouting: bool(at(settings, 'general', 'plan', 'modelRouting'), true),
		usageStatistics: bool(at(settings, 'privacy', 'usageStatisticsEnabled'), true),
		keepChats: isRecord(retention) && retention.enabled === false ? keepChatsForever : maxAge,
	};
}

/** Whether `value` is a retention the CLI accepts: a number and a unit (h, d, w or m), at least a day. */
export function isKeepChats(value: string): boolean {
	if (value === keepChatsForever) {
		return true;
	}
	const match = /^(\d+)([hdwm])$/.exec(value);
	if (!match) {
		return false;
	}
	const hours = Number(match[1]) * { h: 1, d: 24, w: 24 * 7, m: 24 * 30 }[match[2] as 'h' | 'd' | 'w' | 'm'];
	// The CLI turns cleanup off for a maxAge under its minRetention of one day.
	return hours >= 24;
}

/** Sets one preference in the settings object, leaving the keys around it alone. */
export function applyCliPreference<K extends CliPreference>(settings: Record<string, unknown>, key: K, value: CliPreferences[K]): void {
	const object = (parent: Record<string, unknown>, name: string): Record<string, unknown> => {
		const existing = parent[name];
		const child = isRecord(existing) ? existing : {};
		parent[name] = child;
		return child;
	};
	switch (key) {
		case 'permanentApproval':
			object(settings, 'security').enablePermanentToolApproval = value;
			break;
		case 'planRouting':
			object(object(settings, 'general'), 'plan').modelRouting = value;
			break;
		case 'usageStatistics':
			object(settings, 'privacy').usageStatisticsEnabled = value;
			break;
		case 'keepChats': {
			const retention = object(object(settings, 'general'), 'sessionRetention');
			if (value === keepChatsForever) {
				retention.enabled = false;
			} else {
				retention.enabled = true;
				retention.maxAge = value;
			}
			break;
		}
	}
}

/** Writes one preference to a settings file. False, leaving the file alone, when it has comments. */
export async function setCliPreference<K extends CliPreference>(file: string, key: K, value: CliPreferences[K]): Promise<boolean> {
	if (key === 'keepChats' && !isKeepChats(value as string)) {
		throw new Error(`Not a retention the Gemini CLI accepts: ${value}`);
	}
	return updateSettingsFile(file, settings => applyCliPreference(settings, key, value));
}
