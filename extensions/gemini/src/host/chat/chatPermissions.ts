/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A chat's permission requests: each shows as a card in the transcript, with
// the request's first proposed edit opened while the chat is in view, and a
// warning when another agent has unreviewed changes in a file it edits.
// Allowed for This Session lists the command prefixes the user stopped being
// asked about.

import * as vscode from 'vscode';
import type { ChatTranscript, OtherAgentChanges } from '../../acp/chatTranscript';
import { diffsOf } from '../../acp/chatTurns';
import type { PendingPermission, PermissionBroker, PermissionEvent } from '../../acp/permissions';
import type { FromWebview } from '../chatProtocol';
import type { ChatControllerOptions } from './chatOptions';
import type { ChatFileLinks } from './chatFiles';

export type PermissionMessage = Extract<FromWebview, { readonly type: 'permission' }>;

export class ChatPermissions {

	constructor(
		private readonly broker: PermissionBroker,
		private readonly transcript: ChatTranscript,
		private readonly files: ChatFileLinks,
		private readonly options: Pick<ChatControllerOptions, 'isShown' | 'sharedFiles'>,
	) { }

	/** The other agents with unreviewed changes in any of `paths`, once each. */
	othersChanging(paths: readonly string[]): readonly OtherAgentChanges[] {
		const shared = this.options.sharedFiles;
		if (!shared || !paths.length) {
			return [];
		}
		const others = new Map<string, OtherAgentChanges>();
		for (const filePath of paths) {
			for (const other of shared.others(filePath)) {
				others.set(other.agent, other);
			}
		}
		return [...others.values()];
	}

	/** Shows a request, or how it was answered, in the transcript. */
	apply(event: PermissionEvent): void {
		if (event.kind === 'requested') {
			const diffs = diffsOf(event.permission.request.toolCall.content);
			this.files.remember(event.permission.id, diffs);
			this.transcript.addPermission(event.permission, this.othersChanging(diffs.map(diff => diff.path)));
			void this.reveal(event.permission);
		} else if (event.kind === 'allowed') {
			this.transcript.addPermission(event.permission);
			this.transcript.resolvePermission(event.permission.id, event.outcome, event.label ?? vscode.l10n.t("Allowed for this session"));
		} else {
			this.transcript.resolvePermission(event.id, event.outcome);
		}
	}

	/** The user picked one of a request's options. */
	onMessage(message: PermissionMessage): void {
		this.broker.select(message.id, message.optionId);
	}

	/** Lists the shell command prefixes allowed for this session, to forget some or all of them. */
	async manageApprovals(): Promise<void> {
		const approvals = this.broker.approvals;
		if (!approvals.approved.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t("No commands are allowed for this session. Choose \"Allow for this session\" on a shell command to stop being asked about commands that start with its prefix, such as npx vitest."));
			return;
		}
		const forgetAll: vscode.QuickPickItem = { label: vscode.l10n.t("Forget All"), alwaysShow: true };
		const picks = await vscode.window.showQuickPick<vscode.QuickPickItem>([
			...approvals.approved.map(prefix => ({ label: prefix })),
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			forgetAll,
		], {
			canPickMany: true,
			title: vscode.l10n.t("Allowed for This Session"),
			placeHolder: vscode.l10n.t("Pick command prefixes to forget; the agent asks again before running commands that start with them"),
		});
		if (!picks?.length) {
			return;
		}
		if (picks.includes(forgetAll)) {
			approvals.clear();
		} else {
			picks.forEach(pick => approvals.forget(pick.label));
		}
	}

	/**
	 * Shows the request's first proposed edit when the chat is in view. A chat
	 * out of view is not brought forward, so a waiting agent never takes over
	 * the chat the user is typing in: its status dot, the Dock badge and the
	 * notification say it waits.
	 */
	private async reveal(permission: PendingPermission): Promise<void> {
		if (this.options.isShown && !this.options.isShown()) {
			return;
		}
		const firstDiff = permission.request.toolCall.content?.find(c => c.type === 'diff');
		if (firstDiff) {
			await this.files.openDiff(permission.id, firstDiff.path, true);
		}
	}
}
