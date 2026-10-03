/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { appUpdateToOffer, latestReleaseUrl, shouldCheckForAppUpdate } from '../../src/acp/appUpdates';
import { updateCheckInterval } from '../../src/acp/cliUpdates';

const page = 'https://pulkitjain-org.github.io/vscode-gemini-cli/';
const now = 1_800_000_000_000;
const base = { enabled: true, currentVersion: '0.1.0', downloadPageUrl: page, lastCheck: undefined, now } as const;

describe('shouldCheckForAppUpdate', () => {
	it('checks once a day', () => {
		expect(shouldCheckForAppUpdate(base)).toBe(true);
		expect(shouldCheckForAppUpdate({ ...base, lastCheck: now - updateCheckInterval + 1 })).toBe(false);
		expect(shouldCheckForAppUpdate({ ...base, lastCheck: now - updateCheckInterval })).toBe(true);
		expect(shouldCheckForAppUpdate({ ...base, lastCheck: now + 1000 })).toBe(true);
	});

	it('does not check when turned off, in a dev build, or without a download page', () => {
		expect(shouldCheckForAppUpdate({ ...base, enabled: false })).toBe(false);
		expect(shouldCheckForAppUpdate({ ...base, currentVersion: undefined })).toBe(false);
		expect(shouldCheckForAppUpdate({ ...base, currentVersion: 'dev' })).toBe(false);
		expect(shouldCheckForAppUpdate({ ...base, downloadPageUrl: undefined })).toBe(false);
	});
});

describe('latestReleaseUrl', () => {
	it('finds latest.json next to the page, with or without a trailing slash', () => {
		expect(latestReleaseUrl(page)).toBe(`${page}latest.json`);
		expect(latestReleaseUrl(page.slice(0, -1))).toBe(`${page}latest.json`);
	});
});

describe('appUpdateToOffer', () => {
	const latest = { schema: 1, version: '0.2.0', url: page, notesUrl: 'https://github.com/pulkitjain-org/vscode-gemini-cli/releases/tag/v0.2.0' };

	it('offers a newer release, linking to the page and the notes', () => {
		expect(appUpdateToOffer('0.1.0', latest, page)).toEqual({ version: '0.2.0', downloadUrl: page, notesUrl: latest.notesUrl });
	});

	it('offers nothing for the same or an older release', () => {
		expect(appUpdateToOffer('0.2.0', latest, page)).toBeUndefined();
		expect(appUpdateToOffer('0.3.0', latest, page)).toBeUndefined();
	});

	it('offers a release to a prerelease build of it', () => {
		expect(appUpdateToOffer('0.2.0-rc.1', latest, page)?.version).toBe('0.2.0');
	});

	it('ignores a prerelease, no release yet, and malformed files', () => {
		expect(appUpdateToOffer('0.1.0', { ...latest, version: '0.3.0-rc.1' }, page)).toBeUndefined();
		expect(appUpdateToOffer('0.1.0', { schema: 1, version: null, url: page, downloads: {} }, page)).toBeUndefined();
		expect(appUpdateToOffer('0.1.0', null, page)).toBeUndefined();
		expect(appUpdateToOffer('0.1.0', 'oops', page)).toBeUndefined();
		expect(appUpdateToOffer(undefined, latest, page)).toBeUndefined();
	});

	it('opens only https links, falling back to the page this build knows', () => {
		expect(appUpdateToOffer('0.1.0', { version: '0.2.0', url: 'javascript:alert(1)', notesUrl: 'http://example.com/' }, page))
			.toEqual({ version: '0.2.0', downloadUrl: page, notesUrl: `${page}#release-notes` });
	});
});
