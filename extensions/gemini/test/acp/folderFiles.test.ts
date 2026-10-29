/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { fileNamePattern } from '../../src/acp/folderFiles';

describe('fileNamePattern', () => {
	it('finds a file a reply names anywhere in the folder, matching glob characters as any one character', () => {
		expect(['cart.ts', './src/cart.ts', '../../cart.ts', 'a[1]{b}*?!.ts'].map(fileNamePattern)).toEqual([
			'**/cart.ts', '**/src/cart.ts', '**/cart.ts', '**/a?1??b????.ts',
		]);
	});
});
