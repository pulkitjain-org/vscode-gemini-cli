/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { shouldCheckForUpdate, updateCheckInterval, updateToOffer } from '../../src/acp/cliUpdates';

const now = 1_800_000_000_000;
const base = { enabled: true, pinnedVersion: '', source: 'managed', lastCheck: undefined, now } as const;

describe('shouldCheckForUpdate', () => {
	it('checks once a day', () => {
		expect(shouldCheckForUpdate(base)).toBe(true);
		expect(shouldCheckForUpdate({ ...base, lastCheck: now - updateCheckInterval + 1 })).toBe(false);
		expect(shouldCheckForUpdate({ ...base, lastCheck: now - updateCheckInterval })).toBe(true);
	});

	it('checks again when the clock went back', () => {
		expect(shouldCheckForUpdate({ ...base, lastCheck: now + 1000 })).toBe(true);
	});

	it('does not check when turned off, pinned, or using the cliPath setting', () => {
		expect(shouldCheckForUpdate({ ...base, enabled: false })).toBe(false);
		expect(shouldCheckForUpdate({ ...base, pinnedVersion: '0.62.0' })).toBe(false);
		expect(shouldCheckForUpdate({ ...base, source: 'setting' })).toBe(false);
		expect(shouldCheckForUpdate({ ...base, source: 'path' })).toBe(true);
	});
});

describe('updateToOffer', () => {
	it('offers a newer release', () => {
		expect(updateToOffer('0.62.0', '0.63.0', undefined)).toBe('0.63.0');
		expect(updateToOffer('0.62.0-preview.1', '0.62.0', undefined)).toBe('0.62.0');
	});

	it('offers nothing that is not newer, skipped, a prerelease or unknown', () => {
		expect(updateToOffer('0.62.0', '0.62.0', undefined)).toBeUndefined();
		expect(updateToOffer('0.63.0', '0.62.0', undefined)).toBeUndefined();
		expect(updateToOffer('0.62.0', '0.63.0', '0.63.0')).toBeUndefined();
		expect(updateToOffer('0.62.0', '0.63.0-preview.1', undefined)).toBeUndefined();
		expect(updateToOffer(undefined, '0.63.0', undefined)).toBeUndefined();
		expect(updateToOffer('dev', '0.63.0', undefined)).toBeUndefined();
	});
});
