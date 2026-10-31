/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Changes panel's Try chevron menu with the menu class, a chunk of its own
// loaded on the first click on the chevron, so the panel's script stays small.

import type { TryChoiceStrings } from '../src/host/panelStrings';
import { Menu } from './menu';
import { createTryChoiceMenu, type TryChoiceMenu } from './tryChoiceMenu';

export function createChangesMenu(strings: TryChoiceStrings, tip: (node: HTMLElement, tip: string) => void): TryChoiceMenu {
	return createTryChoiceMenu(Menu, strings, tip);
}
