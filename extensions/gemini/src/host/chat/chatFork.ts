/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Fork Agent, from the chat's side: the Fork dialog and what the fork starts
// with. A fork is a new agent whose session is a copy of this one's (whole,
// or compacted with a summary) or that is given its conversation; the Agents
// pane (`src/host/agents/agentForks.ts`) makes its branch and starts it.
// Fork from Here, on a reply, forks the chat as it was at the end of that
// reply, that is before the next prompt; while a turn runs, the fork leaves
// that turn out, since it isn't finished.

import * as vscode from 'vscode';
import type { ChatTranscript, ForkContext } from '../../acp/chatTranscript';
import { forkedItems, forkPointAfter, laterRepeats } from '../../acp/chatTurns';
import { carriedConversationNote, conversationOf, MessageRecord, readSessionMessages, readSessionTokens } from '../../acp/cliSessions';
import { errorMessage } from '../../acp/errors';
import { compactedMessages, compactSplit, estimateTokens, messagesBefore } from '../../acp/sessionSnapshot';
import type { SlashCommand } from '../../acp/slashCommands';
import type { ForkRequest, ForkView, FromWebview, ToWebview } from '../chatProtocol';
import type { ChatCompact } from './chatCompact';
import type { ChatControllerOptions, ChatHost } from './chatOptions';
import type { ChatSessions } from './chatSessions';

export type ForkMessage = Extract<FromWebview, { readonly type: 'requestFork' | 'fork' | 'forkAction' }>;

/** Above this many tokens, the dialog starts on Compacted rather than Whole session. */
const compactByDefaultAbove = 100_000;

/** About how many tokens a compacted session's summary adds, for the estimate shown before it is written. */
const summaryTokens = 1_500;

/** What forking needs of its chat. */
export interface ForkHost {
	isBusy(): boolean;
	/** The agent's name. */
	title(): string;
}

/** The parent's session as it stands for a fork: its messages before the fork's point, and what the fork leaves out. */
interface ForkSource {
	readonly messages: readonly MessageRecord[];
	/** The chat's items the fork shows. */
	readonly items: ReturnType<typeof forkedItems> & {};
	/** The prompt item the fork stops before, if any. */
	readonly before?: string;
}

export class ChatFork {

	constructor(
		private readonly service: Pick<ChatHost, 'client' | 'ensureReady'>,
		private readonly transcript: ChatTranscript,
		private readonly sessions: ChatSessions,
		private readonly compacting: ChatCompact,
		private readonly options: Pick<ChatControllerOptions, 'fork'>,
		private readonly host: ForkHost,
		private readonly post: (message: ToWebview) => void,
	) { }

	/** Whether this chat can fork. */
	get available(): boolean {
		return !!this.options.fork;
	}

	onMessage(message: ForkMessage): void {
		switch (message.type) {
			case 'requestFork':
				void this.open(message.turnEnd);
				break;
			case 'fork':
				void this.fork(message.fork);
				break;
			case 'forkAction':
				this.options.fork?.action(message.agent, message.action);
				break;
		}
	}

	/** Opens the Fork dialog, for the whole chat or (Fork from Here) for the chat up to the reply that ends at `turnEnd`. */
	async open(turnEnd?: string): Promise<void> {
		const forker = this.options.fork;
		if (!forker) {
			return;
		}
		try {
			const point = turnEnd ? forkPointAfter(this.transcript.items, turnEnd) : undefined;
			if (turnEnd && !point) {
				return;
			}
			const itemId = point?.before;
			const source = await this.source(itemId);
			const place = await forker.place();
			const busy = this.host.isBusy();
			const whole = Math.max(estimateTokens(source.messages), source.before ? 0 : (await this.contextTokens()) ?? 0);
			const compact = busy ? undefined : estimateTokens(compactedMessages(source.messages, '', compactSplit(source.messages))) + summaryTokens;
			const conversation = Math.round(carriedConversationNote(this.host.title(), conversationOf(source.messages)).length / 4);
			const view: ForkView = {
				parentTitle: this.host.title(),
				title: vscode.l10n.t("{0} (fork)", this.host.title()),
				...(point?.answered !== undefined ? { fromHere: { ...(itemId ? { before: itemId } : {}), answered: point.answered } } : {}),
				tokens: { whole, conversation, ...(compact !== undefined ? { compact } : {}) },
				...(compact === undefined ? { compactWhy: vscode.l10n.t("Compacted waits for the agent to finish its turn.") } : {}),
				context: defaultContext(whole, compact),
				git: place.git,
				...(place.branch ? { parentBranch: place.branch } : {}),
				branch: place.forkBranch,
				branchFollowsName: !place.ownBranch,
				...(place.branchOnly ? { branchOnly: true } : {}),
			};
			this.post({ type: 'openFork', fork: view });
		} catch (err) {
			this.transcript.addNotice(vscode.l10n.t("Couldn't fork this agent: {0}", errorMessage(err)), 'error');
		}
	}

	/** Makes the fork the dialog asked for. */
	private async fork(request: ForkRequest): Promise<void> {
		const forker = this.options.fork;
		if (!forker || !request.title.trim()) {
			return;
		}
		try {
			if (request.context === 'compact' && this.host.isBusy()) {
				throw new Error(vscode.l10n.t("Compacted waits for the agent to finish its turn."));
			}
			// Read again: the chat may have moved on while the dialog was open.
			const source = await this.source(request.before);
			const messages = request.context === 'whole' ? source.messages
				: request.context === 'compact' ? compactedMessages(source.messages, await this.compacting.summaryForFork(), compactSplit(source.messages))
					: undefined;
			await forker.start({
				request: { ...request, title: request.title.trim() },
				...(messages ? { messages } : { conversation: conversationOf(source.messages) }),
				items: source.items,
				onStarted: (agent, branch) => this.transcript.addFork({ role: 'child', agent, title: request.title.trim(), context: request.context, ...(branch ? { branch } : {}) }),
			});
		} catch (err) {
			this.transcript.addNotice(vscode.l10n.t("Couldn't fork this agent: {0}", errorMessage(err)), 'error');
		}
	}

	/** The session and chat a fork starts from: before prompt `itemId` when given, else before the turn that is running, if one is. */
	private async source(itemId: string | undefined): Promise<ForkSource> {
		await this.service.ensureReady();
		const items = this.transcript.items;
		const running = this.host.isBusy() ? lastPromptId(items) : undefined;
		const before = itemId ?? running;
		const session = this.sessions.current();
		const saved = session ? await readSessionMessages(this.service.client.cwd, session) : undefined;
		const shown = forkedItems(items, before);
		if (!saved || !shown) {
			throw new Error(vscode.l10n.t("The Gemini CLI has no saved session for this chat yet."));
		}
		if (before === undefined) {
			return { messages: saved.messages, items: shown };
		}
		const index = items.findIndex(item => item.id === before);
		const prompt = items[index];
		const messages = prompt?.kind === 'user' ? messagesBefore(saved.messages, prompt.text, laterRepeats(items, index)) : undefined;
		if (!messages) {
			throw new Error(vscode.l10n.t("That message is not in the Gemini CLI's saved session, for example because it ran a team command or skill."));
		}
		return { messages, items: shown, before };
	}

	/** The context's use the CLI saved, which counts what the session sends besides its messages. */
	private async contextTokens(): Promise<number | undefined> {
		const session = this.sessions.current();
		return session ? (await readSessionTokens(this.service.client.cwd, session).catch(() => undefined))?.context : undefined;
	}
}

/** /fork, in chats that can fork. */
export function forkCommand(): SlashCommand {
	return { name: 'fork', description: vscode.l10n.t("Start a new agent from this conversation, on its own branch"), source: 'app' };
}

/** Whole session while it is small, else Compacted when it can be made now. */
function defaultContext(whole: number, compact: number | undefined): ForkContext {
	return whole > compactByDefaultAbove && compact !== undefined ? 'compact' : 'whole';
}

function lastPromptId(items: ChatTranscript['items']): string | undefined {
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i].kind === 'user') {
			return items[i].id;
		}
	}
	return undefined;
}
