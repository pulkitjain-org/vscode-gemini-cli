/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseTraceFile, renderTrace, summarizeTrace, traceEnv } from '../acp/traceRecording';
import type { AgentService } from './agentService';
import { setAgentEnvOverride } from './configuration';

let recordingFile: string | undefined;

/** The trace file the agent is writing to while a recording is on, for the chat's per-turn readout. */
export function currentTraceFile(): string | undefined {
	return recordingFile;
}

/**
 * Gemini: Record Performance Trace. Restarts the agent once with the CLI's
 * own telemetry writing to a file in the home folder, and on Stop restarts
 * it again without, then opens a summary of where each turn's time went.
 * Nothing leaves the Mac. The file holds timings and token counts, the CLI's
 * system prompt and tool declarations, and no prompt or reply text.
 */
export class TraceRecorder implements vscode.Disposable {

	private file: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly service: AgentService, private readonly log: vscode.LogOutputChannel) {
		this.disposables.push(vscode.commands.registerCommand('gemini.recordTrace', () => this.file ? this.stop() : this.start()));
	}

	get recording(): string | undefined {
		return this.file;
	}

	dispose(): void {
		if (this.file) {
			recordingFile = undefined;
			setAgentEnvOverride({});
		}
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private async start(): Promise<void> {
		const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
		const file = path.join(os.homedir(), `geminicode-trace-${stamp}.jsonl`);
		this.file = file;
		recordingFile = file;
		setAgentEnvOverride(traceEnv(file));
		this.log.info(`Recording a performance trace to ${file}`);
		this.service.restart();
		const stop = vscode.l10n.t("Stop Recording");
		const choice = await vscode.window.showInformationMessage(vscode.l10n.t("Recording a performance trace to {0}. Use the agent as usual, then stop the recording to see where the time went.", file), stop);
		if (choice === stop && this.file === file) {
			await this.stop();
		}
	}

	private async stop(): Promise<void> {
		const file = this.file;
		if (!file) {
			return;
		}
		this.file = undefined;
		recordingFile = undefined;
		setAgentEnvOverride({});
		this.log.info('Stopping the performance trace; the agent restarts without telemetry once it is idle');
		this.service.restartWhenIdle('restarting without telemetry');
		// The CLI flushes its export on exit; give the old process a moment.
		await new Promise(resolve => setTimeout(resolve, 2_000));
		let text = '';
		try {
			text = await fs.readFile(file, 'utf8');
		} catch {
			void vscode.window.showWarningMessage(vscode.l10n.t("No trace was written to {0}. Send a prompt while the recording is on, then stop it.", file));
			return;
		}
		const summary = renderTrace(summarizeTrace(parseTraceFile(text)), file);
		const summaryFile = file.replace(/\.jsonl$/, '.md');
		await fs.writeFile(summaryFile, summary);
		const doc = await vscode.workspace.openTextDocument(summaryFile);
		await vscode.window.showTextDocument(doc, { preview: false });
		void vscode.commands.executeCommand('markdown.showPreviewToSide', doc.uri);
	}
}
