/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between the chat view (chatView.ts) and its webview
// (webview-src/chat.ts). Types only, so the webview bundle can import them.

import type { TranscriptItem } from '../acp/chatTranscript';
import type { AgentPhase } from '../acp/status';

export interface ViewStatus {
	readonly phase: AgentPhase;
	readonly text: string;
}

/** Localised strings the webview shows; it has no l10n of its own. */
export interface ChatStrings {
	readonly placeholder: string;
	readonly send: string;
	readonly stop: string;
	readonly clear: string;
	readonly thinking: string;
	readonly empty: string;
	readonly plan: string;
	/** Contains `{0}` for the update kind. */
	readonly unknownUpdate: string;
	readonly terminal: string;
}

export type FromWebview =
	| { readonly type: 'ready' }
	| { readonly type: 'prompt'; readonly text: string }
	| { readonly type: 'stop' }
	| { readonly type: 'clear' };

export type ToWebview =
	| { readonly type: 'reset'; readonly items: readonly TranscriptItem[]; readonly busy: boolean; readonly status: ViewStatus }
	| { readonly type: 'item'; readonly item: TranscriptItem }
	| { readonly type: 'busy'; readonly busy: boolean }
	| { readonly type: 'status'; readonly status: ViewStatus };
