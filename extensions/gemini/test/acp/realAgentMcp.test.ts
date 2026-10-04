/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that GeminiCode hears about an MCP server a real Gemini CLI could not
// start, through the CLI's debug log. Skipped unless GEMINI_CLI_PATH points at
// the CLI. Runs with an empty HOME and no credentials or network.

import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConnection } from '../../src/acp/agentConnection';
import { resolveAgentCommand, spawnAgent } from '../../src/acp/agentProcess';
import { McpDiagnostics, McpProblem } from '../../src/acp/mcpDiagnostics';
import { trustFolder } from '../../src/acp/trustedFolders';
import { waitFor } from '../helpers';

const cliPath = process.env.GEMINI_CLI_PATH;

describe.skipIf(!cliPath)('gemini --acp with an MCP server that cannot start', () => {
	let child: ChildProcessWithoutNullStreams | undefined;
	let connection: AgentConnection | undefined;
	let diagnostics: McpDiagnostics | undefined;

	afterEach(() => {
		connection?.dispose();
		child?.kill();
		diagnostics?.dispose();
	});

	it('reports the server and why', async () => {
		const home = mkdtempSync(path.join(tmpdir(), 'gemini-home-'));
		const work = mkdtempSync(path.join(tmpdir(), 'gemini-work-'));
		mkdirSync(path.join(home, '.gemini'));
		writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({
			security: { auth: { selectedType: 'gemini-api-key' } },
			mcpServers: { broken: { command: path.join(work, 'no-such-server') } },
		}));
		// The CLI starts MCP servers only in trusted folders.
		trustFolder(path.join(home, '.gemini', 'trustedFolders.json'), work);
		diagnostics = new McpDiagnostics(path.join(home, 'geminicode', 'cli-debug.log'));
		const reported = waitFor<McpProblem>(diagnostics.onDidReport);
		expect(diagnostics.reset()).toBe(true);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			GEMINI_API_KEY: 'fake',
			GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9',
			GEMINI_DEBUG_LOG_FILE: diagnostics.file,
		};
		for (const key of Object.keys(env).filter(k => k.startsWith('VITEST') || /^https?_proxy$/i.test(k))) {
			delete env[key];
		}
		child = spawnAgent(resolveAgentCommand({ cliPath, execPath: process.execPath, env, platform: process.platform }), work);
		child.stderr.resume();
		connection = new AgentConnection(child.stdin, child.stdout, { sessionUpdate: () => { }, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) });
		await connection.initialize();
		await connection.newSession(work);
		expect(await reported).toMatchObject({ severity: 'error', server: 'broken', message: expect.stringContaining('ENOENT') });
	}, 60_000);
});
