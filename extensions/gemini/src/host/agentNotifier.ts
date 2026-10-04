/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Brings the user back to agents that need them: a system notification while
// GeminiCode is in the background, and the number of waiting agents on the
// Agents pane and the Dock icon. Notifications and the Dock badge go through
// GeminiCode's own workbench commands; in a build without them, only the pane
// shows the count.

import * as vscode from 'vscode';
import { configSection } from './configuration';

const showToastCommand = '_gemini.showToast';
const hideToastCommand = '_gemini.hideToast';
const setBadgeCommand = '_gemini.setApplicationBadge';

export class AgentNotifier implements vscode.Disposable {

	private badge = 0;
	private readonly shown = new Set<string>();

	/** Tells the user, unless they are already looking at GeminiCode. `open` brings the agent up when they click. */
	notify(agentId: string, kind: 'permission' | 'done', title: string, open: () => void): void {
		if (!enabled() || vscode.window.state.focused) {
			return;
		}
		const body = kind === 'permission'
			? vscode.l10n.t("Waiting for your permission")
			: vscode.l10n.t("Finished");
		this.shown.add(agentId);
		vscode.commands.executeCommand<{ clicked?: boolean; actionIndex?: number } | undefined>(showToastCommand, { title, body, key: agentId }).then(result => {
			if (result?.clicked || typeof result?.actionIndex === 'number') {
				open();
			}
		}, () => undefined);
	}

	/** Withdraws the agent's notification, once it no longer needs the user. */
	clear(agentId: string): void {
		if (this.shown.delete(agentId)) {
			vscode.commands.executeCommand(hideToastCommand, agentId).then(undefined, () => undefined);
		}
	}

	/** Shows `count` waiting agents on the Dock icon. */
	setWaiting(count: number): void {
		const value = enabled() ? count : 0;
		if (value === this.badge) {
			return;
		}
		this.badge = value;
		const description = vscode.l10n.t("{0} agents waiting", value);
		vscode.commands.executeCommand(setBadgeCommand, value, description).then(undefined, () => undefined);
	}

	dispose(): void {
		this.setWaiting(0);
		for (const id of [...this.shown]) {
			this.clear(id);
		}
	}
}

function enabled(): boolean {
	return vscode.workspace.getConfiguration(configSection).get<boolean>('notifications.enabled', true);
}
