/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The side column of an agent's or thread's chat: where the agent works, its
// change totals, and links that open its Changes, Browser, Terminal and Files
// beside the chat.

import type { FromWebview, SideLink, ToWebview } from '../chatProtocol';
import type { ChatControllerOptions } from './chatOptions';

export type SideLinksMessage = Extract<FromWebview, { readonly type: 'openSideLink' }>;

const links: ReadonlySet<SideLink> = new Set<SideLink>(['changes', 'browser', 'terminal', 'files']);

export class SideLinksColumn {

	private readonly listener: { dispose(): void } | undefined;

	constructor(
		private readonly options: Pick<ChatControllerOptions, 'sideLinks'>,
		private readonly isViewReady: () => boolean,
		private readonly post: (message: ToWebview) => void,
	) {
		this.listener = options.sideLinks?.onDidChange(() => {
			if (this.isViewReady()) {
				this.refresh();
			}
		});
	}

	refresh(): void {
		this.post({ type: 'sideLinks', links: this.options.sideLinks?.view() });
	}

	onMessage(message: SideLinksMessage): void {
		if (links.has(message.link)) {
			this.options.sideLinks?.open(message.link);
		}
	}

	dispose(): void {
		this.listener?.dispose();
	}
}
