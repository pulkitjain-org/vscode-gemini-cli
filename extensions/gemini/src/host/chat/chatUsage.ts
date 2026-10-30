/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The usage ring and its popover: how full the session's context window is,
// from the counts the CLI saved, what each part of it is (chatContext.ts,
// also `/context`), and today's quota from the usage meter.

import * as vscode from 'vscode';
import type { AgentClient } from '../../acp/agentClient';
import { readSessionContext } from '../../acp/cliSessions';
import { compactMinPrompts } from '../../acp/sessionSnapshot';
import { upgradeUrl } from '../../acp/helpLinks';
import type { SlashCommand } from '../../acp/slashCommands';
import type { FromWebview, ToWebview } from '../chatProtocol';
import type { ChatControllerOptions } from './chatOptions';

/**
 * Every current Gemini model's context window, in tokens, as gemini-cli's
 * `tokenLimit` has it; the CLI's footer shows context use against it too.
 */
const contextWindow = 1_048_576;

export type UsageMessage = Extract<FromWebview, { readonly type: 'readQuota' | 'openUpgrade' | 'measureContext' }>;

/** `/context`: the usage popover, opened at its context breakdown. */
export function contextCommand(): SlashCommand {
	return { name: 'context', description: vscode.l10n.t("Show what each turn's context carries"), source: 'app' };
}

/** `/stats`, the CLI's name for the same popover. */
export function statsCommand(): SlashCommand {
	return { name: 'stats', description: vscode.l10n.t("The same as /context: tokens and quota, as the CLI's /stats shows them"), source: 'app' };
}

export class ChatUsage implements vscode.Disposable {

	/** Show Usage and Quota ran before the view was ready; the popover opens once it is. */
	private requested = false;
	private readonly listener: { dispose(): void } | undefined;

	constructor(
		private readonly client: AgentClient,
		private readonly options: Pick<ChatControllerOptions, 'usage' | 'reveal' | 'contextCost' | 'workspace' | 'project'>,
		/** Whether the chat shows a conversation: until then there is no context use to read. */
		private readonly hasConversation: () => boolean,
		/** Whether a webview shows the chat. */
		private readonly isAttached: () => boolean,
		private readonly post: (message: ToWebview) => void,
		/** The context's use was read: `used` of `limit` tokens. */
		private readonly onContext?: (used: number, limit: number) => void,
	) {
		this.listener = options.contextCost?.()?.onDidChange(folder => folder === this.folder && this.isAttached() && this.postBreakdown());
	}

	/** Opens the usage popover, or closes it if open (only opens with `open`); the chat comes into view first. */
	async show(open = false): Promise<void> {
		if (!this.isAttached()) {
			this.requested = true;
		}
		await this.options.reveal(false);
		if (this.isAttached() && !this.requested) {
			this.post({ type: 'toggleUsage', ...open ? { open } : {} });
		}
	}

	/** The view loaded: opens the popover if Show Usage and Quota asked for it meanwhile. */
	onReady(): void {
		if (this.requested) {
			this.requested = false;
			this.post({ type: 'toggleUsage' });
		}
	}

	dispose(): void {
		this.listener?.dispose();
	}

	/** The folder whose context the breakdown measures: the workspace's, which an agent's own worktree shares; none in a project's chat. */
	private get folder(): string | undefined {
		return this.options.project ? undefined : this.options.workspace?.()?.folder ?? this.client.cwd;
	}

	/** Sends the breakdown known now; `measure` measures in the background when the last measure is a day old (`force`: now). */
	private postBreakdown(measure?: { readonly force: boolean }): void {
		const source = this.options.contextCost?.();
		const folder = this.folder;
		if (!source || !folder) {
			return;
		}
		if (measure) {
			void source.measure(folder, measure.force);
		}
		this.post({ type: 'contextBreakdown', breakdown: source.view(folder) });
	}

	onMessage(message: UsageMessage): void {
		switch (message.type) {
			case 'readQuota':
				void this.postQuota();
				this.postBreakdown({ force: false });
				break;
			case 'measureContext':
				this.postBreakdown({ force: true });
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
