/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The composer's mode and model pickers. A mode the CLI refuses because it
// does not trust the folder offers to trust it, and the chat says when the
// agent switches mode by itself.

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChatTranscript } from '../../acp/chatTranscript';
import { AgentError, errorMessage } from '../../acp/errors';
import type { FromWebview, ToWebview } from '../chatProtocol';
import { rememberModel } from '../modelPreference';
import type { ChatControllerOptions, ChatHost } from './chatOptions';

export type SettingsMessage = Extract<FromWebview, { readonly type: 'setMode' | 'setModel' }>;

export class ChatSettings implements vscode.Disposable {

	private readonly listener: { dispose(): void };

	constructor(
		private readonly service: Pick<ChatHost, 'client' | 'permissions' | 'trustFolder'>,
		private readonly transcript: ChatTranscript,
		private readonly options: Pick<ChatControllerOptions, 'onDidPickModel'>,
		private readonly post: (message: ToWebview) => void,
	) {
		this.listener = service.client.onDidChangeModeByAgent(({ from, to }) => {
			const name = (id: string | undefined) => service.client.settings.mode?.available.find(choice => choice.id === id)?.name ?? id ?? '';
			this.transcript.addNotice(from === 'plan'
				? vscode.l10n.t("Plan approved, now in {0} mode.", name(to))
				: vscode.l10n.t("The agent switched to {0} mode.", name(to)));
		});
	}

	onMessage(message: SettingsMessage): void {
		const client = this.service.client;
		switch (message.type) {
			case 'setMode':
				void this.change(() => client.setMode(message.id).catch(err => this.offerFolderTrust(err, message.id))).then(() => {
					// Requests that were already waiting are answered as YOLO answers the ones that come next. The picker offers YOLO only where policy allows it.
					if (message.id === 'yolo' && client.settings.mode?.currentId === 'yolo') {
						this.service.permissions.allowPending();
					}
				});
				break;
			case 'setModel':
				void this.change(() => client.setModel(message.id)).then(() => {
					if (client.settings.model?.currentId === message.id) {
						rememberModel(message.id);
						this.options.onDidPickModel?.(message.id);
					}
				});
				break;
		}
	}

	/** Makes a change to the session's settings; a failure shows in the chat, and the pickers show what the session has after it. */
	async change(change: () => Promise<void>): Promise<void> {
		try {
			await change();
		} catch (err) {
			this.transcript.addNotice(errorMessage(err), 'error');
		}
		// Resync the pickers: the change may have failed or been ignored.
		this.post({ type: 'settings', settings: this.service.client.settings });
	}

	dispose(): void {
		this.listener.dispose();
	}

	/**
	 * When the CLI refused a mode because it does not trust the folder, asks
	 * the user to trust it, as the CLI's own terminal does, and switches to the
	 * mode once the agent restarts. Rethrows anything else.
	 */
	private async offerFolderTrust(err: unknown, modeId: string): Promise<void> {
		if (!(err instanceof AgentError) || err.info.kind !== 'untrusted-folder') {
			throw err;
		}
		const folder = this.service.client.cwd;
		const modeName = this.service.client.settings.mode?.available.find(choice => choice.id === modeId)?.name ?? modeId;
		if (!await askToTrustFolder(folder, vscode.l10n.t("{0} mode needs a trusted folder.", modeName))) {
			return;
		}
		this.service.client.setModeOnNextSession(modeId);
		const waits = await this.service.trustFolder(folder);
		this.transcript.addNotice(waits
			? vscode.l10n.t("Folder trusted. The agent restarts in {0} mode once no agent is working.", modeName)
			: vscode.l10n.t("Folder trusted. Restarting the agent in {0} mode.", modeName), 'info');
	}
}

/**
 * The dialog before GeminiCode trusts a folder for the Gemini CLI, from Chat
 * or the Index page; `reason` says why it is asked. Resolves whether the user
 * chose Trust Folder.
 */
export async function askToTrustFolder(folder: string, reason?: string): Promise<boolean> {
	const trust = vscode.l10n.t("Trust Folder");
	const detail = [
		reason,
		vscode.l10n.t("Trusting a folder lets the Gemini CLI load its MCP servers, hooks and project settings, which can run programs on this Mac."),
		vscode.l10n.t("The Gemini CLI remembers the choice for this folder, including in the terminal."),
	].filter(Boolean).join(' ');
	return await vscode.window.showWarningMessage(vscode.l10n.t("Trust {0}?", path.basename(folder) || folder), { modal: true, detail }, trust) === trust;
}
