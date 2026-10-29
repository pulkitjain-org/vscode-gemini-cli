/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Side questions' panel (sideChat.ts), loaded the first time one is asked:
// most chats never ask one, and every chat opens without its code.

import type { ToWebview } from '../src/host/chatProtocol';
import { setLabel } from './dom';
import { replaceInput } from './enhance';
import { renderBlocks } from './items';
import { state, strings, ui, vscode } from './view';

type Panel = typeof import('./sideChat');

const url = document.querySelector<HTMLScriptElement>('script[data-strings]')?.dataset.sideChat;
let loading: Promise<Panel | undefined> | undefined;

function host(): import('./sideChat').SideHost | undefined {
	const text = strings.side;
	return text && {
		strings: text,
		composer: ui.form,
		post: message => vscode.postMessage(message),
		readsCode: state.research,
		renderMarkdown: text => renderBlocks(text),
		setDraft: replaceInput,
		setLabel,
		announce: text => ui.announce.textContent = text,
	};
}

function load(): Promise<Panel | undefined> {
	// eslint-disable-next-line no-restricted-syntax
	return loading ??= url ? import(/* webpackIgnore: true */ url).catch((err: unknown) => {
		// Not kept: the next side question tries again.
		loading = undefined;
		console.error('Side questions could not load', err);
		return undefined;
	}) : Promise.resolve(undefined);
}

/** A side question's progress from the host. */
export function onSide(message: Extract<ToWebview, { readonly type: 'side' }>): void {
	const from = host();
	if (from) {
		void load().then(panel => panel?.onSide(message, from));
	}
}
