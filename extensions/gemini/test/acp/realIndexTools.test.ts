/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that a real Gemini CLI loads the geminicode-index server from a
// session's mcpServers in a trusted folder: it initializes it (reading the
// folder's outline) and lists its tools. Skipped unless GEMINI_CLI_PATH points
// at the CLI. Runs with an empty HOME and no credentials or network.

import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConnection } from '../../src/acp/agentConnection';
import { resolveAgentCommand, spawnAgent } from '../../src/acp/agentProcess';
import { IndexMcpServer } from '../../src/acp/indexMcp';
import { trustFolder } from '../../src/acp/trustedFolders';

const cliPath = process.env.GEMINI_CLI_PATH;

describe.skipIf(!cliPath)('gemini --acp with the geminicode-index server', () => {
	let child: ChildProcessWithoutNullStreams | undefined;
	let connection: AgentConnection | undefined;
	let server: IndexMcpServer | undefined;

	afterEach(() => {
		connection?.dispose();
		child?.kill();
		server?.dispose();
	});

	it('initializes the server for the session\'s folder and lists its tools', async () => {
		const home = mkdtempSync(path.join(tmpdir(), 'gemini-home-'));
		const work = mkdtempSync(path.join(tmpdir(), 'gemini-work-'));
		mkdirSync(path.join(home, '.gemini'));
		writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
		await trustFolder(path.join(home, '.gemini', 'trustedFolders.json'), work);
		const asked: string[] = [];
		let listed!: () => void;
		const toolsListed = new Promise<void>(resolve => listed = resolve);
		server = new IndexMcpServer({
			search: async () => ({ result: { hits: [], total: 0, terms: [] } }),
			findSymbol: async () => ({ result: { definitions: [], similar: [], references: [], referenceTotal: 0 } }),
			related: async () => ({ result: { imports: [], importedBy: [], tests: [], changedWith: [], known: false, suggestions: [] } }),
			repoMap: async () => ({ result: '' }),
			docs: folder => {
				// Asked when the tools are listed.
				asked.push(`docs ${folder}`);
				listed();
				return [];
			},
			searchDocs: async () => ({ hits: [], total: 0, terms: [] }),
			orientation: folder => {
				asked.push(`outline ${folder}`);
				return 'src/ (1 file)';
			},
		}, '1');
		await server.start();
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, GEMINI_API_KEY: 'fake', GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9' };
		for (const key of Object.keys(env).filter(k => k.startsWith('VITEST') || /^https?_proxy$/i.test(k))) {
			delete env[key];
		}
		child = spawnAgent(resolveAgentCommand({ cliPath, execPath: process.execPath, env, platform: process.platform }), work);
		child.stderr.resume();
		connection = new AgentConnection(child.stdin, child.stdout, { sessionUpdate: () => { }, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) });
		await connection.initialize();
		await connection.newSession(work, [server.configFor('agent-1', work)!]);
		await toolsListed;
		expect(asked).toEqual(expect.arrayContaining([`outline ${work}`, `docs ${work}`]));
	}, 60_000);
});
