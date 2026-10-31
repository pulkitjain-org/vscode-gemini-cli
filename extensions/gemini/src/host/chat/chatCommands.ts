/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The "/" menu, and what a command typed in the composer sends: the agent's
// own commands go as typed, a team command as its prompt, and a skill as a
// request to load it. GeminiCode's own commands (/resume, /compress, /plan
// and the rest) run in the feature that owns each.

import * as vscode from 'vscode';
import type { AgentClient } from '../../acp/agentClient';
import type { Attachment } from '../../acp/attachments';
import type { ChatTranscript } from '../../acp/chatTranscript';
import { skillPrompt } from '../../acp/skills';
import { mergeCommands, parseInvocation, SlashCommand } from '../../acp/slashCommands';
import { expandTeamCommandWithInjections } from '../../acp/teamCommandExpansion';
import type { ToWebview } from '../chatProtocol';
import { teamCommandHost } from '../teamCommandHost';
import { skills, teamCommands } from '../teamCommands';
import type { ChatCheckpoints } from './chatCheckpoints';
import { type ChatCompact, compactCommand } from './chatCompact';
import { type ChatFork, forkCommand } from './chatFork';
import type { ChatControllerOptions } from './chatOptions';
import type { ChatPlan } from './chatPlan';
import { type ChatSessions, chatCommand, resumeCommand } from './chatSessions';
import { type ChatUsage, contextCommand, statsCommand } from './chatUsage';
import { rewindCommand } from './cliCommands';

/** The chat's features GeminiCode's own commands run in. */
export interface CommandFeatures {
	readonly sessions: ChatSessions;
	readonly compacting: ChatCompact;
	readonly usage: ChatUsage;
	readonly checkpoints: ChatCheckpoints;
	readonly plan: ChatPlan;
	readonly forks: ChatFork;
}

export class ChatCommands implements vscode.Disposable {

	private readonly listener: { dispose(): void };

	constructor(
		private readonly client: AgentClient,
		private readonly transcript: ChatTranscript,
		/** GeminiCode's own commands this chat offers, such as /resume and /compact. */
		private readonly appCommands: readonly SlashCommand[],
		/** Whether a webview shows the chat. */
		isAttached: () => boolean,
		private readonly post: (message: ToWebview) => void,
		private readonly options: Pick<ChatControllerOptions, 'savedSessions'>,
		private readonly features: CommandFeatures,
		/** The CLI's folder trust dialog, for /permissions trust. */
		private readonly askToTrust: (folder: string) => Promise<boolean>,
	) {
		// Keeps an open "/" menu current; the agent lists its commands just after a session opens.
		this.listener = client.onDidChangeCommands(() => isAttached() && void this.postCommands());
	}

	/**
	 * Runs GeminiCode's own command when `text` is one (/resume and /chat,
	 * /compress, /context and /stats, /rewind, /permissions, /plan, /fork),
	 * the chat being idle; false when `text` is a prompt to send.
	 */
	async run(text: string, attachments: readonly Attachment[]): Promise<boolean> {
		const { sessions, compacting, usage, checkpoints, plan, forks } = this.features;
		if (this.options.savedSessions && (text.trim() === `/${resumeCommand().name}` || text.trim() === `/${chatCommand().name}`) && !attachments.length) {
			void sessions.pick();
			return true;
		}
		if (text.trim() === `/${compactCommand().name}` && !attachments.length) {
			void compacting.compact();
			return true;
		}
		if ((text.trim() === `/${contextCommand().name}` || text.trim() === `/${statsCommand().name}`) && !attachments.length) {
			void usage.show(true);
			return true;
		}
		if (text.trim() === `/${rewindCommand().name}` && !attachments.length) {
			void checkpoints.pickRewindCommand();
			return true;
		}
		if (/^\/permissions(\s+trust)?$/.test(text.trim()) && !attachments.length) {
			// The CLI's /permissions trust: the folder trust dialog.
			void this.askToTrust(this.client.cwd);
			return true;
		}
		const planMatch = /^\/plan(?:\s+(?<rest>.*))?$/s.exec(text.trim());
		if (planMatch && !attachments.length) {
			await plan.planCommand(planMatch.groups?.rest?.trim() ?? '');
			return true;
		}
		if (forks.available && text.trim() === `/${forkCommand().name}` && !attachments.length) {
			void forks.open();
			return true;
		}
		return false;
	}

	/**
	 * The text to send for `text`: a team command's prompt when it invokes
	 * one, a request to load the skill when it names one, else `text` itself. The agent's own commands go as typed, and win
	 * over a team command with the same name.
	 */
	async expand(text: string): Promise<string> {
		const invocation = parseInvocation(text);
		if (!invocation || this.client.commands.some(c => c.name === invocation.name)) {
			return text;
		}
		const command = (await teamCommands(this.client.cwd)).find(c => c.name === invocation.name);
		if (command) {
			const { text: prompt, problems } = await expandTeamCommandWithInjections(command, text, teamCommandHost(command.name, this.client.cwd));
			for (const problem of problems) {
				this.transcript.addNotice(vscode.l10n.t("/{0} could not include {1}", command.name, problem), 'error');
			}
			return prompt;
		}
		const skill = (await skills(this.client.cwd)).find(s => s.name === invocation.name);
		return skill ? skillPrompt(skill.name, invocation.args) : text;
	}

	dispose(): void {
		this.listener.dispose();
	}

	/** Every slash command this chat offers, for the "/" menu. */
	async postCommands(): Promise<void> {
		const [team, skillList] = await Promise.all([teamCommands(this.client.cwd), skills(this.client.cwd)]);
		// Team commands, then skills whose names they do not take.
		const teamNames = new Set(team.map(c => c.name));
		const local: SlashCommand[] = [...team, ...skillList.filter(s => !teamNames.has(s.name)).map(s => ({ name: s.name, description: s.description, source: 'skill' as const }))];
		const commands = mergeCommands(this.client.commands, local);
		// The CLI's names first, as GeminiCode offers them (/resume, /rewind, /plan, /compress, /stats), then GeminiCode's own,
		// then the commands the agent lists over ACP, then the team's commands and skills. The agent's own command wins over
		// one of GeminiCode's with the same name.
		this.post({ type: 'commands', commands: [...this.appCommands.filter(app => !commands.some(c => c.name === app.name)), ...commands] });
	}
}
