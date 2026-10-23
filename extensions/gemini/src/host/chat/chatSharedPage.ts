/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Shared page chip: the page the user shared with this agent in the
// GeminiCode browser, pinned to the composer until they stop sharing it.

import * as vscode from 'vscode';
import type { FromWebview, ToWebview } from '../chatProtocol';
import type { ChatControllerOptions } from './chatOptions';

export type SharedPageMessage = Extract<FromWebview, { readonly type: 'stopSharing' | 'openSharedPage' }>;

export class SharedPageChip {

	constructor(
		private readonly options: Pick<ChatControllerOptions, 'sharedPage'>,
		private readonly post: (message: ToWebview) => void,
	) { }

	/** Shows the shared page's chip as the browser has it now; resolves with the page, if one is shared. */
	async refresh(): Promise<{ readonly title: string; readonly url: string; readonly note: string } | undefined> {
		const page = await this.options.sharedPage?.current().catch(() => undefined);
		this.post({ type: 'sharedPage', page: page && { title: page.title, url: page.url } });
		return page;
	}

	onMessage(message: SharedPageMessage): void {
		switch (message.type) {
			case 'stopSharing':
				void this.options.sharedPage?.stop().then(() => this.refresh());
				break;
			case 'openSharedPage':
				void this.open();
				break;
		}
	}

	/** Shows the shared page's tab, from a Shared page chip. */
	private async open(): Promise<void> {
		if (!await this.options.sharedPage?.reveal().catch(() => false)) {
			void vscode.window.showInformationMessage(vscode.l10n.t("The page is no longer shared with this agent. Share it again with Let Gemini Use This Page in the page's toolbar."));
			void this.refresh();
		}
	}
}
