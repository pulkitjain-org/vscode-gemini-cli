/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Approval modes and shell access as policy. GeminiCode's settings, which an
// admin can lock through VS Code's policy system, become two things: the modes
// the picker offers, and a policy file passed to the CLI with `--admin-policy`.
// The CLI ranks that file above user and workspace policies, so a disallowed
// mode still asks before every tool, and a blocked shell tool is removed from
// the agent. Checked against gemini-cli 0.62 in
// test/acp/realAgentPolicy.test.ts.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from './fsUtil';

export interface ApprovalPolicy {
	/** Auto Edit: edits are applied without asking. */
	readonly allowAutoEdit: boolean;
	/** YOLO: every tool runs without asking. */
	readonly allowYolo: boolean;
	/** The shell tool, which runs commands outside any sandbox. */
	readonly allowShell: boolean;
	/** Refuse the shell commands that print the environment, where a token passed to a server could sit. */
	readonly denyEnvironmentCommands?: boolean;
	/** MCP tools that ask in every mode, YOLO included, whatever a user or workspace policy allows: the confirm class. */
	readonly confirmTools?: readonly { readonly server: string; readonly tools: readonly string[] }[];
}

/**
 * Commands that print the environment: `env` and `printenv` with anything after them, and `set` or
 * `export` alone (with arguments they change the shell, as in `set -e`, and print nothing).
 */
export const environmentCommandPrefixes = ['env', 'printenv'] as const;
export const environmentCommandRegex = '(?:set|export)\\s*"';

export const shellToolName = 'run_shell_command';
export const policyFileName = 'geminicode.toml';
const environmentDenyMessage = 'Commands that print the environment are turned off in GeminiCode, because it can hold tokens. Read the one variable you need instead, such as `echo $PATH`.';

/**
 * Whether `after` takes away something `before` allowed: a mode, the shell, or
 * commands that print the environment. Such a change has to reach the agent at
 * once; one that only allows more can wait for the running turns to end.
 */
export function takesAway(before: ApprovalPolicy, after: ApprovalPolicy): boolean {
	return (before.allowAutoEdit && !after.allowAutoEdit)
		|| (before.allowYolo && !after.allowYolo)
		|| (before.allowShell && !after.allowShell)
		|| (!before.denyEnvironmentCommands && !!after.denyEnvironmentCommands);
}

/** Default and Plan are always allowed: Default asks first, and Plan cannot change anything. */
export function isModeAllowed(policy: ApprovalPolicy, modeId: string): boolean {
	switch (modeId) {
		case 'autoEdit': return policy.allowAutoEdit;
		case 'yolo': return policy.allowYolo;
		default: return true;
	}
}

/** The CLI policy file for `policy`, or undefined when it allows everything. */
export function buildAdminPolicy(policy: ApprovalPolicy): string | undefined {
	const askModes = [...policy.allowAutoEdit ? [] : ['autoEdit'], ...policy.allowYolo ? [] : ['yolo']];
	const rules: string[] = [];
	if (askModes.length) {
		rules.push([
			`# Approval modes turned off in GeminiCode: every tool asks first, as in Default mode.`,
			`[[rule]]`,
			`toolName = "*"`,
			`decision = "ask_user"`,
			`priority = 900`,
			`modes = [${askModes.map(m => `"${m}"`).join(', ')}]`,
		].join('\n'));
	}
	if (policy.allowShell && policy.denyEnvironmentCommands) {
		rules.push([
			`# Commands that print the environment, turned off in GeminiCode (gemini.tools.denyEnvironmentCommands).`,
			`[[rule]]`,
			`toolName = "${shellToolName}"`,
			`commandPrefix = [${environmentCommandPrefixes.map(c => `"${c}"`).join(', ')}]`,
			`decision = "deny"`,
			`priority = 960`,
			`denyMessage = "${environmentDenyMessage}"`,
			``,
			`[[rule]]`,
			`toolName = "${shellToolName}"`,
			`commandRegex = '${environmentCommandRegex}'`,
			`decision = "deny"`,
			`priority = 960`,
			`denyMessage = "${environmentDenyMessage}"`,
		].join('\n'));
	}
	// By the names the model calls them (`mcp_<server>_<tool>`), not `mcpName`: gemini-cli 0.63 gives the
	// policy check no server name for the servers a session brings, so a rule with `mcpName` never matches
	// them (test/acp/realAgentPolicy.test.ts).
	for (const group of policy.confirmTools ?? []) {
		rules.push([
			`# ${group.server}: hard to take back, so these ask every time, in every mode.`,
			`[[rule]]`,
			`toolName = [${group.tools.map(t => `"mcp_${group.server}_${t}"`).join(', ')}]`,
			`decision = "ask_user"`,
			`priority = 990`,
		].join('\n'));
	}
	if (!policy.allowShell) {
		rules.push([
			`# Shell commands turned off in GeminiCode.`,
			`[[rule]]`,
			`toolName = "${shellToolName}"`,
			`decision = "deny"`,
			`priority = 950`,
			`denyMessage = "Shell commands are turned off in GeminiCode."`,
		].join('\n'));
	}
	return rules.length ? `# Written by GeminiCode from its gemini.approval and gemini.tools settings. Changes are overwritten.\n\n${rules.join('\n\n')}\n` : undefined;
}

/**
 * Writes the policy file into `dir` and returns the arguments that load it,
 * or removes it and returns none. Rewrites only when the content changed, so
 * a start costs one small read.
 */
export async function prepareAdminPolicy(dir: string, policy: ApprovalPolicy): Promise<string[]> {
	const file = path.join(dir, policyFileName);
	const content = buildAdminPolicy(policy);
	if (!content) {
		await fs.rm(file, { force: true });
		return [];
	}
	const current = await fs.readFile(file, 'utf8').catch(() => undefined);
	if (current !== content) {
		// Replaced in one rename, so an agent starting in another window never reads half a policy.
		await writeFileAtomic(file, content);
	}
	// The CLI ranks a directory passed this way as admin policy.
	return ['--admin-policy', dir];
}
