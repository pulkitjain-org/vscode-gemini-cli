/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { aliasedSetting } from '../../src/acp/settingAlias';

describe('aliasedSetting', () => {
	it('reads the old key until the new one is set, and the new one wins at the same level', () => {
		expect([
			aliasedSetting(undefined, undefined, true),
			aliasedSetting({}, { globalValue: false }, true),
			aliasedSetting({ globalValue: true }, { globalValue: false }, false),
			aliasedSetting({ globalValue: false }, {}, true),
		]).toEqual([true, false, true, false]);
	});

	it('lets a more specific level of either key win, and policy over everything', () => {
		expect([
			aliasedSetting({ globalValue: true }, { workspaceValue: false }, true),
			aliasedSetting({ workspaceFolderValue: true }, { workspaceValue: false }, false),
			aliasedSetting({ globalValue: true, workspaceValue: true }, { policyValue: false }, true),
		]).toEqual([false, true, false]);
	});
});
