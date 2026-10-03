/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAdminPolicy, isModeAllowed, policyFileName, prepareAdminPolicy } from '../../src/acp/adminPolicy';
import { filterModes } from '../../src/acp/sessionSettings';

const allowAll = { allowAutoEdit: true, allowYolo: true, allowShell: true };
const defaults = { allowAutoEdit: true, allowYolo: false, allowShell: true };

describe('isModeAllowed', () => {
	it('always allows Default and Plan', () => {
		const none = { allowAutoEdit: false, allowYolo: false, allowShell: false };
		expect(['default', 'plan'].every(id => isModeAllowed(none, id))).toBe(true);
		expect(isModeAllowed(none, 'autoEdit')).toBe(false);
		expect(isModeAllowed(defaults, 'autoEdit')).toBe(true);
		expect(isModeAllowed(defaults, 'yolo')).toBe(false);
	});
});

describe('buildAdminPolicy', () => {
	it('writes nothing when everything is allowed', () => {
		expect(buildAdminPolicy(allowAll)).toBeUndefined();
	});

	it('makes every tool ask in the modes that are turned off', () => {
		expect(buildAdminPolicy(defaults)).toContain('toolName = "*"\ndecision = "ask_user"\npriority = 900\nmodes = ["yolo"]');
		expect(buildAdminPolicy({ ...defaults, allowAutoEdit: false })).toContain('modes = ["autoEdit", "yolo"]');
	});

	it('denies the shell tool when shell is turned off', () => {
		const policy = buildAdminPolicy({ ...allowAll, allowShell: false });
		expect(policy).toContain('toolName = "run_shell_command"\ndecision = "deny"');
		expect(policy).not.toContain('ask_user');
	});
});

describe('prepareAdminPolicy', () => {
	let dir: string | undefined;
	afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

	it('writes the file and returns the flag, and removes it when nothing is restricted', () => {
		dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-policy-')), 'policy');
		expect(prepareAdminPolicy(dir, defaults)).toEqual(['--admin-policy', dir]);
		const file = path.join(dir, policyFileName);
		expect(fs.readFileSync(file, 'utf8')).toBe(buildAdminPolicy(defaults));
		const written = fs.statSync(file).mtimeMs;
		prepareAdminPolicy(dir, defaults);
		expect(fs.statSync(file).mtimeMs).toBe(written);
		expect(prepareAdminPolicy(dir, allowAll)).toEqual([]);
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

	it('leaves out modes that are not allowed', () => {
		expect(filterModes(settings, id => isModeAllowed(defaults, id)).mode?.available.map(m => m.id)).toEqual(['default', 'autoEdit', 'plan']);
	});

	it('keeps the current mode and hides a picker with one choice', () => {
		expect(filterModes({ mode: { ...settings.mode, currentId: 'yolo' } }, id => id === 'default').mode?.available.map(m => m.id)).toEqual(['default', 'yolo']);
		expect(filterModes(settings, id => id === 'default').mode).toBeUndefined();
	});
});
