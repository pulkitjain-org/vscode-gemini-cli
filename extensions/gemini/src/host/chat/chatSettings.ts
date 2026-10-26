/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The composer's mode and model pickers. A mode the CLI refuses because it
// does not trust the folder offers to trust it, and the chat says when the
// agent switches mode by itself. The mode the chat was in before Plan is kept
// for Build This Plan, which builds in it.

import * as vscode from 'vscode';
import type { ChatTranscript } from '../../acp/chatTranscript';
import { AgentError, errorMessage } from '../../acp/errors';
import type { FromWebview, ToWebview } from '../chatProtocol';
import { rememberModel } from '../modelPreference';
import type { ChatControllerOptions, ChatHost } from './chatOptions';

export type SettingsMessage = Extract<FromWebview, { readonly type: 'setMode' | 'setModel' }>;

export class ChatSettings implements vscode.Disposable {

	private readonly listeners: { dispose(): void }[];
	/** The last mode other than Plan the session was in. */
	private lastBuildMode: string | undefined;

	constructor(
		private readonly service: Pick<ChatHost, 'client' | 'permissions' | 'askToTrust'>,
		private readonly transcript: ChatTranscript,
		private readonly options: Pick<ChatControllerOptions, 'onDidPickModel'>,
		private readonly post: (message: ToWebview) => void,
	) {
		this.noteMode(service.client.settings.mode?.currentId);
		this.listeners = [
			service.client.onDidChangeModeByAgent(({ from, to }) => {
				const name = (id: string | undefined) => service.client.settings.mode?.available.find(choice => choice.id === id)?.name ?? id ?? '';
				this.transcript.addNotice(from === 'plan'
					? vscode.l10n.t("Plan approved, now in {0} mode.", name(to))
					: vscode.l10n.t("The agent switched to {0} mode.", name(to)));
			}),
			service.client.onDidChangeSettings(settings => this.noteMode(settings.mode?.currentId)),
		];
	}

	/** The mode the chat was in before Plan mode, which Build This Plan builds in; unset when it started in Plan. */
	get modeBeforePlan(): string | undefined {
		return this.lastBuildMode;
	}

	private noteMode(id: string | undefined): void {
		if (id && id !== 'plan') {
			this.lastBuildMode = id;
		}
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
		for (const listener of this.listeners) {
			listener.dispose();
		}
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
		if (!await this.service.askToTrust(folder)) {
			this.transcript.addNotice(vscode.l10n.t("{0} mode needs a trusted folder.", modeName), 'info');
			return;
		}
		this.service.client.setModeOnNextSession(modeId);
		this.transcript.addNotice(vscode.l10n.t("Folder trusted. The agent switches to {0} mode when it restarts, once no agent is working.", modeName), 'info');
	}
}

/** `gemini.chat.sendWith`: whether ⌘Return (Ctrl+Enter elsewhere) sends, and Return makes a new line. */
export function sendsWithCmdEnter(): boolean {
	return vscode.workspace.getConfiguration('gemini').get<string>('chat.sendWith', 'enter') === 'cmdEnter';
}

/** Calls `listener` with the new value when `gemini.chat.sendWith` changes. */
export function onDidChangeSendWith(listener: (cmdEnter: boolean) => void): vscode.Disposable {
	return vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('gemini.chat.sendWith')) {
			listener(sendsWithCmdEnter());
		}
	});
}
