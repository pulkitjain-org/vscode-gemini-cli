/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentCommand, cliHeapSizeMb, resolveAgentCommand } from '../acp/agentProcess';
import { buildAgentEnv } from '../acp/env';
import { ProjectIdProblem, ResolvedProjectId, resolveProjectId, validateProjectId } from '../acp/projectId';

export const configSection = 'gemini';

/** The org default project, from `geminiDefaultProjectId` in the app's product.json, if set. */
function readOrgDefaultProjectId(): string | undefined {
	try {
		const product = JSON.parse(readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8'));
		return typeof product.geminiDefaultProjectId === 'string' ? product.geminiDefaultProjectId : undefined;
	} catch {
		return undefined;
	}
}

const orgDefaultProjectId = readOrgDefaultProjectId();

export interface ProjectSettings {
	readonly resolved: ResolvedProjectId | undefined;
	readonly problem: ProjectIdProblem | undefined;
}

export function getProjectSettings(): ProjectSettings {
	const inspected = vscode.workspace.getConfiguration(configSection).inspect<string>('projectId');
	const resolved = resolveProjectId({
		workspace: inspected?.workspaceFolderValue ?? inspected?.workspaceValue,
		user: inspected?.globalValue,
		orgDefault: orgDefaultProjectId,
		env: process.env,
	});
	return { resolved, problem: resolved && validateProjectId(resolved.projectId) };
}

export function getWorkspaceCwd(): string {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

/** How to run the CLI, with the resolved project injected into its environment. */
export function getAgentCommand(options: { interactive?: boolean } = {}): AgentCommand {
	return resolveAgentCommand({
		cliPath: vscode.workspace.getConfiguration(configSection).get<string>('cliPath'),
		execPath: process.execPath,
		env: buildAgentEnv(process.env, getProjectSettings().resolved?.projectId),
		platform: process.platform,
		interactive: options.interactive,
		heapSizeMb: options.interactive ? undefined : cliHeapSizeMb(readCliSettings(), os.totalmem()),
	});
}

function readCliSettings(): string | undefined {
	const home = process.env.GEMINI_CLI_HOME || path.join(os.homedir(), '.gemini');
	try {
		return readFileSync(path.join(home, 'settings.json'), 'utf8');
	} catch {
		return undefined;
	}
}
