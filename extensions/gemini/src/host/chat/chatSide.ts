/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ChatTranscript } from '../../acp/chatTranscript';
import { errorMessage } from '../../acp/errors';
import { EnhanceCancelledError } from '../../acp/promptEnhancer';
import { defaultConcurrency, type ResearchProgress, type ResearchRun } from '../../acp/research';
import { sideChatPrompt, type SideExchange, sideHistory } from '../../acp/sideChat';
import type { SlashCommand } from '../../acp/slashCommands';
import type { FromWebview, ToWebview } from '../chatProtocol';
import { extensionChunk } from '../lazyFeature';
import { sideStrings } from './chatHtml';
import type { ChatControllerOptions } from './chatOptions';

/** The research engine (src/acp/research.ts), from dist/onDemand.js the first time a side question reads the code. */
const onDemand = extensionChunk<typeof import('../../onDemand')>('onDemand');

export type SideMessage = Extract<FromWebview, { readonly type: 'sideAsk' | 'sideCancel' }>;

/** `{0}`, `{1}`... in a side string. */
function format(text: string, ...values: (string | number)[]): string {
	return text.replace(/\{(\d+)\}/g, (match, index) => String(values[Number(index)] ?? match));
}

/** The `/btw` command in the "/" menu. */
export function sideCommand(): SlashCommand {
	return { name: 'btw', description: vscode.l10n.t("Ask about this chat without stopping the agent"), source: 'app' };
}

/**
 * Side questions (src/acp/sideChat.ts): answered from the conversation by a
 * quick request, while the agent keeps working, and never added to its
 * history. With Read the code too, read-only workers read the agent's folder
 * in parallel instead (src/acp/research.ts) and the report is the answer.
 * The exchanges stay here, for later questions, until the chat closes.
 */
export class ChatSide {

	private readonly exchanges: SideExchange[] = [];
	private running: AbortController | undefined;
	/** The research run answering the question, while one does. */
	private research: ResearchRun | undefined;
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
				void this.ask(message.question, message.readCode);
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

	/** Asks `question`; one at a time, so a new question stops the one before. With `readCode`, workers read the code first. */
	async ask(question: string, readCode = false): Promise<void> {
		question = question.trim();
		if (!question) {
			return;
		}
		this.cancel();
		const running = this.running = new AbortController();
		const id = this.nextId++;
		this.post({ type: 'side', id, state: 'asked', question });
		if (readCode && this.options.research) {
			return this.readCode(id, question, running);
		}
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

	/** Read-only workers read the folder in parallel and the report answers; progress shows as the answer so far. */
	private async readCode(id: number, question: string, running: AbortController): Promise<void> {
		const host = this.options.research!;
		const strings = sideStrings();
		const progressText = (progress: ResearchProgress): string => {
			const state = strings.research.states[progress.state] ?? progress.state;
			const lines = progress.slices.map(slice => {
				const detail = slice.state === 'done' ? (format(strings.research.findings, slice.findings))
					: slice.state === 'reading' ? (format(strings.research.reading, slice.files))
						: strings.research.slice[slice.state] ?? slice.state;
				return `- ${slice.state === 'done' ? '\u2713' : slice.state === 'failed' ? '\u2717' : '\u25CB'} ${slice.title}: ${detail}`;
			});
			return [`*${state}* \u00b7 ${strings.research.readOnly ?? ''}`.trim(), ...lines].join('\n');
		};
		let last: ResearchProgress = { state: 'planning', slices: [] };
		try {
			const run = new (onDemand().ResearchRun)(question, {
				runtime: host.runtime,
				cwd: host.cwd(),
				mcpServers: worker => host.mcpServers(worker),
				release: worker => host.release(worker),
				ask: (system, prompt, signal) => this.options.enhancer.ask(system, prompt, signal),
				outline: await host.outline().catch(() => undefined),
				concurrency: defaultConcurrency,
				onProgress: progress => {
					last = progress;
					if (this.running === running) {
						this.post({ type: 'side', id, state: 'text', text: progressText(progress) });
					}
				},
			});
			if (this.running !== running) {
				return;
			}
			this.research = run;
			const report = await run.run();
			if (this.running !== running) {
				return;
			}
			if (last.state === 'stopped') {
				this.post({ type: 'side', id, state: 'error', question, text: report });
				return;
			}
			this.exchanges.push({ question, answer: report });
			this.exchanges.splice(0, Math.max(0, this.exchanges.length - sideHistory));
			this.post({ type: 'side', id, state: 'done', question, text: report });
		} catch (err) {
			if (this.running === running) {
				this.post({ type: 'side', id, state: 'error', question, text: vscode.l10n.t("Couldn't read the code: {0}", errorMessage(err)) });
			}
		} finally {
			if (this.running === running) {
				this.running = undefined;
				this.research = undefined;
			}
		}
	}

	cancel(): void {
		this.running?.abort();
		this.running = undefined;
		this.research?.stop();
		this.research = undefined;
	}

	dispose(): void {
		this.cancel();
	}
}
