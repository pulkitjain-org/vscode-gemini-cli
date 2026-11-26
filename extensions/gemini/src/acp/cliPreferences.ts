/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
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
	/** `general.defaultApprovalMode`: the mode a new session starts in; `default`, `autoEdit` or `plan` (the CLI ignores `yolo` here). GeminiCode's `gemini.agents.defaultMode` overrides it when set. */
	readonly defaultApprovalMode: string;
	/** `security.enablePermanentToolApproval`: permission prompts offer "Allow for all future sessions". */
	readonly permanentApproval: boolean;
	/** `general.plan.modelRouting`: Plan mode plans with Pro and builds with Flash. */
	readonly planRouting: boolean;
	/** `privacy.usageStatisticsEnabled`: the CLI sends usage statistics. */
	readonly usageStatistics: boolean;
	/** `general.sessionRetention`: how long saved chats are kept. */
	readonly keepChats: KeepChats;
	/** The numbers the CLI is tuned by (`cliTunings`), each the CLI's default when the settings name none it takes. */
	readonly requestTimeoutMs: number;
	readonly compressionThreshold: number;
	readonly maxAttempts: number;
	readonly toolOutputChars: number;
}

export type CliPreference = keyof CliPreferences;

/**
 * Numbers the CLI is tuned by, which GeminiCode left at the CLI's defaults
 * until they could be chosen from: the names and defaults are gemini-cli
 * 0.71's. A value equal to the default is written as no value, so a later
 * CLI's own default applies.
 * - `requestTimeoutMs` (`model.requestTimeoutMs`): how long the CLI waits for the API to start answering before it retries.
 * - `compressionThreshold` (`model.compressionThreshold`): the share of the context window at which the CLI compresses the chat.
 * - `maxAttempts` (`general.maxAttempts`): how many times a request to the model is tried; the CLI allows 10 at most.
 * - `toolOutputChars` (`tools.truncateToolOutputThreshold`): the most characters of one tool result the model is given; the rest is saved to a file it can read.
 */
export interface CliTuning {
	readonly path: readonly [string, string];
	/** The CLI's default. */
	readonly fallback: number;
	/** What the page offers; a value set by hand is shown as well. */
	readonly choices: readonly number[];
	readonly min: number;
	readonly max: number;
}

export type CliTuningKey = 'requestTimeoutMs' | 'compressionThreshold' | 'maxAttempts' | 'toolOutputChars';

export function cliTunings(): Readonly<Record<CliTuningKey, CliTuning>> {
	return {
		requestTimeoutMs: { path: ['model', 'requestTimeoutMs'], fallback: 60_000, choices: [60_000, 120_000, 180_000, 300_000, 600_000], min: 1_000, max: 3_600_000 },
		compressionThreshold: { path: ['model', 'compressionThreshold'], fallback: 0.5, choices: [0.3, 0.4, 0.5, 0.6, 0.7], min: 0.05, max: 0.95 },
		maxAttempts: { path: ['general', 'maxAttempts'], fallback: 10, choices: [3, 5, 10], min: 1, max: 10 },
		toolOutputChars: { path: ['tools', 'truncateToolOutputThreshold'], fallback: 40_000, choices: [20_000, 40_000, 80_000], min: 1_000, max: 1_000_000 },
	};
}

export function isCliTuningKey(key: string): key is CliTuningKey {
	return Object.hasOwn(cliTunings(), key);
}

/** Whether `value` is one the CLI takes for `key`. */
export function isCliTuning(key: CliTuningKey, value: unknown): value is number {
	const tuning = cliTunings()[key];
	return typeof value === 'number' && Number.isFinite(value) && value >= tuning.min && value <= tuning.max && (key === 'compressionThreshold' || Number.isInteger(value));
}

/** The modes the CLI's Default Approval Mode takes: never YOLO, which the CLI leaves out of it on purpose. */
export const defaultApprovalModes: readonly string[] = ['default', 'autoEdit', 'plan'];

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
	const defaultMode = at(settings, 'general', 'defaultApprovalMode');
	return {
		defaultApprovalMode: typeof defaultMode === 'string' && defaultApprovalModes.includes(defaultMode) ? defaultMode : 'default',
		permanentApproval: bool(at(settings, 'security', 'enablePermanentToolApproval'), false),
		planRouting: bool(at(settings, 'general', 'plan', 'modelRouting'), true),
		usageStatistics: bool(at(settings, 'privacy', 'usageStatisticsEnabled'), true),
		keepChats: isRecord(retention) && retention.enabled === false ? keepChatsForever : maxAge,
		...Object.fromEntries(Object.entries(cliTunings()).map(([key, tuning]) => {
			const value = at(settings, ...tuning.path);
			return [key, isCliTuning(key as CliTuningKey, value) ? value : tuning.fallback];
		})) as Record<CliTuningKey, number>,
	};
}

/** Whether `value` is a retention the CLI accepts: a number and a unit (h, d, w or m), at least a day. */
export function isKeepChats(value: string): boolean {
	if (value === keepChatsForever) {
		return true;
	}
	const period = keepChatsPeriod(value);
	if (!period) {
		return false;
	}
	const hours = period.count * { h: 1, d: 24, w: 24 * 7, m: 24 * 30 }[period.unit];
	// The CLI turns cleanup off for a maxAge under its minRetention of one day.
	return hours >= 24;
}

/** A retention as a number of hours, days, weeks or months; undefined for forever, or for anything but a number and a unit. */
export function keepChatsPeriod(value: KeepChats): { readonly count: number; readonly unit: 'h' | 'd' | 'w' | 'm' } | undefined {
	const match = /^(?<count>\d+)(?<unit>[hdwm])$/.exec(value);
	return match?.groups ? { count: Number(match.groups.count), unit: match.groups.unit as 'h' | 'd' | 'w' | 'm' } : undefined;
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
		case 'defaultApprovalMode':
			object(settings, 'general').defaultApprovalMode = value;
			break;
		case 'permanentApproval':
			object(settings, 'security').enablePermanentToolApproval = value;
			break;
		case 'planRouting':
			object(object(settings, 'general'), 'plan').modelRouting = value;
			break;
		case 'usageStatistics':
			object(settings, 'privacy').usageStatisticsEnabled = value;
			break;
		case 'requestTimeoutMs':
		case 'compressionThreshold':
		case 'maxAttempts':
		case 'toolOutputChars': {
			const tuning = cliTunings()[key as CliTuningKey];
			const parent = object(settings, tuning.path[0]);
			if (value === tuning.fallback) {
				delete parent[tuning.path[1]];
			} else {
				parent[tuning.path[1]] = value;
			}
			break;
		}
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

/**
 * Makes `modelId` the model the CLI starts on (`model.name` in the user
 * settings), as the terminal's /model dialog saves it. False, leaving the file
 * alone, when it isn't valid JSON.
 */
export function setCliDefaultModel(file: string, modelId: string): Promise<boolean> {
	return updateSettingsFile(file, settings => {
		const existing = settings.model;
		const model = isRecord(existing) ? existing : {};
		settings.model = model;
		model.name = modelId;
	});
}

/** Writes one preference to a settings file. False, leaving the file alone, when it isn't valid JSON (comments are kept). */
export async function setCliPreference<K extends CliPreference>(file: string, key: K, value: CliPreferences[K]): Promise<boolean> {
	if (key === 'keepChats' && !isKeepChats(value as string)) {
		throw new Error(`Not a retention the Gemini CLI accepts: ${value}`);
	}
	if (key === 'defaultApprovalMode' && !defaultApprovalModes.includes(value as string)) {
		throw new Error(`Not a default approval mode the Gemini CLI accepts: ${value}`);
	}
	if (isCliTuningKey(key) && !isCliTuning(key, value)) {
		throw new Error(`Not a value the Gemini CLI accepts for ${key}: ${value}`);
	}
	return updateSettingsFile(file, settings => applyCliPreference(settings, key, value));
}
