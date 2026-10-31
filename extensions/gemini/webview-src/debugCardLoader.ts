/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Debug mode's bar (debugCard.ts), loaded the first time a chat enters Debug
// mode: every other chat opens without its code.

import type { ToWebview } from '../src/host/chatProtocol';
import { setTip } from './dom';
import { ui, vscode } from './view';

const data = document.querySelector<HTMLScriptElement>('script[data-strings]')?.dataset;
let loading: Promise<typeof import('./debugCard') | undefined> | undefined;

export function onDebug(message: Extract<ToWebview, { readonly type: 'debug' }>): void {
	if (!message.view && !loading) {
		return;
	}
	// eslint-disable-next-line no-restricted-syntax
	loading ??= data?.debugCard ? import(/* webpackIgnore: true */ data.debugCard).catch(() => {
		loading = undefined;
		return undefined;
	}) : Promise.resolve(undefined);
	void loading.then(card => card?.renderDebug(message.view, { anchor: ui.queueList, style: data?.debugStyle, post: m => vscode.postMessage(m), setTip, announce: text => ui.announce.textContent = text }));
}
