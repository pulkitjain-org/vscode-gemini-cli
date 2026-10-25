/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../acp/errors';
import { readSettingsFile, updateSettingsFile } from '../acp/projectSettings';
import { findDocker, teamImages } from '../acp/teamContainers';
import { readTeamServers, removeTeamServers, TakeoverServer } from '../acp/teamTakeover';
import { configSection } from './configuration';
import { runTeamServersSetting, TeamConnections } from './teamConnections';

/**
 * Take Over Both Servers, from Connections: the Jira and GitLab servers that `file` (a repository's
 * .gemini/settings.json) runs in the CLI become the team tools' own. Each account is connected, its
 * token going to the keychain (from the environment GeminiCode started in, or asked for); then the
 * two entries leave the file, with their exception to the CLI's token redaction, and the team tools
 * run the same servers in Docker. Nothing in the file changes until both accounts are connected.
 * Returns whether the file changed.
 */
export async function takeOverTeamServers(connections: TeamConnections, file: string, log: vscode.LogOutputChannel): Promise<boolean> {
	const plan = readTeamServers(await readSettingsFile(file), process.env);
	const servers = [plan.jira, plan.gitlab].filter((s): s is TakeoverServer => !!s);
	if (!servers.length) {
		return false;
	}
	const docker = findDocker();
	const names = servers.map(s => s.name).join(vscode.l10n.t(" and "));
	const takeOver = vscode.l10n.t("Take Over");
	const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Take over {0} from {1}?", names, path.basename(path.dirname(path.dirname(file)))), {
		modal: true,
		detail: [
			vscode.l10n.t("GeminiCode keeps each server's token in the macOS keychain, then removes {0} from {1}, with their tokens' exception to the CLI's redaction, so an agent's shell can no longer read them.", names, path.join(path.basename(path.dirname(file)), path.basename(file))),
			docker
				? vscode.l10n.t("The team tools then run mcp-atlassian {0} and gitlab-mcp {1} in Docker themselves, at pinned versions, and agents see GeminiCode's team tools instead of each server's own.", teamImages.jira.tag, teamImages.gitlab.tag)
				: vscode.l10n.t("Docker isn't installed, so the team tools call Jira and GitLab directly. Turn on gemini.team.runTeamServers once it is."),
			vscode.l10n.t("The file is shared with your team: commit the change, or ask whoever owns it."),
		].join('\n\n'),
	}, takeOver);
	if (answer !== takeOver) {
		return false;
	}

	for (const server of servers) {
		const tool = server === plan.jira ? 'jira' : 'gitlab';
		if (!server.token && connections.connected.has(tool)) {
			continue; // Already connected here; its keychain token stays.
		}
		const account = connections.accountOf(tool);
		const url = server.url ?? account?.url ?? await ask(tool === 'jira' ? vscode.l10n.t("Jira site") : vscode.l10n.t("GitLab address"), tool === 'jira' ? 'https://acme.atlassian.net' : 'https://gitlab.example.com');
		const email = tool === 'jira' ? server.email ?? account?.email ?? await ask(vscode.l10n.t("Your Jira account email"), 'you@example.com') : undefined;
		const token = server.token ?? await ask(vscode.l10n.t("{0} token", tool === 'jira' ? 'Jira' : 'GitLab'), '', true, server.tokenEnv
			? vscode.l10n.t("Paste the token {0} holds in your shell. It goes to the macOS keychain.", `$${server.tokenEnv}`)
			: vscode.l10n.t("Paste the token. It goes to the macOS keychain."));
		if (!url || (tool === 'jira' && !email) || !token) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Nothing was taken over. {0} still runs both servers.", file));
			return false;
		}
		try {
			await connections.connect(tool, { url, ...email ? { email } : {}, token });
		} catch (err) {
			void vscode.window.showErrorMessage(vscode.l10n.t("Couldn't connect {0}: {1} Nothing in {2} changed.", tool === 'jira' ? 'Jira' : 'GitLab', errorMessage(err), path.basename(file)));
			return false;
		}
	}

	let removed: string[] = [];
	const rewritten = await updateSettingsFile(file, settings => removed = removeTeamServers(settings, plan)).catch(err => {
		log.warn(`Couldn't rewrite ${file}: ${errorMessage(err)}`);
		return false;
	});
	if (docker) {
		await vscode.workspace.getConfiguration(configSection).update(runTeamServersSetting, true, vscode.ConfigurationTarget.Global);
	}
	log.info(`Took over ${names} from ${file}${rewritten ? `; removed ${removed.join(', ')}` : '; the file was left as it is'}`);
	if (!rewritten) {
		void vscode.window.showWarningMessage(vscode.l10n.t("GeminiCode keeps the tokens now, but can't rewrite {0} because it isn't valid JSON. Remove {1} from mcpServers there, and their tokens from security.environmentVariableRedaction.allowed.", file, names));
		const document = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(document);
		return false;
	}
	const tokens = servers.map(s => s.tokenEnv).filter((n): n is string => !!n).map(n => `$${n}`).join(', ');
	void vscode.window.showInformationMessage(tokens
		? vscode.l10n.t("GeminiCode now keeps the Jira and GitLab tokens and runs the servers itself. You can remove {0} from your shell profile.", tokens)
		: vscode.l10n.t("GeminiCode now keeps the Jira and GitLab tokens and runs the servers itself."));
	return true;
}

async function ask(title: string, placeHolder: string, password = false, prompt?: string): Promise<string | undefined> {
	const value = await vscode.window.showInputBox({ title, placeHolder, password, ignoreFocusOut: true, ...prompt ? { prompt } : {} });
	return value?.trim() || undefined;
}
