/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowlistWith, allowServer, projectToolsBlock, settingsFiles } from '../../src/acp/projectToolsCheck';

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

	it('names mcp.excluded with the server, but not mcp.allowed without it, which the launch flag adds to', async () => {
		write('settings.json', { mcp: { allowed: ['github'] } });
		expect(await check()).toBeUndefined();
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
	it('names a workspace settings file that excludes geminicode-tools, and takes it out there', async () => {
		const workspace = path.join(home, 'repo');
		mkdirSync(path.join(workspace, '.gemini'), { recursive: true });
		const file = path.join(workspace, '.gemini', 'settings.json');
		writeFileSync(file, JSON.stringify({ mcp: { allowed: ['geminicode-browser', 'geminicode-project'], excluded: ['geminicode-tools'] } }));
		write('trustedFolders.json', { [workspace]: 'TRUST_FOLDER' });
		const tools = () => projectToolsBlock({ folder: workspace, server: 'geminicode-tools', workspace, env, homedir: home, platform: 'linux' });
		expect(await tools()).toEqual({ kind: 'excluded', file });
		expect(await allowServer(file, 'geminicode-tools')).toBe(true);
		expect(JSON.parse(readFileSync(file, 'utf8')).mcp).toEqual({ allowed: ['geminicode-browser', 'geminicode-project', 'geminicode-tools'], excluded: [] });
		expect(await tools()).toBeUndefined();
	});
});

describe('allowlistWith', () => {
	let home: string;
	let env: NodeJS.ProcessEnv;
	const own = ['geminicode-tools', 'geminicode-project', 'geminicode-browser'];
	const write = (file: string, value: unknown) => {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(value));
	};
	const user = () => path.join(home, '.gemini', 'settings.json');
	const workspace = () => path.join(home, 'repo');
	const names = () => allowlistWith(own, settingsFiles({ workspace: workspace(), env, homedir: home, platform: 'linux' }));

	beforeEach(() => {
		home = mkdtempSync(path.join(tmpdir(), 'allowlist-'));
		env = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(home, 'system', 'settings.json') };
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	it('adds GeminiCode\'s servers to an allowlist that leaves them out, and keeps out what is excluded', async () => {
		expect(await names()).toBeUndefined();
		write(user(), { mcp: { allowed: ['gitlab', 'jira', 'figma'], excluded: ['figma', 'geminicode-browser'] } });
		expect(await names()).toEqual(['gitlab', 'jira', 'geminicode-tools', 'geminicode-project']);
		// Each file's allowlist narrows the others', as the CLI reads them, the system defaults' too.
		write(path.join(workspace(), '.gemini', 'settings.json'), { mcp: { allowed: ['gitlab', 'figma'] } });
		write(path.join(home, 'system', 'system-defaults.json'), { mcp: { allowed: ['gitlab', 'jira'] } });
		expect(await names()).toEqual(['gitlab', 'geminicode-tools', 'geminicode-project']);
	});

	it('leaves the CLI to its own settings when the allowlist has the servers or allows every server', async () => {
		write(user(), { mcp: { allowed: ['gitlab', ...own] } });
		expect(await names()).toBeUndefined();
		// Allowlists with nothing in common leave an empty one, which the CLI takes as every server.
		write(path.join(workspace(), '.gemini', 'settings.json'), { mcp: { allowed: ['jira'] } });
		write(user(), { mcp: { allowed: ['gitlab'] } });
		expect(await names()).toBeUndefined();
	});
});
