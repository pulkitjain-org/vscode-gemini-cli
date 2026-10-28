/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ChatTranscript } from '../../acp/chatTranscript';
import { errorMessage } from '../../acp/errors';
import type { ResearchProgress, ResearchRun } from '../../acp/research';
import type { SlashCommand } from '../../acp/slashCommands';
import { configSection } from '../configuration';
import { extensionChunk } from '../lazyFeature';
import type { FromWebview, ToWebview } from '../chatProtocol';
import type { ChatControllerOptions } from './chatOptions';

/** The research engine (src/acp/research.ts), from dist/onDemand.js the first time /research runs. */
const onDemand = extensionChunk<typeof import('../../onDemand')>('onDemand');
/** As research.ts has them: four workers at once by default, eight at most. */
const defaultConcurrency = 4;
const maxSlices = 8;

export type ResearchMessage = Extract<FromWebview, { readonly type: 'researchStop' | 'researchUse' }>;

/** The `/research` command in the "/" menu. */
export function researchCommand(): SlashCommand {
	return { name: 'research', description: vscode.l10n.t("Read widely in parallel, read-only, and report with sources"), source: 'app' };
}

/**
 * Research runs in a chat (src/acp/research.ts): one at a time, shown as a
 * card in the transcript that the run's progress and report update. The run
 * is not part of the agent's conversation; Send to Agent puts its report in
 * the message box.
 */
export class ChatResearch {

	private running: { readonly id: string; readonly run: ResearchRun } | undefined;

	constructor(
		private readonly options: ChatControllerOptions,
		private readonly transcript: ChatTranscript,
		private readonly post: (message: ToWebview) => void,
	) { }

	onMessage(message: ResearchMessage): void {
		switch (message.type) {
			case 'researchStop':
				if (this.running?.id === message.id) {
					this.running.run.stop();
				}
				break;
			case 'researchUse': {
				const item = this.transcript.items.find(each => each.id === message.id);
				if (item?.kind === 'research' && item.report) {
					this.post({ type: 'draft', text: vscode.l10n.t("Here is what research found for \"{0}\". Act on it:\n\n{1}", item.question, item.report) });
				}
				break;
			}
		}
	}

	async run(question: string): Promise<void> {
		const host = this.options.research;
		if (!question.trim()) {
			this.transcript.addNotice(vscode.l10n.t("Add a question after /research, such as /research where are auth tokens logged?"));
			return;
		}
		if (!host) {
			this.transcript.addNotice(vscode.l10n.t("Research isn't available in this chat."), 'error');
			return;
		}
		if (this.running) {
			this.transcript.addNotice(vscode.l10n.t("A research run is still going in this chat: stop it or wait for its report first."));
			return;
		}
		const id = this.transcript.addResearch(question.trim());
		let last: ResearchProgress = { state: 'planning', slices: [] };
		const concurrency = vscode.workspace.getConfiguration(configSection).get<number>('research.concurrency', defaultConcurrency);
		const run = new (onDemand().ResearchRun)(question.trim(), {
			runtime: host.runtime,
			cwd: host.cwd(),
			mcpServers: worker => host.mcpServers(worker),
			release: worker => host.release(worker),
			ask: (system, prompt, signal) => this.options.enhancer.ask(system, prompt, signal),
			outline: await host.outline().catch(() => undefined),
			concurrency: Math.min(maxSlices, Math.max(1, Math.floor(concurrency) || defaultConcurrency)),
			onProgress: progress => {
				last = progress;
				this.transcript.updateResearch(id, progress);
			},
		});
		this.running = { id, run };
		try {
			const report = await run.run();
			this.transcript.updateResearch(id, last, report);
		} catch (err) {
			this.transcript.updateResearch(id, { ...last, state: 'failed' }, vscode.l10n.t("Research failed: {0}", errorMessage(err)));
		} finally {
			this.running = undefined;
		}
	}

	dispose(): void {
		this.running?.run.stop();
	}
}
