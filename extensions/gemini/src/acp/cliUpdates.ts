/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// When to tell the user about a newer Gemini CLI (plan Phase 3,
// runtime-resolution, cli-update-check). At most one registry request a day,
// made after the agent is ready; installing waits for a click.

import { CliSource, compareVersions, isVersion } from './cliResolution';

export const updateCheckInterval = 24 * 60 * 60 * 1000;

export interface UpdateCheckState {
	/** The `gemini.cli.checkForUpdates` setting. */
	readonly enabled: boolean;
	/** The `gemini.cli.version` setting; a pin, by the user or an admin, turns the check off. */
	readonly pinnedVersion: string | undefined;
	/** Where the running CLI came from; installing changes nothing when `gemini.cliPath` is set. */
	readonly source: CliSource;
	/** When the registry was last asked, in ms since the epoch. */
	readonly lastCheck: number | undefined;
	readonly now: number;
}

/** Whether to ask the registry now. */
export function shouldCheckForUpdate(state: UpdateCheckState): boolean {
	if (!state.enabled || state.pinnedVersion?.trim() || state.source === 'setting') {
		return false;
	}
	// A clock set back counts as due, so a bad timestamp cannot stop checks for good.
	return state.lastCheck === undefined || state.now - state.lastCheck >= updateCheckInterval || state.now < state.lastCheck;
}

/** The version to offer, if `latest` is a release newer than the running CLI and not one the user skipped. */
export function updateToOffer(running: string | undefined, latest: string | undefined, skipped: string | undefined): string | undefined {
	if (!running || !latest || !isVersion(running) || !isVersion(latest) || latest.includes('-') || latest === skipped) {
		return undefined;
	}
	return compareVersions(latest, running) > 0 ? latest : undefined;
}
