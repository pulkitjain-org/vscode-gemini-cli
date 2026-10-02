/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatEvent } from '../acp/sessionUpdates';
import { AgentService } from './agentService';

/**
 * "Gemini: Send Prompt": a stopgap for testing the session end to end until
 * the chat view lands. It streams the turn into the "Gemini Transcript" output.
 */
export async function sendPrompt(service: AgentService, transcript: vscode.OutputChannel): Promise<void> {
	const text = await vscode.window.showInputBox({ title: vscode.l10n.t("Ask Gemini"), prompt: vscode.l10n.t("Prompt"), ignoreFocusOut: true });
	if (!text) {
		return;
	}
	transcript.show(true);
	transcript.appendLine(`\n> ${text}\n`);

	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Gemini is working"), cancellable: true }, async (_progress, token) => {
		try {
			await service.ensureReady();
		} catch (err) {
			transcript.appendLine(`[not ready: ${err instanceof Error ? err.message : String(err)}]`);
			return;
		}
		const cancellation = token.onCancellationRequested(() => void service.client.cancel());
		const listener = service.client.onDidReceiveEvent(event => transcript.append(render(event)));
		try {
			const stopReason = await service.client.prompt(text);
			transcript.appendLine(`\n[${stopReason}]`);
		} catch (err) {
			transcript.appendLine(`\n[error: ${err instanceof Error ? err.message : String(err)}]`);
		} finally {
			listener.dispose();
			cancellation.dispose();
		}
	});
}

function render(event: ChatEvent): string {
	switch (event.kind) {
		case 'text':
			return event.role === 'thought' ? `(${event.text})` : event.text;
		case 'toolCall':
			return `\n[tool ${event.call.status}] ${event.call.title}\n`;
		case 'plan':
			return `\n[plan] ${event.entries.map(e => `${e.status === 'completed' ? '[x]' : '[ ]'} ${e.content}`).join('; ')}\n`;
		case 'other':
			return `\n[${event.type}]\n`;
	}
}
