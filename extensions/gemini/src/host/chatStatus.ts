/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the chat shows for the agent's state and for how a turn ended.

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import type { TurnStall } from '../acp/agentClient';
import type { NoticeAction } from '../acp/chatTranscript';
import type { AgentErrorInfo, TurnErrorInfo } from '../acp/errors';
import { AgentStatus } from '../acp/status';
import { ViewStatus } from './chatProtocol';

/** The ways out a failed or cut-short turn offers, for the notice's buttons (see `NoticeAction`). */
export type TurnAction = NoticeAction;

/** What the chat says about a failed turn, and the ways out it offers. */
export interface TurnErrorNotice {
	readonly text: string;
	readonly actions: readonly TurnAction[];
	/** The classification the text came from. */
	readonly error: TurnErrorInfo;
}

/** The message for an agent error the CLI words badly or not at all; the agent's own message otherwise. */
export function agentErrorText(error: AgentErrorInfo): string {
	switch (error.kind) {
		case 'network': return vscode.l10n.t("Can't reach Google. Check your connection, VPN or proxy.");
		case 'timeout': return vscode.l10n.t("The Gemini agent stopped answering while it set up the chat. Restart the agent to try again.");
		case 'agent-restarted': return vscode.l10n.t("The agent restarted. Send your message again.");
		default: return error.message;
	}
}

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
			// Sign In restarts the agent, whose `authenticate` opens Google's sign-in in the browser (gemini-cli
			// skips its consent prompt over ACP). A failed sign-in with a code means no browser can open: that one needs the terminal.
			const fix = kind === 'auth-required'
				? { label: vscode.l10n.t("Sign In"), command: 'gemini.signIn' } as const
				: kind === 'auth-failed'
					? { label: vscode.l10n.t("Sign In"), command: 'gemini.completeSetupInTerminal' } as const
				: kind === 'project-id-required' || kind === 'project-id-numeric'
					? { label: vscode.l10n.t("Set Project ID"), command: 'gemini.setProjectId' } as const
					: { label: vscode.l10n.t("Show Log"), command: 'gemini.showLog' } as const;
			return { phase: status.phase, text: status.error ? agentErrorText(status.error) : vscode.l10n.t("The agent needs attention."), actions: [fix, retry] };
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

/** The ways out a turn that ended early offers: Continue at the request limit. */
export function stopReasonActions(stopReason: acp.StopReason): readonly TurnAction[] {
	return stopReason === 'max_turn_requests' ? ['continue'] : [];
}

/** When a quota resets, as a time today or a date and time later. */
function resetTime(resetsAt: number, now: number): string {
	const at = new Date(resetsAt);
	const sameDay = at.toDateString() === new Date(now).toDateString();
	return sameDay
		? at.toLocaleTimeString(vscode.env.language, { hour: 'numeric', minute: '2-digit' })
		: at.toLocaleString(vscode.env.language, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** The chat's notice for a failed turn (see `classifyTurnError`), in plain words, with its ways out. */
export function turnErrorNotice(error: TurnErrorInfo, now = Date.now()): TurnErrorNotice {
	switch (error.kind) {
		case 'quota': {
			const text = error.model && error.resetsAt !== undefined
				? vscode.l10n.t("Quota used up for {0}. It resets at {1}.", error.model, resetTime(error.resetsAt, now))
				: error.model
					? vscode.l10n.t("Quota used up for {0}. Try again later, or switch to another model.", error.model)
					: error.resetsAt !== undefined
						? vscode.l10n.t("Gemini's quota is used up. It resets at {0}.", resetTime(error.resetsAt, now))
						: vscode.l10n.t("Gemini's quota is used up. Try again later, or switch to another model.");
			return { text, actions: ['retry', 'switchModel'], error };
		}
		case 'network':
			return { text: vscode.l10n.t("Can't reach Google. Check your connection, VPN or proxy."), actions: ['retry', 'showLog'], error };
		case 'auth-expired':
			return { text: vscode.l10n.t("Your Gemini sign-in has expired."), actions: ['signIn', 'retry'], error };
		case 'server':
			return { text: vscode.l10n.t("Gemini's service had a problem: {0}", error.message), actions: ['retry', 'showLog'], error };
		case 'agent-restarted':
			return { text: vscode.l10n.t("The agent restarted. Send your message again."), actions: ['retry'], error };
		case 'timeout':
			return { text: vscode.l10n.t("The Gemini agent stopped answering while it set up the chat. Restart the agent to try again."), actions: ['retry', 'showLog'], error };
		default:
			return { text: error.message, actions: ['retry', 'showLog'], error };
	}
}

/** What the chat says about a stalled turn (see `AgentClient.stall`), with Stop and Show Log as its ways out. */
export function stallNotice(stall: TurnStall, now = Date.now()): { readonly text: string; readonly actions: readonly TurnAction[] } {
	const seconds = Math.max(0, Math.round((now - stall.since) / 1000));
	const text = stall.retry
		? vscode.l10n.t("No response from Gemini for {0} s. Gemini is retrying after a server error (attempt {1}).", seconds, stall.retry.attempt)
		: vscode.l10n.t("No response from Gemini for {0} s. It may be retrying a busy server.", seconds);
	return { text, actions: ['stop', 'showLog'] };
}
