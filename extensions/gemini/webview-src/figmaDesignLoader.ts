/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Add Figma Design (figmaDesign.ts), loaded the first time it opens: most
// chats never add a design, and the chat opens faster without it.

import { designRefId, type DesignFrame } from '../src/acp/figmaDesign';
import { addAttachments } from './attachmentChips';
import type { FigmaDesignOptions } from './figmaDesign';
import { setLabel } from './dom';
import { selectMenu } from './selectMenu';
import { toolRefContext } from './toolChips';
import { setTransientNotice } from './transcript';
import { state, strings, vscode } from './view';

const url = document.querySelector<HTMLScriptElement>('script[data-strings]')?.dataset.figmaDesign;
let module: Promise<{ openFigmaDesign(options: FigmaDesignOptions): void } | undefined> | undefined;

/** Opens the dialog, empty or with a design's frames to change; the new design's chip replaces the old one. */
export function openFigmaDesign(current?: readonly DesignFrame[]): void {
	// eslint-disable-next-line no-restricted-syntax
	module ??= url ? import(/* webpackIgnore: true */ url).catch((err: unknown) => {
		// Not kept: the next Add Figma Design loads it again.
		module = undefined;
		console.error('Add Figma Design could not load', err);
		setTransientNotice(strings.figmaDesignFailed);
		return undefined;
	}) : Promise.resolve(undefined);
	void module.then(loaded => loaded?.openFigmaDesign({
		strings,
		sizes: toolRefContext().figmaSizes ?? [],
		...toolRefContext().designSystem ? {} : { setUpDesignSystem: () => vscode.postMessage({ type: 'command', command: 'gemini.designSystem.sync' }) },
		...current ? { current } : {},
		selectMenu,
		setLabel,
		onDone: attachment => {
			if (current) {
				state.attachments = state.attachments.filter(a => !(a.kind === 'document' && a.design && a.ref === designRefId(current)));
			}
			addAttachments([attachment]);
		},
	}));
}
