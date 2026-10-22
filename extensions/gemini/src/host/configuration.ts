/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ApprovalPolicy, prepareAdminPolicy } from '../acp/adminPolicy';
import { AgentCommand, cliHeapSizeMb, includeDirectoryArgs, resolveAgentCommand } from '../acp/agentProcess';
import { CliResolution, resolveCli } from '../acp/cliResolution';
import { buildAgentEnv } from '../acp/env';
import { ProjectIdProblem, ResolvedProjectId, resolveProjectId, validateProjectId } from '../acp/projectId';
import { indexServerName } from '../acp/indexMcp';
import { projectServerName } from '../acp/projectMcp';
import { allowlistWith, settingsFiles } from '../acp/projectToolsCheck';
import { confirmToolGroups, teamToolsServerName } from '../acp/teamTools';

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

/** GeminiCode's fields from product.json; empty until `loadProductInfo`, which activation awaits first. */
export const productInfo: { -readonly [K in keyof GeminiProductInfo]: GeminiProductInfo[K] } = {};

export async function loadProductInfo(): Promise<void> {
	try {
		const product = JSON.parse(await fs.readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8'));
		const field = (name: string) => typeof product[name] === 'string' && product[name] ? product[name] as string : undefined;
		Object.assign(productInfo, { defaultProjectId: field('geminiDefaultProjectId'), version: field('geminiCodeVersion'), downloadPageUrl: field('geminiCodeDownloadUrl'), reportIssueUrl: field('reportIssueUrl') });
	} catch {
		// A build without the file runs with no org defaults.
	}
}

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
		denyEnvironmentCommands: config.get<boolean>('tools.denyEnvironmentCommands', true),
		confirmTools: confirmToolGroups(),
	};
}

/** GeminiCode's own MCP servers, which the CLI always loads unless a settings file excludes them. */
export const ownServers = [teamToolsServerName, projectServerName, 'geminicode-browser', indexServerName];

/**
 * `--allowed-mcp-server-names` when `gemini.mcp.allowedServers` names any server: the CLI then
 * loads only those and GeminiCode's own, whatever a repository's settings file adds. Empty, the
 * CLI's own `mcp.allowed` applies, with GeminiCode's servers added when it leaves them out.
 */
async function allowedMcpServerArgs(): Promise<string[]> {
	const listed = vscode.workspace.getConfiguration(configSection).get<string[]>('mcp.allowedServers', []).filter(name => typeof name === 'string' && name.trim()).map(name => name.trim());
	const names = listed.length ? [...new Set([...ownServers, ...listed])] : await allowlistWith(ownServers, settingsFiles({ workspace: getWorkspaceCwd() }));
	return names ? ['--allowed-mcp-server-names', names.join(',')] : [];
}

/** The settings that change how the agent process starts; a change restarts it. */
export const agentLaunchSettings = ['cliPath', 'cli.version', 'projectId', 'approval.allowAutoEdit', 'approval.allowYolo', 'tools.allowShell', 'tools.denyEnvironmentCommands', 'mcp.allowedServers', 'agents.allWorkspaceFolders'].map(key => `${configSection}.${key}`);

export function getManagedCliDir(): string | undefined {
	return managedCliDir;
}

/** Which CLI the next agent process runs. */
export function getCliResolution(): Promise<CliResolution> {
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
/** Variables added to the agent's environment until cleared, such as the telemetry switches while a trace records. */
let agentEnvOverride: NodeJS.ProcessEnv = {};

export function setAgentEnvOverride(env: NodeJS.ProcessEnv): void {
	agentEnvOverride = { ...env };
}

/**
 * The command that starts the CLI. `ownFolderOnly` leaves out the window's other folders even when
 * `gemini.agents.allWorkspaceFolders` is on, for an agent that works somewhere else, as the benchmark's do.
 */
export async function getAgentCommand(options: { interactive?: boolean; cli?: CliResolution; subcommand?: readonly string[]; ownFolderOnly?: boolean; allowedMcpServers?: readonly string[] } = {}): Promise<AgentCommand> {
	const [cli, settings, policyArgs, mcpArgs] = await Promise.all([
		options.cli ?? getCliResolution(),
		readCliSettings(),
		adminPolicyDir && !options.subcommand ? prepareAdminPolicy(adminPolicyDir, getApprovalPolicy()) : [],
		// `allowedMcpServers` replaces the usual list, for measuring what each server costs (contextCost.ts).
		options.subcommand ? [] : options.allowedMcpServers ? ['--allowed-mcp-server-names', options.allowedMcpServers.join(',')] : allowedMcpServerArgs(),
	]);
	return resolveAgentCommand({
		cliPath: cli.cliPath,
		execPath: process.execPath,
		env: { ...buildAgentEnv(process.env, getProjectSettings().resolved?.projectId), ...options.interactive || options.subcommand ? {} : agentEnvOverride },
		platform: process.platform,
		interactive: options.interactive || !!options.subcommand,
		heapSizeMb: options.interactive || options.subcommand ? undefined : cliHeapSizeMb(settings, os.totalmem()),
		extraArgs: options.subcommand ? [...options.subcommand] : [
			...policyArgs,
			...mcpArgs,
			...includeDirectoryArgs(options.ownFolderOnly ? [] : includedFolderPaths()),
		],
	});
}

/**
 * The folders every agent may read and edit besides its own: none, so an
 * agent keeps to the folder it works in, unless the user turns on
 * `gemini.agents.allWorkspaceFolders` for every folder of a multi-root window.
 */
export function includedFolderPaths(): string[] {
	return vscode.workspace.getConfiguration(configSection).get<boolean>('agents.allWorkspaceFolders', false) ? workspaceFolderPaths() : [];
}

/** The window's folders on disk, in order. */
export function workspaceFolderPaths(): string[] {
	return (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
}

function readCliSettings(): Promise<string | undefined> {
	// The CLI's launcher reads `$GEMINI_CLI_HOME/settings.json`, without the
	// `.gemini` level its other files use, to decide on the heap flag; match it.
	const home = process.env.GEMINI_CLI_HOME || path.join(os.homedir(), '.gemini');
	return fs.readFile(path.join(home, 'settings.json'), 'utf8').catch(() => undefined);
}
