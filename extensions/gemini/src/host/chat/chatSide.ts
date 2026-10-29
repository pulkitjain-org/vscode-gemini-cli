/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ChatTranscript } from '../../acp/chatTranscript';
import { errorMessage } from '../../acp/errors';
import { EnhanceCancelledError } from '../../acp/promptEnhancer';
import { sideChatPrompt, type SideExchange, sideHistory } from '../../acp/sideChat';
import type { SlashCommand } from '../../acp/slashCommands';
import type { FromWebview, ToWebview } from '../chatProtocol';
import type { ChatControllerOptions } from './chatOptions';

export type SideMessage = Extract<FromWebview, { readonly type: 'sideAsk' | 'sideCancel' }>;

/** The `/btw` command in the "/" menu. */
export function sideCommand(): SlashCommand {
	return { name: 'btw', description: vscode.l10n.t("Ask about this chat without stopping the agent"), source: 'app' };
}

/**
 * Side questions (src/acp/sideChat.ts): answered from the conversation by a
 * quick request, while the agent keeps working, and never added to its
 * history. The exchanges stay here, for later questions, until the chat closes.
 */
export class ChatSide {

	private readonly exchanges: SideExchange[] = [];
	private running: AbortController | undefined;
	private nextId = 1;

	constructor(
		private readonly options: ChatControllerOptions,
		private readonly transcript: ChatTranscript,
		private readonly isBusy: () => boolean,
		private readonly post: (message: ToWebview) => void,
	) { }

	onMessage(message: SideMessage): void {
		switch (message.type) {
			case 'sideAsk':
				void this.ask(message.question);
				break;
			case 'sideCancel':
				this.cancel();
				break;
		}
	}

	/** Opens the side panel in the view, empty or asking `question` at once. */
	open(question?: string): void {
		if (question?.trim()) {
			void this.ask(question);
		} else {
			this.post({ type: 'side', id: 0, state: 'open' });
		}
	}

	/** Asks `question`; one at a time, so a new question stops the one before. */
	async ask(question: string): Promise<void> {
		question = question.trim();
		if (!question) {
			return;
		}
		this.cancel();
		const running = this.running = new AbortController();
		const id = this.nextId++;
		this.post({ type: 'side', id, state: 'asked', question });
		const { system, prompt } = sideChatPrompt({ items: this.transcript.items, question, earlier: this.exchanges, busy: this.isBusy() });
		// The answer streams in as the text so far; posting each piece is cheap next to the model's pace.
		const onText = (text: string) => this.running === running && this.post({ type: 'side', id, state: 'text', text });
		try {
			const answer = await this.options.enhancer.ask(system, prompt, running.signal, onText);
			if (this.running !== running) {
				return;
			}
			this.exchanges.push({ question, answer });
			this.exchanges.splice(0, Math.max(0, this.exchanges.length - sideHistory));
			this.post({ type: 'side', id, state: 'done', question, text: answer });
		} catch (err) {
			if (this.running === running && !(err instanceof EnhanceCancelledError)) {
				this.post({ type: 'side', id, state: 'error', question, text: vscode.l10n.t("Couldn't answer: {0}", errorMessage(err)) });
			}
		} finally {
			if (this.running === running) {
				this.running = undefined;
			}
		}
	}

	cancel(): void {
		this.running?.abort();
		this.running = undefined;
	}

	dispose(): void {
		this.cancel();
	}
}
