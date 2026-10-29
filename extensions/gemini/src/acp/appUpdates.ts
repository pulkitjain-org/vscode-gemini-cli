/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// When to tell the user about a newer GeminiCode. The download page publishes
// `latest.json` next to itself (gemini/site/build.mts); GeminiCode reads it
// every few hours, or when the user asks, and only links to the page. It
// downloads nothing itself.

import { compareVersions, isVersion } from './cliResolution';

/** How long after a successful read `latest.json` is read again. */
export const appUpdateCheckInterval = 6 * 60 * 60 * 1000;

export interface AppUpdateCheckState {
	/** The `gemini.app.checkForUpdates` setting, which an admin can lock. */
	readonly enabled: boolean;
	/** GeminiCode's own version, stamped into product.json by a release build; a dev build has none. */
	readonly currentVersion: string | undefined;
	/** Where the download page lives, from product.json. */
	readonly downloadPageUrl: string | undefined;
	/** When `latest.json` was last read successfully, in ms since the epoch. */
	readonly lastCheck: number | undefined;
	readonly now: number;
}

/** Whether to read `latest.json` now. */
export function shouldCheckForAppUpdate(state: AppUpdateCheckState): boolean {
	if (!state.enabled || !state.currentVersion || !isVersion(state.currentVersion) || !state.downloadPageUrl) {
		return false;
	}
	// A clock set back counts as due, so a bad timestamp cannot stop checks for good.
	return state.lastCheck === undefined || state.now - state.lastCheck >= appUpdateCheckInterval || state.now < state.lastCheck;
}

/** Where `latest.json` is, next to the download page. */
export function latestReleaseUrl(downloadPageUrl: string): string {
	return new URL('latest.json', downloadPageUrl.endsWith('/') ? downloadPageUrl : `${downloadPageUrl}/`).toString();
}

export interface AppUpdate {
	readonly version: string;
	/** The download page. */
	readonly downloadUrl: string;
	/** The release notes. */
	readonly notesUrl: string;
}

/** The release to offer, if `latest` (the parsed `latest.json`) is a release newer than `current`. */
export function appUpdateToOffer(current: string | undefined, latest: unknown, downloadPageUrl: string): AppUpdate | undefined {
	if (!current || !isVersion(current) || typeof latest !== 'object' || latest === null) {
		return undefined;
	}
	const { version, url, notesUrl } = latest as { readonly version?: unknown; readonly url?: unknown; readonly notesUrl?: unknown };
	if (typeof version !== 'string' || !isVersion(version) || version.includes('-') || compareVersions(version, current) <= 0) {
		return undefined;
	}
	// Only ever open https links; fall back to the page this build knows.
	const downloadUrl = httpsUrl(url) ?? downloadPageUrl;
	return { version, downloadUrl, notesUrl: httpsUrl(notesUrl) ?? `${downloadUrl.replace(/#.*$/, '')}#release-notes` };
}

function httpsUrl(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	try {
		return new URL(value).protocol === 'https:' ? value : undefined;
	} catch {
		return undefined;
	}
}
