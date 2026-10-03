/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ApprovalPolicy, prepareAdminPolicy } from '../acp/adminPolicy';
import { AgentCommand, cliHeapSizeMb, resolveAgentCommand } from '../acp/agentProcess';
import { CliResolution, resolveCli } from '../acp/cliResolution';
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

let managedCliDir: string | undefined;
let adminPolicyDir: string | undefined;

/** Where GeminiCode keeps its own CLI copies and the policy file it passes to the CLI; set once on activation. */
export function setStorageDirs(dirs: { readonly managedCli: string; readonly adminPolicy: string }): void {
	managedCliDir = dirs.managedCli;
	adminPolicyDir = dirs.adminPolicy;
}

/** The approval settings, which an admin can lock through policy (plan Phase 4, policy-enforcement). */
export function getApprovalPolicy(): ApprovalPolicy {
	const config = vscode.workspace.getConfiguration(configSection);
	return {
		allowAutoEdit: config.get<boolean>('approval.allowAutoEdit', true),
		allowYolo: config.get<boolean>('approval.allowYolo', false),
		allowShell: config.get<boolean>('tools.allowShell', true),
	};
}

/** The settings that change how the agent process starts; a change restarts it. */
export const agentLaunchSettings = ['cliPath', 'cli.version', 'projectId', 'approval.allowAutoEdit', 'approval.allowYolo', 'tools.allowShell'].map(key => `${configSection}.${key}`);

export function getManagedCliDir(): string | undefined {
	return managedCliDir;
}

/** Which CLI the next agent process runs (plan Phase 3, runtime-resolution). */
export function getCliResolution(): CliResolution {
	const config = vscode.workspace.getConfiguration(configSection);
	return resolveCli({
		cliPath: config.get<string>('cliPath'),
		version: config.get<string>('cli.version'),
		managedDir: managedCliDir ?? '',
	});
}

/** How to run the CLI, with the resolved project injected into its environment. */
export function getAgentCommand(options: { interactive?: boolean; cli?: CliResolution } = {}): AgentCommand {
	return resolveAgentCommand({
		cliPath: (options.cli ?? getCliResolution()).cliPath,
		execPath: process.execPath,
		env: buildAgentEnv(process.env, getProjectSettings().resolved?.projectId),
		platform: process.platform,
		interactive: options.interactive,
		heapSizeMb: options.interactive ? undefined : cliHeapSizeMb(readCliSettings(), os.totalmem()),
		extraArgs: adminPolicyDir ? prepareAdminPolicy(adminPolicyDir, getApprovalPolicy()) : [],
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
