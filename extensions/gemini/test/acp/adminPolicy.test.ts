/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAdminPolicy, isModeAllowed, policyFileName, prepareAdminPolicy, takesAway } from '../../src/acp/adminPolicy';
import { filterModes } from '../../src/acp/sessionSettings';

const allowAll = { allowAutoEdit: true, allowYolo: true, allowShell: true };
const defaults = { allowAutoEdit: true, allowYolo: false, allowShell: true };

describe('isModeAllowed', () => {
	it('always allows Default and Plan', async () => {
		const none = { allowAutoEdit: false, allowYolo: false, allowShell: false };
		expect(['default', 'plan'].every(id => isModeAllowed(none, id))).toBe(true);
		expect(isModeAllowed(none, 'autoEdit')).toBe(false);
		expect(isModeAllowed(defaults, 'autoEdit')).toBe(true);
		expect(isModeAllowed(defaults, 'yolo')).toBe(false);
	});
});

describe('takesAway', () => {
	it('is true only for a change that allows less', () => {
		expect([
			takesAway(defaults, allowAll),
			takesAway(allowAll, defaults),
			takesAway(defaults, { ...defaults, allowShell: false }),
			takesAway({ ...defaults, denyEnvironmentCommands: false }, { ...defaults, denyEnvironmentCommands: true }),
			takesAway({ ...defaults, denyEnvironmentCommands: true }, { ...defaults, denyEnvironmentCommands: false }),
		]).toEqual([false, true, true, true, false]);
	});
});

describe('buildAdminPolicy', () => {
	it('writes nothing when everything is allowed', async () => {
		expect(buildAdminPolicy(allowAll)).toBeUndefined();
	});

	it('makes every tool ask in the modes that are turned off', async () => {
		expect(buildAdminPolicy(defaults)).toContain('toolName = "*"\ndecision = "ask_user"\npriority = 900\nmodes = ["yolo"]');
		expect(buildAdminPolicy({ ...defaults, allowAutoEdit: false })).toContain('modes = ["autoEdit", "yolo"]');
	});

	it('refuses the commands that print the environment, and asks for the confirm class in every mode', async () => {
		const policy = buildAdminPolicy({ ...allowAll, denyEnvironmentCommands: true, confirmTools: [{ server: 'geminicode-tools', tools: ['jira_transition', 'gitlab_merge'] }] }) ?? '';
		const rules = policy.split('\n\n').filter(block => block.includes('[[rule]]')).map(block => block.trim().split('\n').filter(line => !line.startsWith('#') && !line.startsWith('denyMessage')).join('\n'));
		expect(rules).toEqual([
			'[[rule]]\ntoolName = "run_shell_command"\ncommandPrefix = ["env", "printenv"]\ndecision = "deny"\npriority = 960',
			'[[rule]]\ntoolName = "run_shell_command"\ncommandRegex = \'(?:set|export)\\s*"\'\ndecision = "deny"\npriority = 960',
			'[[rule]]\ntoolName = ["mcp_geminicode-tools_jira_transition", "mcp_geminicode-tools_gitlab_merge"]\ndecision = "ask_user"\npriority = 990',
		]);
	});

	it('leaves the environment rules out when the shell is off anyway', async () => {
		expect(buildAdminPolicy({ ...allowAll, allowShell: false, denyEnvironmentCommands: true })).not.toContain('commandPrefix');
	});

	it('denies the shell tool when shell is turned off', async () => {
		const policy = buildAdminPolicy({ ...allowAll, allowShell: false });
		expect(policy).toContain('toolName = "run_shell_command"\ndecision = "deny"');
		expect(policy).not.toContain('ask_user');
	});
});

describe('prepareAdminPolicy', () => {
	let dir: string | undefined;
	afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

	it('writes the file and returns the flag, and removes it when nothing is restricted', async () => {
		dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-policy-')), 'policy');
		expect(await prepareAdminPolicy(dir, defaults)).toEqual(['--admin-policy', dir]);
		const file = path.join(dir, policyFileName);
		expect(fs.readFileSync(file, 'utf8')).toBe(buildAdminPolicy(defaults));
		const written = fs.statSync(file).mtimeMs;
		await prepareAdminPolicy(dir, defaults);
		expect(fs.statSync(file).mtimeMs).toBe(written);
		expect(await prepareAdminPolicy(dir, allowAll)).toEqual([]);
		expect(fs.existsSync(file)).toBe(false);
	});
});

describe('filterModes', () => {
	const settings = {
		mode: {
			currentId: 'default',
			available: ['default', 'autoEdit', 'yolo', 'plan'].map(id => ({ id, name: id })),
		},
	};

	it('leaves out modes that are not allowed', async () => {
		expect(filterModes(settings, id => isModeAllowed(defaults, id)).mode?.available.map(m => m.id)).toEqual(['default', 'autoEdit', 'plan']);
	});

	it('keeps the current mode and hides a picker with one choice', async () => {
		expect(filterModes({ mode: { ...settings.mode, currentId: 'yolo' } }, id => id === 'default').mode?.available.map(m => m.id)).toEqual(['default', 'yolo']);
		expect(filterModes(settings, id => id === 'default').mode).toBeUndefined();
	});
});
