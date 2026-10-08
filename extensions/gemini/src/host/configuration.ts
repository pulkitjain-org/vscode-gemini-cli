/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ApprovalPolicy, prepareAdminPolicy } from '../acp/adminPolicy';
import { AgentCommand, cliHeapSizeMb, includeDirectoryArgs, resolveAgentCommand } from '../acp/agentProcess';
import { CliResolution, resolveCli } from '../acp/cliResolution';
import { buildAgentEnv } from '../acp/env';
import { ProjectIdProblem, ResolvedProjectId, resolveProjectId, validateProjectId } from '../acp/projectId';

export const configSection = 'gemini';

/** GeminiCode's own fields in the app's product.json. */
export interface GeminiProductInfo {
	/** The org default project (`geminiDefaultProjectId`), set by each build. */
	readonly defaultProjectId?: string;
	/** GeminiCode's release version (`geminiCodeVersion`), stamped by the release build; a dev build has none. */
	readonly version?: string;
	/** The download page (`geminiCodeDownloadUrl`). */
	readonly downloadPageUrl?: string;
	/** Where to file an issue (`reportIssueUrl`). */
	readonly reportIssueUrl?: string;
}

function readProductInfo(): GeminiProductInfo {
	try {
		const product = JSON.parse(readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8'));
		const field = (name: string) => typeof product[name] === 'string' && product[name] ? product[name] as string : undefined;
		return { defaultProjectId: field('geminiDefaultProjectId'), version: field('geminiCodeVersion'), downloadPageUrl: field('geminiCodeDownloadUrl'), reportIssueUrl: field('reportIssueUrl') };
	} catch {
		return {};
	}
}

export const productInfo = readProductInfo();

/** The project ID in effect; a problem is only possible when there is one. */
export type ProjectSettings =
	| { readonly resolved: undefined; readonly problem: undefined }
	| { readonly resolved: ResolvedProjectId; readonly problem: ProjectIdProblem | undefined };

export function getProjectSettings(): ProjectSettings {
	const inspected = vscode.workspace.getConfiguration(configSection).inspect<string>('projectId');
	const resolved = resolveProjectId({
		workspace: inspected?.workspaceFolderValue ?? inspected?.workspaceValue,
		user: inspected?.globalValue,
		orgDefault: productInfo.defaultProjectId,
		env: process.env,
	});
	return resolved ? { resolved, problem: validateProjectId(resolved.projectId) } : { resolved, problem: undefined };
}

export function getWorkspaceCwd(): string {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

let managedCliDir: string | undefined;
let bundledCliDir: string | undefined;
let adminPolicyDir: string | undefined;

/** Where GeminiCode keeps its own CLI copies, the copy shipped with the app, and the policy file it passes to the CLI; set once on activation. */
export function setStorageDirs(dirs: { readonly managedCli: string; readonly bundledCli: string; readonly adminPolicy: string }): void {
	managedCliDir = dirs.managedCli;
	bundledCliDir = dirs.bundledCli;
	adminPolicyDir = dirs.adminPolicy;
}

/** The approval settings, which an admin can lock through policy. */
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

/** Which CLI the next agent process runs. */
export function getCliResolution(): CliResolution {
	const config = vscode.workspace.getConfiguration(configSection);
	return resolveCli({
		cliPath: config.get<string>('cliPath'),
		version: config.get<string>('cli.version'),
		managedDir: managedCliDir ?? '',
		bundledDir: bundledCliDir,
	});
}

/** How to run the CLI, with the resolved project injected into its environment. */
/** `subcommand` runs the interactive CLI with those arguments instead, such as `extensions install <source>`. */
export function getAgentCommand(options: { interactive?: boolean; cli?: CliResolution; subcommand?: readonly string[] } = {}): AgentCommand {
	return resolveAgentCommand({
		cliPath: (options.cli ?? getCliResolution()).cliPath,
		execPath: process.execPath,
		env: buildAgentEnv(process.env, getProjectSettings().resolved?.projectId),
		platform: process.platform,
		interactive: options.interactive || !!options.subcommand,
		heapSizeMb: options.interactive || options.subcommand ? undefined : cliHeapSizeMb(readCliSettings(), os.totalmem()),
		extraArgs: options.subcommand ? [...options.subcommand] : [
			...adminPolicyDir ? prepareAdminPolicy(adminPolicyDir, getApprovalPolicy()) : [],
			...includeDirectoryArgs(workspaceFolderPaths()),
		],
	});
}

/** The window's folders on disk, in order. */
export function workspaceFolderPaths(): string[] {
	return (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
}

function readCliSettings(): string | undefined {
	// The CLI's launcher reads `$GEMINI_CLI_HOME/settings.json`, without the
	// `.gemini` level its other files use, to decide on the heap flag; match it.
	const home = process.env.GEMINI_CLI_HOME || path.join(os.homedir(), '.gemini');
	try {
		return readFileSync(path.join(home, 'settings.json'), 'utf8');
	} catch {
		return undefined;
	}
}
