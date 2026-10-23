/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Compact: moves the chat to a smaller copy of its session, so later turns
// send less. The agent writes a summary of the work in a turn that stays out
// of the chat; that turn is then rewound out of the session again. The copy
// (`sessionSnapshot.ts`) is the summary, then the latest prompts that fit,
// as they were; the session it replaces stays saved, so Undo goes back to it.
// gemini-cli 0.64 compresses a session on its own once it is half full, but
// only in memory: a session it reopens comes back whole. /compress, which
// does it on request, is not offered over ACP.

import * as vscode from 'vscode';
import type { ChatTranscript, CompactItem } from '../../acp/chatTranscript';
import { shouldSuggestCompact } from '../../acp/chatTurns';
import { isPrompt, MessageRecord, readSessionMessages, readSessionTokens, rewindCliSession, textOf } from '../../acp/cliSessions';
import { errorMessage } from '../../acp/errors';
import { compactedMessages, compactSplit, estimateTokens, summaryMarker, summaryPrompt, writeSessionCopy } from '../../acp/sessionSnapshot';
import type { SlashCommand } from '../../acp/slashCommands';
import type { FromWebview } from '../chatProtocol';
import type { ChatControllerOptions, ChatHost } from './chatOptions';
import type { ChatSessions } from './chatSessions';

export type CompactMessage = Extract<FromWebview, { readonly type: 'compact' | 'undoCompact' | 'dismissCompact' | 'viewCompactSummary' }>;

/** What compacting needs of its chat. */
export interface CompactHost {
	isBusy(): boolean;
	/** Runs `work` with the chat busy, its turn's updates kept out of the transcript. */
	quietly<T>(work: () => Promise<T>): Promise<T>;
	/** Reads the context's use again, for the ring. */
	refreshContext(): void;
}

export class ChatCompact {

	/** Whether a compact is under way. */
	private running = false;

	constructor(
		private readonly service: Pick<ChatHost, 'client' | 'ensureReady' | 'writeLog'>,
		private readonly transcript: ChatTranscript,
		private readonly sessions: ChatSessions,
		private readonly options: Pick<ChatControllerOptions, 'editorColumn'>,
		private readonly host: CompactHost,
	) { }

	onMessage(message: CompactMessage): void {
		switch (message.type) {
			case 'compact':
				void this.compact(message.itemId);
				break;
			case 'undoCompact':
				void this.undo(message.itemId);
				break;
			case 'dismissCompact':
				this.transcript.updateCompact(message.itemId, { state: 'dismissed' });
				break;
			case 'viewCompactSummary':
				void this.viewSummary(message.itemId);
				break;
		}
	}

	/** The context is `used` of `limit` tokens full: the chat may suggest compacting. */
	contextChanged(used: number, limit: number): void {
		if (!this.running && shouldSuggestCompact(this.transcript.items, this.sessions.current(), used, limit)) {
			this.transcript.addCompact({ state: 'suggested', percent: Math.round(used / limit * 100) });
		}
	}

	/** Compacts the chat's session; `itemId` is the suggestion it answers, if any. */
	async compact(itemId?: string): Promise<void> {
		if (this.running) {
			return;
		}
		if (this.host.isBusy()) {
			this.transcript.addNotice(vscode.l10n.t("Compact waits for the agent to finish: try again once this turn ends."));
			return;
		}
		this.running = true;
		const id = itemId && this.transcript.items.some(item => item.id === itemId && item.kind === 'compact') ? itemId : this.transcript.addCompact({ state: 'running' });
		this.transcript.updateCompact(id, { state: 'running', error: undefined });
		try {
			const done = await this.host.quietly(() => this.run());
			this.transcript.updateCompact(id, { ...done, state: 'done' });
		} catch (err) {
			this.transcript.updateCompact(id, { state: 'failed', error: errorMessage(err) });
		} finally {
			this.running = false;
			this.host.refreshContext();
		}
	}

	private async run(): Promise<Pick<CompactItem, 'before' | 'after' | 'kept' | 'summary' | 'from' | 'to'>> {
		await this.service.ensureReady();
		const client = this.service.client;
		const from = this.sessions.current();
		const saved = from ? await readSessionMessages(client.cwd, from) : undefined;
		if (!from || !saved || saved.messages.filter(isPromptMessage).length < 2) {
			throw new Error(vscode.l10n.t("There isn't enough in this chat to compact yet."));
		}
		const { messages } = saved;
		const split = compactSplit(messages);
		const tokens = await readSessionTokens(client.cwd, from).catch(() => undefined);
		const before = Math.max(estimateTokens(messages), tokens?.context ?? 0);
		const summary = await this.summarize();
		// The summary's own turn goes again, so Undo comes back to the session as it was.
		await rewindCliSession(client.cwd, from, summaryMarker, 0).catch(() => false);
		const compacted = compactedMessages(messages, summary, split);
		const to = await writeSessionCopy(client.cwd, compacted);
		await this.switchTo(to, from);
		return { before, after: estimateTokens(compacted), kept: compacted.filter(isPromptMessage).length - 1, summary, from, to };
	}

	/** The agent's summary of the session, from a turn whose updates stay out of the chat. */
	private async summarize(): Promise<string> {
		let text = '';
		const listener = this.service.client.onDidReceiveEvent(event => {
			if (event.kind === 'text' && event.role === 'agent') {
				text += event.text;
			}
		});
		try {
			const { stopReason } = await this.service.client.promptTurn([{ type: 'text', text: summaryPrompt }]);
			if (stopReason === 'cancelled') {
				throw new Error(vscode.l10n.t("Compacting was stopped."));
			}
		} finally {
			listener.dispose();
		}
		if (!text.trim()) {
			throw new Error(vscode.l10n.t("Gemini gave no summary."));
		}
		return text.trim();
	}

	/** Moves the chat to session `to`; when the agent can't open it, back to `back`, so the chat never ends up on an empty session. */
	private async switchTo(to: string, back: string): Promise<void> {
		this.sessions.moveTo(to);
		if (await this.service.client.loadSession(to).catch(() => false)) {
			return;
		}
		this.service.writeLog?.(`Could not open the compacted session ${to}; going back to ${back}.`);
		this.sessions.moveTo(back);
		await this.service.client.loadSession(back).catch(() => false);
		throw new Error(vscode.l10n.t("The agent could not open the compacted session, so the chat stays on its full session."));
	}

	/** Goes back to the session a compact replaced. */
	private async undo(itemId: string): Promise<void> {
		const item = this.transcript.items.find(i => i.id === itemId);
		if (item?.kind !== 'compact' || item.state !== 'done' || !item.from || !item.to || this.running) {
			return;
		}
		if (this.host.isBusy()) {
			this.transcript.addNotice(vscode.l10n.t("Undo waits for the agent to finish: try again once this turn ends."));
			return;
		}
		if (this.sessions.current() !== item.to) {
			this.transcript.addNotice(vscode.l10n.t("This compact can't be undone: the chat has moved to another session since."), 'error');
			return;
		}
		this.running = true;
		try {
			await this.host.quietly(() => this.switchTo(item.from!, item.to!));
			this.transcript.updateCompact(itemId, { state: 'undone' });
		} catch (err) {
			this.transcript.addNotice(vscode.l10n.t("Could not undo the compact: {0}", errorMessage(err)), 'error');
		} finally {
			this.running = false;
			this.host.refreshContext();
		}
	}

	/** Opens a compact's summary as a Markdown document. */
	private async viewSummary(itemId: string): Promise<void> {
		const item = this.transcript.items.find(i => i.id === itemId);
		if (item?.kind === 'compact' && item.summary) {
			const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: item.summary });
			// In the agent's own group, beside its chat.
			await vscode.window.showTextDocument(document, { preview: true, viewColumn: await this.options.editorColumn?.() });
		}
	}
}

/** /compact, in chats that can compact. */
export function compactCommand(): SlashCommand {
	return { name: 'compact', description: vscode.l10n.t("Summarize the older work to free up context"), source: 'app' };
}

function isPromptMessage(message: MessageRecord): boolean {
	return message.type === 'user' && isPrompt(textOf(message.content).trim());
}
