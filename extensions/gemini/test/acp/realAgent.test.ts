/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks a real Gemini CLI without credentials: the `initialize` handshake,
// and that `session/new` fails with an error our classifier still recognises.
// Skipped unless GEMINI_CLI_PATH points at the CLI (its executable or its JS entry point).
// Runs with an empty HOME so a developer's own ~/.gemini is never read or changed.

import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConnection } from '../../src/acp/agentConnection';
import { resolveAgentCommand, spawnAgent } from '../../src/acp/agentProcess';
import { classifyAgentError } from '../../src/acp/errors';

const cliPath = process.env.GEMINI_CLI_PATH;

describe.skipIf(!cliPath)('gemini --acp', () => {
	let child: ChildProcessWithoutNullStreams | undefined;
	let connection: AgentConnection | undefined;

	afterEach(() => {
		connection?.dispose();
		child?.kill();
	});

	function connect(): AgentConnection {
		const home = mkdtempSync(path.join(tmpdir(), 'gemini-home-'));
		const env = { ...process.env, HOME: home, USERPROFILE: home, GEMINI_API_KEY: '', GOOGLE_API_KEY: '' };
		const command = resolveAgentCommand({ cliPath, execPath: process.execPath, env, platform: process.platform });
		child = spawnAgent(command, home);
		child.stderr.resume();
		connection = new AgentConnection(child.stdin, child.stdout, {
			sessionUpdate: () => { },
			requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
		});
		return connection;
	}

	it('answers initialize without authentication', async () => {
		const info = await connect().initialize();
		console.log(JSON.stringify(info, undefined, '\t'));
		expect(info.authMethods?.map(m => m.id)).toContain('oauth-personal');
	}, 60_000);

	it('reports a recognisable auth error from session/new', async () => {
		const agent = connect();
		await agent.initialize();
		const error = await agent.newSession(process.cwd()).then(() => undefined, err => err);
		expect(error, 'session/new unexpectedly succeeded without credentials').toBeDefined();
		expect(classifyAgentError(error)).toMatchObject({ kind: 'auth-required', code: -32000 });
	}, 60_000);
});
