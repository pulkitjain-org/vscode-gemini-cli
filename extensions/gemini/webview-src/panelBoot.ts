/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// How a page's script starts (src/host/pagePanel.ts is the host's side): the
// VS Code API once, the strings from its script tag, its messages from the
// host routed to one handler, and `ready` sent once the handler is in place.
// Nothing runs on import; a page calls `bootPage` once.

import { pageStrings } from './panelDom';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

export interface BootedPage<To, From, Strings, State = never> {
	readonly strings: Strings;
	/** Sends a message to the host. */
	post(message: From): void;
	/** The element the page renders into: `<main id="page">`, or the id the page's shell names. */
	readonly main: HTMLElement;
	/** What the page saved last time its tab was hidden and brought back (retainContextWhenHidden off), if anything. */
	savedState(): State | undefined;
	saveState(state: State): void;
	/** Starts listening, then tells the host the page is ready; `onMessage` sees every message from then on. */
	start(onMessage: (message: To) => void): void;
}

export function bootPage<To, From extends { readonly type: string }, Strings, State = never>(mainId = 'page'): BootedPage<To, From, Strings, State> {
	const vscode = acquireVsCodeApi();
	return {
		strings: pageStrings<Strings>(),
		post: message => vscode.postMessage(message),
		main: document.getElementById(mainId)!,
		savedState: () => vscode.getState() as State | undefined,
		saveState: state => vscode.setState(state),
		start: onMessage => {
			window.addEventListener('message', (event: MessageEvent<To>) => onMessage(event.data));
			vscode.postMessage({ type: 'ready' });
		},
	};
}
