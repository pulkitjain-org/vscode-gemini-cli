/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The "/" menu, and what a command typed in the composer sends: the agent's
// own commands go as typed, a team command as its prompt, and a skill as a
// request to load it.

import * as vscode from 'vscode';
import type { AgentClient } from '../../acp/agentClient';
import type { ChatTranscript } from '../../acp/chatTranscript';
import { skillPrompt } from '../../acp/skills';
import { mergeCommands, parseInvocation, SlashCommand } from '../../acp/slashCommands';
import { expandTeamCommandWithInjections } from '../../acp/teamCommandExpansion';
import type { ToWebview } from '../chatProtocol';
import { teamCommandHost } from '../teamCommandHost';
import { skills, teamCommands } from '../teamCommands';

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
	) {
		// Keeps an open "/" menu current; the agent lists its commands just after a session opens.
		this.listener = client.onDidChangeCommands(() => isAttached() && void this.postCommands());
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
		// The agent's own command wins over one of GeminiCode's with the same name.
		this.post({ type: 'commands', commands: [...commands, ...this.appCommands.filter(app => !commands.some(c => c.name === app.name))] });
	}
}
