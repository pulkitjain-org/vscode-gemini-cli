/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentConnection } from '../acp/agentConnection';
import { spawnAgent } from '../acp/agentProcess';
import { getAgentCommand, getWorkspaceCwd } from './configuration';

const initializeTimeoutMs = 30_000;

/**
 * Starts `gemini --acp`, runs the unauthenticated `initialize` handshake,
 * reports what the agent advertises, and stops the process again.
 */
export async function checkAgent(log: vscode.LogOutputChannel): Promise<void> {
	const command = getAgentCommand();
	log.info(`Starting agent: ${command.command} ${command.args.join(' ')}`);

	const child = spawnAgent(command, getWorkspaceCwd());
	child.stderr.on('data', (chunk: Buffer) => log.info(`[agent] ${chunk.toString().trimEnd()}`));
	const exited = new Promise<never>((_, reject) => {
		child.once('error', reject);
		child.once('exit', code => reject(new Error(`Agent exited with code ${code}`)));
	});

	const connection = new AgentConnection(child.stdin, child.stdout, {
		sessionUpdate: () => { },
		requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`No response to initialize within ${initializeTimeoutMs / 1000}s`)), initializeTimeoutMs);
		});
		const info = await Promise.race([connection.initialize(), exited, timeout]);
		const agent = info.agentInfo ? `${info.agentInfo.name} ${info.agentInfo.version}` : 'unknown agent';
		const authMethods = (info.authMethods ?? []).map(m => m.id).join(', ') || 'none';
		log.info(`Connected to ${agent}, protocol ${info.protocolVersion}, auth methods: ${authMethods}`);
		vscode.window.showInformationMessage(vscode.l10n.t("Connected to {0} (ACP protocol {1}).", agent, info.protocolVersion));
	} catch (err) {
		log.error(err instanceof Error ? err : String(err));
		const showLog = vscode.l10n.t("Show Log");
		const choice = await vscode.window.showErrorMessage(vscode.l10n.t("Could not connect to the Gemini CLI: {0}", err instanceof Error ? err.message : String(err)), showLog);
		if (choice === showLog) {
			log.show();
		}
	} finally {
		clearTimeout(timer);
		connection.dispose();
		child.kill();
	}
}
