/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the chat shows for the agent's state and for how a turn ended.

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { AgentStatus } from '../acp/status';
import { ViewStatus } from './chatProtocol';

/** The status line for `status`, with the actions that can fix an error. */
export function toViewStatus(status: AgentStatus): ViewStatus {
	switch (status.phase) {
		case 'stopped': return { phase: status.phase, text: vscode.l10n.t("Gemini is not running."), actions: [{ label: vscode.l10n.t("Start Agent"), command: 'gemini.restartAgent' }] };
		case 'starting': return { phase: status.phase, text: vscode.l10n.t("Starting the Gemini agent...") };
		case 'restarting': return { phase: status.phase, text: vscode.l10n.t("The agent stopped unexpectedly. Restarting...") };
		case 'ready': return { phase: status.phase, text: '' };
		case 'error': {
			const retry = { label: vscode.l10n.t("Retry"), command: 'gemini.restartAgent' } as const;
			const kind = status.error?.kind;
			const fix = kind === 'auth-required' || kind === 'auth-failed'
				? { label: vscode.l10n.t("Sign In"), command: 'gemini.completeSetupInTerminal' } as const
				: kind === 'project-id-required' || kind === 'project-id-numeric'
					? { label: vscode.l10n.t("Set Project ID"), command: 'gemini.setProjectId' } as const
					: { label: vscode.l10n.t("Show Log"), command: 'gemini.showLog' } as const;
			return { phase: status.phase, text: status.error?.message ?? vscode.l10n.t("The agent needs attention."), actions: [fix, retry] };
		}
	}
}

/** A notice for a turn that ended early, or `undefined` for a normal end. */
export function stopReasonNotice(stopReason: acp.StopReason): string | undefined {
	switch (stopReason) {
		case 'end_turn': return undefined;
		case 'cancelled': return vscode.l10n.t("Stopped.");
		case 'max_tokens': return vscode.l10n.t("The response reached the token limit.");
		case 'max_turn_requests': return vscode.l10n.t("The turn reached the request limit.");
		case 'refusal': return vscode.l10n.t("The agent declined to continue.");
		default: return vscode.l10n.t("The turn ended ({0}).", String(stopReason));
	}
}
