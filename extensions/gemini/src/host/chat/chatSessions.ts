/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which of the CLI's sessions a chat is on, and the saved ones it can reopen.
// The chat says when the agent opened another session than the one its
// conversation belongs to, and a conversation the agent could not reopen goes
// to the new session with the next prompt. An empty chat offers the newest
// saved sessions; /resume and Restore a Gemini CLI Session offer them all.

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChatTranscript } from '../../acp/chatTranscript';
import { keepChatsForever, keepChatsPeriod, readCliPreferences } from '../../acp/cliPreferences';
import { carriedConversationNote, CliSession, ConversationEntry, isPassingFailure, isPrompt, listCliSessions, readCliConversation, reopenFailure } from '../../acp/cliSessions';
import { withoutSteeringNote } from '../../acp/promptQueue';
import { withoutReactionNotes } from '../../acp/reactions';
import { geminiDir } from '../../acp/directRequest';
import { AgentErrorInfo, errorMessage } from '../../acp/errors';
import { readSettingsFile } from '../../acp/projectSettings';
import type { ChatEvent } from '../../acp/sessionUpdates';
import type { SlashCommand } from '../../acp/slashCommands';
import type { FromWebview, ToWebview } from '../chatProtocol';
import { relativeTime } from '../displayText';
import type { ChatControllerOptions, ChatHost } from './chatOptions';

/** How many saved sessions an empty chat lists before "Show all". */
const shownSessions = 3;

export type SessionsMessage = Extract<FromWebview, { readonly type: 'restoreSession' | 'pickSession' }>;

/** What restoring a saved session needs of its chat. */
export interface SessionsHost {
	/** Whether a turn runs; nothing is restored meanwhile. */
	isBusy(): boolean;
	setBusy(busy: boolean): void;
	/** Clears the conversation and what the chat keeps about it, to make room for the restored session's. */
	clearConversation(): void;
	/** Saved session `title` was reopened here. */
	restored(title: string): void;
}

export class ChatSessions implements vscode.Disposable {

	/** The session the conversation belongs to, so the chat can say when the agent opened another. */
	private lastSessionId: string | undefined;
	/** A conversation the agent could not reopen, given to the new session with the next prompt. */
	private carried: string | undefined;
	/** While a reopened session replays, its messages belong in the transcript. Ends with the next prompt. */
	private replaying = false;
	private readonly disposables: { dispose(): void }[] = [];

	constructor(
		private readonly service: Pick<ChatHost, 'client' | 'ensureReady' | 'writeLog'>,
		private readonly transcript: ChatTranscript,
		private readonly options: Pick<ChatControllerOptions, 'savedSessions'>,
		private readonly host: SessionsHost,
		/** Whether a webview shows the chat. */
		private readonly isAttached: () => boolean,
		private readonly post: (message: ToWebview) => void,
	) {
		this.disposables.push(
			// A reopened session's history shows only when it was restored on purpose; otherwise the saved copy shows.
			service.client.onDidReplayEvent(event => this.replaying && this.applyReplayed(event)),
			service.client.onDidFailToReopen(({ sessionId, error }) => service.writeLog?.(`Could not reopen session ${sessionId}: ${error.message}`)),
		);
	}

	/** The session the chat is on: the agent's, or the one it had last while the agent is not ready. */
	current(): string | undefined {
		const state = this.service.client.state;
		return state.kind === 'ready' ? state.savedSessionId : this.lastSessionId;
	}

	/** The agent is ready on session `id`: when the conversation shown belongs to another, the chat says the agent does not remember it. */
	opened(id: string): void {
		if (this.lastSessionId && id !== this.lastSessionId && this.transcript.items.length) {
			this.addSessionLostNotice();
		}
		this.lastSessionId = id;
	}

	/** A saved conversation was shown, which belongs to session `sessionId`: the chat says so if the agent is on another. */
	shownConversation(sessionId: string | undefined): void {
		const state = this.service.client.state;
		if (state.kind === 'ready' && sessionId && state.savedSessionId !== sessionId) {
			this.addSessionLostNotice();
		}
		this.lastSessionId = state.kind === 'ready' ? state.savedSessionId : sessionId;
	}

	/** The chat moves to session `id` on purpose, or to a new one, so the switch does not read as the agent losing the session. */
	moveTo(id: string | undefined): void {
		this.lastSessionId = id;
	}

	/** The conversation the next prompt gives a new session, if any. */
	get carriedConversation(): string | undefined {
		return this.carried;
	}

	/** Gives the next prompt `conversation`, which a new session would not otherwise have, as session `title`; returns whether there was any. */
	carry(title: string, conversation: readonly ConversationEntry[] | undefined): boolean {
		this.carried = conversation?.length ? carriedConversationNote(title, conversation) : undefined;
		return !!this.carried;
	}

	/** The prompt that carried `carried` was answered: the session has the conversation now. */
	delivered(carried: string | undefined): void {
		if (carried === this.carried) {
			this.carried = undefined;
		}
	}

	/** A prompt was sent: a reopened session's replay is over. */
	stopReplay(): void {
		this.replaying = false;
	}

	/** The conversation was cleared: nothing is carried or replayed into it. */
	forgetConversation(): void {
		this.carried = undefined;
		this.replaying = false;
	}

	onMessage(message: SessionsMessage): void {
		switch (message.type) {
			case 'restoreSession':
				if (typeof message.id === 'string') {
					void this.restore(message.id);
				}
				break;
			case 'pickSession':
				void this.pick();
				break;
		}
	}

	/** Offers the newest saved sessions in an empty chat. Read after the view is up, so it never holds the chat back. */
	async postSessions(): Promise<void> {
		if (!this.options.savedSessions || !this.isAttached() || this.transcript.items.length) {
			return;
		}
		const [sessions, retention] = await Promise.all([this.savedSessions(), retentionNote()]);
		const now = Date.now();
		this.post({ type: 'sessions', total: sessions.length, retention, sessions: sessions.slice(0, shownSessions).map(s => ({ id: s.id, title: s.title, detail: sessionDetail(s, now) })) });
	}

	/** Every saved session for the folder, in a quick pick; the one picked opens here. */
	async pick(): Promise<void> {
		if (!this.options.savedSessions || this.host.isBusy()) {
			return;
		}
		const now = Date.now();
		const picks = this.savedSessions().then(sessions => sessions.map(s => ({ label: s.title, description: sessionDetail(s, now), session: s })));
		const pick = await vscode.window.showQuickPick(picks, {
			title: vscode.l10n.t("Restore a Gemini CLI Session"),
			placeHolder: `${vscode.l10n.t("Sessions saved for {0}, newest first.", path.basename(this.service.client.cwd))} ${await retentionNote()}`,
			matchOnDescription: true,
		});
		if (pick) {
			await this.restore(pick.session.id, pick.session.title);
		}
	}

	/**
	 * Reopens saved session `id` here: the agent picks it up where it left
	 * off and replays it into the chat. A conversation already here is
	 * replaced, after asking; it stays saved by the CLI.
	 */
	async restore(id: string, title?: string, again = false): Promise<void> {
		if (this.host.isBusy()) {
			return;
		}
		title ??= (await this.savedSessions()).find(s => s.id === id)?.title ?? id;
		if (this.transcript.items.length && !again) {
			const restore = vscode.l10n.t("Restore");
			const answer = await vscode.window.showWarningMessage(
				vscode.l10n.t("Restore \"{0}\" in this chat?", title),
				{ modal: true, detail: vscode.l10n.t("The conversation here is replaced. The Gemini CLI keeps it, so you can restore it again later.") },
				restore);
			if (answer !== restore) {
				return;
			}
		}
		this.host.setBusy(true);
		let restored = false;
		let reason: string | undefined;
		try {
			await this.service.ensureReady();
			this.host.clearConversation();
			this.transcript.addNotice(vscode.l10n.t("Restored \"{0}\" from the Gemini CLI.", title));
			this.replaying = true;
			// So the switch does not read as the agent losing the session.
			this.lastSessionId = id;
			let failure: AgentErrorInfo | undefined;
			const failed = this.service.client.onDidFailToReopen(e => e.sessionId === id && (failure = e.error));
			try {
				restored = await this.service.client.loadSession(id);
				if (!restored && failure && isPassingFailure(failure)) {
					// Once more after a restart or a start: those pass.
					failure = undefined;
					await this.service.ensureReady();
					restored = await this.service.client.loadSession(id);
				}
			} finally {
				failed.dispose();
			}
			if (restored) {
				this.host.restored(title);
			} else {
				reason = failure && reopenFailureText(failure);
			}
		} catch (err) {
			reason = errorMessage(err);
		} finally {
			this.host.setBusy(false);
		}
		if (!restored) {
			this.replaying = false;
			this.transcript.clear();
			const conversation = await readCliConversation(this.service.client.cwd, id).catch(() => undefined);
			if (conversation?.length) {
				// The CLI can't take it up, but the conversation is still in its file: show it, and carry it into the new session.
				for (const entry of conversation) {
					if (entry.role === 'user') {
						this.transcript.addReplayedPrompt(entry.text);
					} else {
						this.transcript.apply({ kind: 'text', role: 'agent', text: entry.text });
					}
				}
				this.transcript.addNotice(reason
					? vscode.l10n.t("The agent could not reopen \"{0}\": {1} It continues in a new session that is given this conversation.", title, reason)
					: vscode.l10n.t("The agent could not reopen \"{0}\". It continues in a new session that is given this conversation.", title), 'error');
				this.carry(title, conversation);
			} else {
				this.transcript.addNotice(reason
					? vscode.l10n.t("The agent could not reopen \"{0}\": {1}", title, reason)
					: vscode.l10n.t("The agent could not reopen \"{0}\", so this chat starts afresh.", title), 'error');
			}
			const retry = vscode.l10n.t("Try Again");
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not restore \"{0}\".", title), retry).then(choice => {
				if (choice === retry) {
					void this.restore(id, title, true);
				}
			});
		}
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	/** The saved sessions this chat may reopen: not its own, nor one another chat has open. */
	private async savedSessions(): Promise<CliSession[]> {
		const exclude = new Set(this.options.savedSessions?.inUse());
		const state = this.service.client.state;
		if (state.kind === 'ready') {
			exclude.add(state.savedSessionId);
		}
		return listCliSessions(this.service.client.cwd, { exclude }).catch(() => []);
	}

	/** A message of a reopened session as it replays: the CLI's own context and commands are left out. */
	private applyReplayed(event: ChatEvent): void {
		if (event.kind === 'text' && event.role === 'user') {
			// A message replays without the notes sent with it: a steering note, and reactions' notes, which come back as reaction lines.
			const { text: rest, reactions } = withoutReactionNotes(withoutSteeringNote(event.text));
			const text = rest.trim();
			if (isPrompt(text) || reactions.length) {
				this.transcript.addReplayedPrompt(isPrompt(text) ? text : '', reactions);
			}
			return;
		}
		this.transcript.apply(event);
	}

	private addSessionLostNotice(): void {
		this.transcript.addNotice(vscode.l10n.t("The agent could not continue the earlier session, so it does not remember the messages above."));
	}
}

/** /resume, in chats that offer saved sessions. */
export function resumeCommand(): SlashCommand {
	return { name: 'resume', description: vscode.l10n.t("Restore a saved Gemini CLI session for this folder"), source: 'app' };
}

/** How long the CLI keeps saved chats, from the user's own settings (Project Helpers changes it). */
async function retentionNote(): Promise<string> {
	const { keepChats } = readCliPreferences(await readSettingsFile(path.join(geminiDir(), 'settings.json')));
	if (keepChats === keepChatsForever) {
		return vscode.l10n.t("They are kept until you delete them.");
	}
	const period = keepChatsPeriod(keepChats);
	if (!period) {
		return '';
	}
	const { count, unit } = period;
	const text = unit === 'h' ? vscode.l10n.t("{0} hours", count)
		: unit === 'd' ? (count === 1 ? vscode.l10n.t("1 day") : vscode.l10n.t("{0} days", count))
			: unit === 'w' ? (count === 1 ? vscode.l10n.t("1 week") : vscode.l10n.t("{0} weeks", count))
				: count === 1 ? vscode.l10n.t("1 month") : vscode.l10n.t("{0} months", count);
	return vscode.l10n.t("The Gemini CLI deletes them after {0}; Project Helpers can change that.", text);
}

/** "3 prompts · 2h" */
function sessionDetail(session: CliSession, now: number): string {
	const prompts = session.messages === 1 ? vscode.l10n.t("1 prompt") : vscode.l10n.t("{0} prompts", session.messages);
	return `${prompts} \u00b7 ${relativeTime(session.updatedAt, now)}`;
}

/** Why a saved session could not be reopened, in plain words, as a sentence. */
function reopenFailureText(error: AgentErrorInfo): string {
	switch (reopenFailure(error)) {
		case 'signedOut':
			return vscode.l10n.t("Sign-in expired. Sign in again, then try again.");
		case 'restarted':
			return vscode.l10n.t("The agent restarted while reopening it.");
		case 'inUse':
			return vscode.l10n.t("Another chat has it open.");
		case 'gone':
			return vscode.l10n.t("The Gemini CLI no longer has it; its cleanup may have removed it.");
		case 'otherSession':
			return vscode.l10n.t("The agent opened a different session.");
		case 'other': {
			const message = error.message.trim();
			return /[.!?]$/.test(message) ? message : `${message}.`;
		}
	}
}
