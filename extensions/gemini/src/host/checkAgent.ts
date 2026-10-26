/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Check Agent, in the on-demand bundle (src/onDemand.ts) with the CLI
// contract it reads: what it needs of the extension bundle, the agent's
// command and the ACP code with its SDK, comes in through `CheckAgentDeps`.

import * as vscode from 'vscode';
import type { AgentConnection } from '../acp/agentConnection';
import { type AgentCommand, spawnAgent } from '../acp/agentProcess';
import { checkCliContract, contractLine, type CliContractCheck, type CliContractMismatch } from '../acp/cli/contract';
import { errorMessage } from '../acp/errors';

const initializeTimeoutMs = 30_000;

export interface CheckAgentDeps {
	readonly command: AgentCommand;
	readonly cwd: string;
	/** The extension bundle's ACP code. */
	readonly connection: () => Promise<typeof AgentConnection>;
	/** The CLI's entry file, for the contract check. */
	readonly findCliEntry: () => Promise<string | undefined>;
}

/**
 * Starts `gemini --acp`, runs the unauthenticated `initialize` handshake,
 * reports what the agent advertises, and stops the process again. When
 * something GeminiCode reads from the CLI outside ACP doesn't match
 * (`checkCliContract`), one more line says what that affects.
 */
export async function checkAgent(log: vscode.LogOutputChannel, { command, cwd, connection: connectionClass, findCliEntry }: CheckAgentDeps): Promise<void> {
	log.info(`Starting agent: ${command.command} ${command.args.join(' ')}`);

	const child = spawnAgent(command, cwd);
	child.stderr.on('data', (chunk: Buffer) => log.info(`[agent] ${chunk.toString().trimEnd()}`));
	const exited = new Promise<never>((_, reject) => {
		child.once('error', reject);
		child.once('exit', code => reject(new Error(`Agent exited with code ${code}`)));
	});

	const AgentConnection = await connectionClass();
	const connection = new AgentConnection(child.stdin, child.stdout, {
		sessionUpdate: () => { },
		requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Read alongside the handshake: about 0.4 s of reading the CLI's bundle.
	const contract = findCliEntry().then(entry => entry ? checkCliContract(entry) : [], () => [] as CliContractMismatch[]);
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`No response to initialize within ${initializeTimeoutMs / 1000}s`)), initializeTimeoutMs);
		});
		const info = await Promise.race([connection.initialize(), exited, timeout]);
		const agent = info.agentInfo ? `${info.agentInfo.name} ${info.agentInfo.version}` : 'unknown agent';
		const authMethods = (info.authMethods ?? []).map(m => m.id).join(', ') || 'none';
		log.info(`Connected to ${agent}, protocol ${info.protocolVersion}, auth methods: ${authMethods}`);
		void vscode.window.showInformationMessage(vscode.l10n.t("Connected to {0} (ACP protocol {1}).", agent, info.protocolVersion));
		void reportContract(await contract, log);
	} catch (err) {
		log.error(err instanceof Error ? err : String(err));
		const showLog = vscode.l10n.t("Show Log");
		const choice = await vscode.window.showErrorMessage(vscode.l10n.t("Could not connect to the Gemini CLI: {0}", errorMessage(err)), showLog);
		if (choice === showLog) {
			log.show();
		}
	} finally {
		clearTimeout(timer);
		connection.dispose();
		child.kill();
	}
}

/** The one line for what doesn't match, with Show Log; nothing when everything matches. */
async function reportContract(mismatches: readonly CliContractMismatch[], log: vscode.LogOutputChannel): Promise<void> {
	for (const mismatch of mismatches) {
		log.warn(`The Gemini CLI doesn't have what GeminiCode reads for ${mismatch.area}: ${mismatch.detail}`);
	}
	const sentences: Record<CliContractCheck, string> = {
		bundle: vscode.l10n.t("GeminiCode can't read this CLI's files, so inline edit, MCP server problems, performance traces and saved sessions may not work."),
		oauthClient: vscode.l10n.t("Inline edit can't read this CLI's sign-in settings, so it uses the slower agent path."),
		flashModels: vscode.l10n.t("Inline edit can't read this CLI's model names, so it uses the slower agent path."),
		debugLog: vscode.l10n.t("GeminiCode can't read this CLI's debug log, so MCP servers that fail to start aren't reported."),
		mcpLogLines: vscode.l10n.t("GeminiCode can't read this CLI's debug log, so MCP servers that fail to start aren't reported."),
		telemetryEnv: vscode.l10n.t("Record Performance Trace can't read this CLI's telemetry, so its traces may be empty."),
		traceEvents: vscode.l10n.t("Record Performance Trace can't read this CLI's telemetry, so its traces may be empty."),
		sessionFiles: vscode.l10n.t("GeminiCode can't find this CLI's session files, so picking up a CLI session and Rewind may not work."),
	};
	const line = contractLine(mismatches, sentences);
	if (!line) {
		return;
	}
	const showLog = vscode.l10n.t("Show Log");
	if (await vscode.window.showWarningMessage(line, showLog) === showLog) {
		log.show();
	}
}
