/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Renamed settings (ADR 0008): the old key keeps working for a release of
// deprecation, so nothing a user set is lost. The new key wins where both are
// set at the same level; a more specific level wins over a less specific one,
// as VS Code merges a single key.

/** The levels of `WorkspaceConfiguration.inspect` an alias reads, most specific first. */
export interface SettingLevels<T> {
	readonly workspaceFolderValue?: T;
	readonly workspaceValue?: T;
	readonly globalValue?: T;
}

const levels = ['workspaceFolderValue', 'workspaceValue', 'globalValue'] as const;

/** A renamed setting's value: the new key's or the old key's, level by level, else `fallback`. */
export function aliasedSetting<T>(current: SettingLevels<T> | undefined, old: SettingLevels<T> | undefined, fallback: T): T {
	for (const level of levels) {
		const value = current?.[level] ?? old?.[level];
		if (value !== undefined) {
			return value;
		}
	}
	return fallback;
}
