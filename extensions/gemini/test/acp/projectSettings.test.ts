/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMcpServer, disabledServers, serverConfigFrom, isServerEnabled, mcpServersIn, readSettingsFile, rulesFileNames, setServerEnabled, stripJsonComments } from '../../src/acp/projectSettings';

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-settings-'));
});

afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe('stripJsonComments', () => {
	it('drops comments and trailing commas but keeps strings', () => {
		const text = '{\n // note\n "url": "http://a/b//c", /* x */ "list": [1, 2,],\n}';
		expect(JSON.parse(stripJsonComments(text))).toEqual({ url: 'http://a/b//c', list: [1, 2] });
	});

	it('keeps a comma before a brace inside a string', () => {
		expect(JSON.parse(stripJsonComments('{ "args": ["--fmt={a, }"], // x\n }'))).toEqual({ args: ['--fmt={a, }'] });
	});
});

describe('mcpServersIn', () => {
	it('reads each transport', () => {
		const servers = mcpServersIn({
			mcpServers: {
				github: { command: 'npx', args: ['-y', 'server-github'] },
				docs: { httpUrl: 'https://docs.example/mcp' },
				events: { url: 'https://events.example/sse' },
				broken: 3,
			},
		}, '/s.json');
		expect(servers).toEqual([
			{ name: 'github', transport: 'stdio', target: 'npx -y server-github', file: '/s.json' },
			{ name: 'docs', transport: 'http', target: 'https://docs.example/mcp', file: '/s.json' },
			{ name: 'events', transport: 'sse', target: 'https://events.example/sse', file: '/s.json' },
		]);
	});

	it('reads nothing from settings without servers', () => {
		expect(mcpServersIn({}, '/s.json')).toEqual([]);
	});
});

describe('rulesFileNames', () => {
	it('defaults to GEMINI.md and takes a name or a list', () => {
		expect(rulesFileNames({})).toEqual(['GEMINI.md']);
		expect(rulesFileNames({ context: { fileName: 'AGENTS.md' } })).toEqual(['AGENTS.md']);
		expect(rulesFileNames({ context: { fileName: ['AGENTS.md', 'GEMINI.md'] } })).toEqual(['AGENTS.md', 'GEMINI.md']);
	});
});

describe('server enablement', () => {
	it('switches a server off and on as the CLI does', async () => {
		const file = path.join(dir, 'mcp-server-enablement.json');
		await setServerEnabled(file, ' GitHub ', false);
		expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ github: { enabled: false } });
		expect(isServerEnabled(await disabledServers(file), 'GitHub')).toBe(false);
		await setServerEnabled(file, 'github', true);
		expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({});
		expect(isServerEnabled(await disabledServers(file), 'github')).toBe(true);
	});

	it('reads a missing file as empty', async () => {
		expect(await readSettingsFile(path.join(dir, 'none.json'))).toEqual({});
	});
});

describe('adding a server', () => {
	it('reads a URL or a command line', () => {
		expect(serverConfigFrom('https://docs.example/mcp')).toEqual({ httpUrl: 'https://docs.example/mcp' });
		expect(serverConfigFrom('https://events.example/sse')).toEqual({ url: 'https://events.example/sse' });
		expect(serverConfigFrom('npx -y "@scope/server name" --flag')).toEqual({ command: 'npx', args: ['-y', '@scope/server name', '--flag'] });
	});

	it('adds to the settings and keeps the rest', async () => {
		const file = path.join(dir, 'settings.json');
		await fs.writeFile(file, JSON.stringify({ theme: 'x', mcpServers: { a: { command: 'a' } } }));
		expect(await addMcpServer(file, 'b', { command: 'b' })).toBe(true);
		expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ theme: 'x', mcpServers: { a: { command: 'a' }, b: { command: 'b' } } });
	});

	it('creates the file, and leaves one with comments alone', async () => {
		const created = path.join(dir, 'new', 'settings.json');
		expect(await addMcpServer(created, 'b', { command: 'b' })).toBe(true);
		const commented = path.join(dir, 'commented.json');
		await fs.writeFile(commented, '{ // mine\n}');
		expect(await addMcpServer(commented, 'b', { command: 'b' })).toBe(false);
		expect(await fs.readFile(commented, 'utf8')).toBe('{ // mine\n}');
	});
});
