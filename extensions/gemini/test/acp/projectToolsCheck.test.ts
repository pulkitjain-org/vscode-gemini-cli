/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectToolsBlock } from '../../src/acp/projectToolsCheck';

describe('projectToolsBlock', () => {
	let home: string;
	let folder: string;
	let env: NodeJS.ProcessEnv;
	const write = (name: string, value: unknown) => writeFileSync(path.join(home, '.gemini', name), typeof value === 'string' ? value : JSON.stringify(value));
	const check = () => projectToolsBlock({ folder, server: 'geminicode-project', env, homedir: home, platform: 'linux' });

	beforeEach(() => {
		home = mkdtempSync(path.join(tmpdir(), 'tools-check-'));
		folder = path.join(home, '.geminicode', 'projects', 'p1');
		mkdirSync(folder, { recursive: true });
		mkdirSync(path.join(home, '.gemini'));
		env = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(home, 'system.json') };
		write('trustedFolders.json', { [path.join(home, '.geminicode', 'projects')]: 'TRUST_FOLDER' });
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	it('finds nothing when the folder is trusted and the server allowed', async () => {
		expect(await check()).toBeUndefined();
	});

	it('names an untrusted folder', async () => {
		write('trustedFolders.json', {});
		expect(await check()).toEqual({ kind: 'untrusted', folder });
		// Unless the CLI checks no folder's trust.
		write('settings.json', { security: { folderTrust: { enabled: false } } });
		expect(await check()).toBeUndefined();
	});

	it('names mcp.allowed without the server, and mcp.excluded with it', async () => {
		write('settings.json', { mcp: { allowed: ['github'] } });
		expect(await check()).toMatchObject({ kind: 'notAllowed' });
		write('settings.json', { mcp: { allowed: ['github', 'geminicode-project'], excluded: ['geminicode-project'] } });
		expect(await check()).toMatchObject({ kind: 'excluded' });
	});

	it('names MCP turned off in the system settings', async () => {
		writeFileSync(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, JSON.stringify({ admin: { mcp: { enabled: false } } }));
		expect(await check()).toEqual({ kind: 'adminOff', file: env.GEMINI_CLI_SYSTEM_SETTINGS_PATH });
	});

	it('names a server turned off with gemini mcp disable, and an enablement file the CLI cannot read', async () => {
		write('mcp-server-enablement.json', { 'geminicode-project': { enabled: false } });
		expect(await check()).toMatchObject({ kind: 'disabled' });
		write('mcp-server-enablement.json', { github: { enabled: false } });
		expect(await check()).toBeUndefined();
		write('mcp-server-enablement.json', '{ broken');
		expect(await check()).toMatchObject({ kind: 'enablementUnreadable' });
	});
});
