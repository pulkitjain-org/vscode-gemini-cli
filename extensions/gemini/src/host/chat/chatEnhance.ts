/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Enhance prompt: rewrites the composer's draft as a precise prompt, shown as
// it arrives, for the user to review before sending.

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentClient } from '../../acp/agentClient';
import { Attachment, attachmentLabel } from '../../acp/attachments';
import type { TranscriptItem } from '../../acp/chatTranscript';
import { errorMessage } from '../../acp/errors';
import { readGitHead } from '../../acp/gitHead';
import { activeFileLabel, EnhanceCancelledError, enhanceHistory } from '../../acp/promptEnhancer';
import type { EnhancePromptInput } from '../../acp/quickPrompts';
import type { FromWebview, ToWebview } from '../chatProtocol';
import type { ChatControllerOptions } from './chatOptions';

/** How long Enhance prompt waits for the folder's index before rewriting without it. */
const indexContextWaitMs = 400;
/** How often a rewrite arriving is shown, at most. */
const progressIntervalMs = 33;

export type EnhanceMessage = Extract<FromWebview, { readonly type: 'prepareEnhance' | 'enhancePrompt' | 'cancelEnhance' }>;

export class ChatEnhance implements vscode.Disposable {

	/** The rewrite running for the composer, so it can be cancelled. */
	private enhancing: { readonly requestId: number; readonly abort: AbortController } | undefined;

	constructor(
		private readonly client: AgentClient,
		private readonly options: Pick<ChatControllerOptions, 'enhancer' | 'indexContext' | 'git' | 'reveal'>,
		/** The conversation so far, which a rewrite may refer to. */
		private readonly history: () => readonly TranscriptItem[],
		private readonly post: (message: ToWebview) => void,
	) { }

	/** The Enhance Prompt command: enhances what the composer holds, showing the chat first. */
	async request(): Promise<void> {
		await this.options.reveal(false);
		this.post({ type: 'enhanceRequested' });
	}

	onMessage(message: EnhanceMessage): void {
		switch (message.type) {
			case 'prepareEnhance':
				// Only once the agent runs: a rewrite is no reason to start it.
				this.options.enhancer.prepare();
				break;
			case 'enhancePrompt':
				void this.enhance(message.requestId, message.text, message.attachments);
				break;
			case 'cancelEnhance':
				if (this.enhancing?.requestId === message.requestId) {
					this.enhancing.abort.abort();
				}
				break;
		}
	}

	dispose(): void {
		this.enhancing?.abort.abort();
	}

	/** Rewrites the composer's draft as a precise prompt and sends it back for the user to review. */
	private async enhance(requestId: number, draft: string, attachments: readonly Attachment[]): Promise<void> {
		const enhancer = this.options.enhancer;
		if (!draft.trim()) {
			return;
		}
		this.enhancing?.abort.abort();
		const abort = new AbortController();
		this.enhancing = { requestId, abort };
		try {
			// The rewrite waits for the agent process itself, not for this chat's session.
			// It shows as it arrives, at most about 30 times a second.
			let progress: { text: string; timer?: ReturnType<typeof setTimeout> } | undefined;
			const onText = (text: string) => {
				progress ??= { text };
				progress.text = text;
				progress.timer ??= setTimeout(() => {
					if (progress && !abort.signal.aborted) {
						progress.timer = undefined;
						this.post({ type: 'enhanceProgress', requestId, text: progress.text });
					}
				}, progressIntervalMs);
			};
			try {
				const text = await enhancer.enhance(await this.input(draft, attachments), abort.signal, onText);
				this.post({ type: 'enhanced', requestId, text });
			} finally {
				clearTimeout(progress?.timer);
			}
		} catch (err) {
			if (!(err instanceof EnhanceCancelledError)) {
				this.post({ type: 'enhanceFailed', requestId, message: errorMessage(err) });
			}
		} finally {
			if (this.enhancing?.abort === abort) {
				this.enhancing = undefined;
			}
		}
	}

	/** The draft with what a rewrite may use: attachment names, the chat so far, the folder, branch, open file and mode. */
	private async input(draft: string, attachments: readonly Attachment[]): Promise<EnhancePromptInput> {
		const client = this.client;
		const folder = this.options.git?.folder() ?? client.cwd;
		const branch = await readGitHead(folder).catch(() => undefined);
		const document = vscode.window.activeTextEditor?.document;
		const activeFile = document?.uri.scheme === 'file' ? activeFileLabel(client.cwd, document.uri.fsPath, document.languageId) : undefined;
		const mode = client.settings.mode;
		// The index answers in milliseconds; a slow answer is left out rather than waited for.
		const codeContext = await Promise.race([
			this.options.indexContext?.(draft).catch(() => undefined) ?? Promise.resolve(undefined),
			new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), indexContextWaitMs)),
		]);
		return {
			draft,
			...codeContext ? { codeContext } : {},
			attachments: attachments.map(attachmentLabel),
			history: enhanceHistory(this.history()),
			folder: path.basename(client.cwd),
			branch,
			activeFile,
			mode: mode?.available.find(choice => choice.id === mode.currentId)?.name,
		};
	}
}
