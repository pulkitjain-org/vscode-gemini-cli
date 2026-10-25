/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The usage ring and its popover: how full the session's context window is,
// from the counts the CLI saved, and today's quota from the usage meter.

import * as vscode from 'vscode';
import type { AgentClient } from '../../acp/agentClient';
import { readSessionContext } from '../../acp/cliSessions';
import { compactMinPrompts } from '../../acp/sessionSnapshot';
import { upgradeUrl } from '../../acp/helpLinks';
import type { FromWebview, ToWebview } from '../chatProtocol';
import type { ChatControllerOptions } from './chatOptions';

/**
 * Every current Gemini model's context window, in tokens, as gemini-cli's
 * `tokenLimit` has it; the CLI's footer shows context use against it too.
 */
const contextWindow = 1_048_576;

export type UsageMessage = Extract<FromWebview, { readonly type: 'readQuota' | 'openUpgrade' }>;

export class ChatUsage {

	/** Show Usage and Quota ran before the view was ready; the popover opens once it is. */
	private requested = false;

	constructor(
		private readonly client: AgentClient,
		private readonly options: Pick<ChatControllerOptions, 'usage' | 'reveal'>,
		/** Whether the chat shows a conversation: until then there is no context use to read. */
		private readonly hasConversation: () => boolean,
		/** Whether a webview shows the chat. */
		private readonly isAttached: () => boolean,
		private readonly post: (message: ToWebview) => void,
		/** The context's use was read: `used` of `limit` tokens. */
		private readonly onContext?: (used: number, limit: number) => void,
	) { }

	/** Opens the usage popover, or closes it if open; the chat comes into view first. */
	async show(): Promise<void> {
		if (!this.isAttached()) {
			this.requested = true;
		}
		await this.options.reveal(false);
		if (this.isAttached() && !this.requested) {
			this.post({ type: 'toggleUsage' });
		}
	}

	/** The view loaded: opens the popover if Show Usage and Quota asked for it meanwhile. */
	onReady(): void {
		if (this.requested) {
			this.requested = false;
			this.post({ type: 'toggleUsage' });
		}
	}

	onMessage(message: UsageMessage): void {
		switch (message.type) {
			case 'readQuota':
				void this.postQuota();
				break;
			case 'openUpgrade':
				void vscode.env.openExternal(vscode.Uri.parse(upgradeUrl));
				break;
		}
	}

	/** How full this session's context window is, from the counts the CLI saved; none until the agent has answered. */
	async postContext(): Promise<void> {
		const state = this.client.state;
		const saved = state.kind === 'ready' && this.hasConversation() ? await readSessionContext(this.client.cwd, state.savedSessionId).catch(() => undefined) : undefined;
		const tokens = saved?.tokens;
		this.post({ type: 'context', context: tokens && { used: tokens.context, limit: contextWindow, cached: tokens.cached, ...(tokens.model ? { model: tokens.model } : {}), canCompact: saved.prompts >= compactMinPrompts } });
		if (tokens) {
			this.onContext?.(tokens.context, contextWindow);
		}
	}

	/** Today's quota for the usage popover: what is known now, then a fresh read if that was not fresh. */
	private async postQuota(): Promise<void> {
		const meter = this.options.usage?.();
		const current = meter?.reading ?? { kind: 'off' as const };
		if (!meter || current.kind === 'off') {
			this.post({ type: 'quota', quota: { kind: 'off' } });
			return;
		}
		this.post({ type: 'quota', quota: current.kind === 'ok' ? { ...current, checking: true } : { kind: 'checking' } });
		this.post({ type: 'quota', quota: await meter.refresh() });
	}
}
