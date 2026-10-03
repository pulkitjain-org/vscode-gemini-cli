/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Approval modes and shell access as policy. GeminiCode's settings, which an
// admin can lock through VS Code's policy system, become two things: the modes
// the picker offers, and a policy file passed to the CLI with `--admin-policy`.
// The CLI ranks that file above user and workspace policies, so a disallowed
// mode still asks before every tool, and a blocked shell tool is removed from
// the agent. Checked against gemini-cli 0.62 in
// test/acp/realAgentPolicy.test.ts.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ApprovalPolicy {
	/** Auto Edit: edits are applied without asking. */
	readonly allowAutoEdit: boolean;
	/** YOLO: every tool runs without asking. */
	readonly allowYolo: boolean;
	/** The shell tool, which runs commands outside any sandbox. */
	readonly allowShell: boolean;
}

export const shellToolName = 'run_shell_command';
export const policyFileName = 'geminicode.toml';

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
export function prepareAdminPolicy(dir: string, policy: ApprovalPolicy): string[] {
	const file = path.join(dir, policyFileName);
	const content = buildAdminPolicy(policy);
	if (!content) {
		fs.rmSync(file, { force: true });
		return [];
	}
	let current: string | undefined;
	try {
		current = fs.readFileSync(file, 'utf8');
	} catch {
		// Not written yet.
	}
	if (current !== content) {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, content);
	}
	// The CLI ranks a directory passed this way as admin policy.
	return ['--admin-policy', dir];
}
