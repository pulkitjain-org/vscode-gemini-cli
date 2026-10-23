/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Undo and Rewind. Each turn keeps what its edits replaced, so a turn's
// changes can be put back (Undo on its end), and the chat can go back to
// before one of the user's prompts as the CLI's /rewind does (Rewind to here,
// or Esc twice in an empty message box). The agent is told with the next
// prompt which files were put back.

import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import type { CompletedEdit } from '../../acp/agentChanges';
import type { ChatTranscript } from '../../acp/chatTranscript';
import { checkpointsFit, laterRepeats, rewindPrompts, undoNote } from '../../acp/chatTurns';
import { Checkpoints, type StoredCheckpoints } from '../../acp/checkpoints';
import { canRewindCliSession, readCliConversation, rewindCliSession } from '../../acp/cliSessions';
import { errorMessage } from '../../acp/errors';
import { recordPilot } from '../../acp/pilotLog';
import type { FromWebview } from '../chatProtocol';
import { deleteFile, replaceFileText, WorkspaceFileSystem } from '../workspaceFileSystem';
import type { ChatControllerOptions, ChatHost } from './chatOptions';
import type { ChatSessions } from './chatSessions';

export type CheckpointsMessage = Extract<FromWebview, { readonly type: 'undoTurn' | 'rewind' | 'pickRewind' }>;

/** What Undo and Rewind need of their chat. */
export interface CheckpointsHost {
	/** Whether a turn runs; nothing is undone or rewound meanwhile. */
	isBusy(): boolean;
	setBusy(busy: boolean): void;
	/** Files were put back as they were. */
	restoredFiles(diffs: readonly acp.Diff[]): void;
	/** The chat went back to before the prompt `text`, which goes back in the message box; Retry goes with the turns. */
	rewound(text: string): void;
}

export class ChatCheckpoints {

	/** What each recent turn's edits replaced, so a turn can be undone. */
	private readonly checkpoints: Checkpoints;
	/** Told to the agent with the next prompt: files the user put back, which it would otherwise think it changed. */
	private note: string | undefined;

	constructor(
		private readonly service: Pick<ChatHost, 'client' | 'ensureReady'>,
		private readonly transcript: ChatTranscript,
		private readonly sessions: ChatSessions,
		private readonly options: Pick<ChatControllerOptions, 'saveCheckpoints' | 'project'>,
		private readonly host: CheckpointsHost,
	) {
		this.checkpoints = new Checkpoints(service.client.cwd);
	}

	/** Whether the running turn changed files so far. */
	get turnChangedFiles(): boolean {
		return !!this.checkpoints.running;
	}

	/** What the next prompt tells the agent about files the user put back, if anything. */
	get undoNote(): string | undefined {
		return this.note;
	}

	/** A prompt told the agent about the files put back. */
	noteDelivered(): void {
		this.note = undefined;
	}

	/** Starts keeping the files the turn's edits change. */
	beginTurn(): void {
		this.checkpoints.beginTurn();
	}

	/** Keeps what a completed tool call's edits replaced. */
	record(edits: readonly CompletedEdit[]): void {
		this.checkpoints.record(edits);
	}

	/**
	 * Ends the running turn at its turnEnd item `id`. Older turns that can no
	 * longer be undone lose their Undo. Returns how many files the turn
	 * changed, and whether it can be undone.
	 */
	endTurn(id: string): { readonly files: number; readonly undoable: boolean } {
		const { undoable, dropped } = this.checkpoints.endTurn(id);
		for (const old of dropped) {
			this.transcript.updateTurnEnd(old, { undo: undefined });
		}
		const files = this.checkpoints.fileCount(id);
		if (files || dropped.length) {
			this.save();
		}
		return { files, undoable };
	}

	/**
	 * Takes back the checkpoints saved with the chat, once its conversation is
	 * shown: the turns they cover offer Undo again.
	 */
	restore(stored: StoredCheckpoints | undefined): void {
		// Checkpoints of turns the chat does not show (it was not restored, or started over) would undo the wrong turns.
		if (this.host.isBusy() || !checkpointsFit(this.transcript.items, stored)) {
			return;
		}
		this.checkpoints.restore(stored);
		for (const id of this.checkpoints.turnIds) {
			if (this.checkpoints.canUndo(id)) {
				this.transcript.updateTurnEnd(id, { files: this.checkpoints.fileCount(id), undo: 'available' });
			}
		}
	}

	/** Forgets every turn's checkpoints, as the conversation is cleared. */
	clear(): void {
		this.checkpoints.clear();
		this.save();
		this.note = undefined;
	}

	onMessage(message: CheckpointsMessage): void {
		switch (message.type) {
			case 'undoTurn':
				void this.undoTurn(message.itemId).then(done => done && recordPilot({ kind: 'undo', scope: 'turn' }));
				break;
			case 'rewind':
				void this.rewind(message.itemId);
				break;
			case 'pickRewind':
				void this.pickRewind();
				break;
		}
	}

	private save(): void {
		this.options.saveCheckpoints?.(this.checkpoints.toStored());
	}

	/**
	 * Puts back every file turn `id` changed, and the changes of the turns
	 * after it. Asks first when that reaches further than the turn, or when a
	 * file was changed after the agent wrote it. `rewinding` is set when Rewind
	 * already said later replies go too. Resolves with whether it went ahead.
	 */
	private async undoTurn(id: string, rewinding = false): Promise<boolean> {
		const plan = this.checkpoints.plan(id);
		if ((this.host.isBusy() && !rewinding) || !plan) {
			return false;
		}
		const files = new WorkspaceFileSystem();
		const current = await Promise.all(plan.restores.map(r => files.readTextFile(r.path).catch(() => undefined)));
		const changedSince = plan.restores.filter((r, i) => (current[i] ?? '') !== r.agentText);
		if ((plan.laterTurns && !rewinding) || changedSince.length) {
			const undo = vscode.l10n.t("Undo Changes");
			const detail = [
				plan.laterTurns === 1 ? vscode.l10n.t("This also undoes the changes from the reply after it.") : plan.laterTurns ? vscode.l10n.t("This also undoes the changes from the {0} replies after it.", plan.laterTurns) : '',
				changedSince.length ? vscode.l10n.t("These files changed after Gemini edited them, and those changes will be lost: {0}", changedSince.map(r => path.basename(r.path)).join(', ')) : '',
			].filter(Boolean).join('\n\n');
			if (await vscode.window.showWarningMessage(vscode.l10n.t("Undo the changes to {0} files?", plan.restores.length), { modal: true, detail }, undo) !== undo) {
				return false;
			}
		}
		const restored: acp.Diff[] = [];
		const failed: string[] = [];
		for (const [i, restore] of plan.restores.entries()) {
			try {
				if (restore.text === undefined) {
					await deleteFile(restore.path);
				} else {
					await replaceFileText(restore.path, restore.text);
				}
				restored.push({ path: restore.path, oldText: current[i] ?? '', newText: restore.text ?? '' });
			} catch (err) {
				failed.push(`${path.basename(restore.path)}: ${errorMessage(err)}`);
			}
		}
		for (const undone of this.checkpoints.undone(id)) {
			this.transcript.updateTurnEnd(undone, { undo: 'undone' });
		}
		this.save();
		if (restored.length) {
			this.host.restoredFiles(restored);
			this.note = undoNote(this.service.client.cwd, restored.map(r => r.path));
			this.transcript.addNotice(restored.length === 1
				? vscode.l10n.t("Undid the changes to {0}. Gemini will be told with your next message.", path.basename(restored[0].path))
				: vscode.l10n.t("Undid the changes to {0} files. Gemini will be told with your next message.", restored.length));
		}
		if (failed.length) {
			this.transcript.addNotice(vscode.l10n.t("Some files could not be put back: {0}", failed.join('; ')), 'error');
		}
		return true;
	}

	/** Esc twice in an empty message box, as in the CLI: picks one of the user's prompts to rewind to. */
	private async pickRewind(): Promise<void> {
		if (this.host.isBusy() || this.options.project) {
			return;
		}
		const prompts = rewindPrompts(this.transcript.items);
		if (!prompts.length) {
			return;
		}
		const pick = await vscode.window.showQuickPick(prompts.map(item => ({
			label: item.text.replace(/\s+/g, ' ').trim(),
			...(item.at ? { description: new Date(item.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) } : {}),
			id: item.id,
		})), {
			title: vscode.l10n.t("Rewind"),
			placeHolder: vscode.l10n.t("Pick a message to rewind to, newest first. The conversation goes back to before it."),
			matchOnDescription: true,
		});
		if (pick) {
			await this.rewind(pick.id);
		}
	}

	/**
	 * Rewinds to before the user's prompt `itemId`, as the CLI's /rewind does:
	 * the conversation goes from the chat and from Gemini's context, and the
	 * files Gemini changed since go back. ACP has no rewind, so the CLI's saved
	 * session gets the record its /rewind writes and is loaded again. The
	 * prompt's text goes back in the message box.
	 */
	private async rewind(itemId: string): Promise<void> {
		const items = this.transcript.items;
		const index = items.findIndex(item => item.id === itemId);
		const prompt = items[index];
		if (this.host.isBusy() || this.options.project || prompt?.kind !== 'user' || !prompt.text.trim()) {
			return;
		}
		// Code: the first kept turn after the prompt, which undoes the later ones with it.
		const after = new Set(items.slice(index).map(item => item.id));
		const firstTurn = this.checkpoints.turnIds.find(id => after.has(id));
		const plan = firstTurn ? this.checkpoints.plan(firstTurn) : undefined;
		const files = plan?.restores.length ?? 0;
		const filesNote = files === 1 ? vscode.l10n.t("The 1 file Gemini changed since goes back to how it was.") : files ? vscode.l10n.t("The {0} files Gemini changed since go back to how they were.", files) : '';
		await this.service.ensureReady().catch(() => undefined);
		const sessionId = this.sessions.current();
		const found = !!sessionId && await canRewindCliSession(this.service.client.cwd, sessionId, prompt.text, laterRepeats(items, index));
		if (!found && !plan) {
			void vscode.window.showWarningMessage(vscode.l10n.t("This message can't be rewound: it is not in the Gemini CLI's saved session, for example because it ran a team command or skill."));
			return;
		}
		const rewind = vscode.l10n.t("Rewind");
		const undoCode = vscode.l10n.t("Undo Code");
		const answer = found
			? await vscode.window.showWarningMessage(vscode.l10n.t("Rewind to before this message?"), {
				modal: true,
				detail: [vscode.l10n.t("This message and everything after it are removed from the chat and from Gemini's context, so Gemini forgets them. The message goes back in the message box, to edit and send again."), filesNote].filter(Boolean).join('\n\n'),
			}, rewind)
			: await vscode.window.showWarningMessage(vscode.l10n.t("Undo the code changes since this message?"), {
				modal: true,
				detail: [vscode.l10n.t("The conversation can't be rewound: this message is not in the Gemini CLI's saved session, for example because it ran a team command or skill."), filesNote].join('\n\n'),
			}, undoCode);
		if (!answer || this.host.isBusy() || this.transcript.items[index]?.id !== itemId) {
			return;
		}
		if (firstTurn && plan && !await this.undoTurn(firstTurn, true)) {
			return;
		}
		recordPilot(found ? { kind: 'rewind' } : { kind: 'undo', scope: 'turn' });
		if (found) {
			await this.rewindChat(itemId, prompt.text);
		}
	}

	private async rewindChat(itemId: string, text: string): Promise<void> {
		const items = this.transcript.items;
		const index = items.findIndex(item => item.id === itemId);
		const fromEnd = laterRepeats(items, index);
		this.host.setBusy(true);
		let reason: string | undefined;
		try {
			await this.service.ensureReady();
			const sessionId = this.sessions.current();
			if (!sessionId || !await rewindCliSession(this.service.client.cwd, sessionId, text, fromEnd).catch(() => false)) {
				reason = vscode.l10n.t("The message is not in the Gemini CLI's saved session any more. The chat and Gemini's context are unchanged.");
				return;
			}
			this.sessions.moveTo(sessionId);
			if (!await this.service.client.loadSession(sessionId).catch(() => false)) {
				// The session file is rewound but the CLI did not take it up: carry what is left into a new session.
				this.sessions.carry('this chat', await readCliConversation(this.service.client.cwd, sessionId).catch(() => undefined));
			}
			const cut = new Set(items.slice(index).map(item => item.id));
			const firstTurn = this.checkpoints.turnIds.find(id => cut.has(id));
			if (firstTurn) {
				// Replies whose changes could not be kept to undo go with the conversation.
				this.checkpoints.forgetFrom(firstTurn);
				this.save();
			}
			this.transcript.cutAt(itemId);
			this.host.rewound(text);
		} catch (err) {
			reason = errorMessage(err);
		} finally {
			this.host.setBusy(false);
		}
		if (reason) {
			this.transcript.addNotice(vscode.l10n.t("Could not rewind the conversation: {0}", reason), 'error');
		}
	}
}
