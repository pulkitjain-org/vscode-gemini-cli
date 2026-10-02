/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs the unauthenticated `initialize` handshake against a real Gemini CLI.
// Skipped unless GEMINI_CLI_PATH points at the CLI (its executable or its JS entry point).

import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConnection } from '../../src/acp/agentConnection';
import { resolveAgentCommand, spawnAgent } from '../../src/acp/agentProcess';

const cliPath = process.env.GEMINI_CLI_PATH;

describe.skipIf(!cliPath)('gemini --acp', () => {
	let child: ChildProcessWithoutNullStreams | undefined;
	let connection: AgentConnection | undefined;

	afterEach(() => {
		connection?.dispose();
		child?.kill();
	});

	it('answers initialize without authentication', async () => {
		const command = resolveAgentCommand({ cliPath, execPath: process.execPath, env: process.env, platform: process.platform });
		child = spawnAgent(command, process.cwd());
		child.stderr.resume();
		connection = new AgentConnection(child.stdin, child.stdout, {
			sessionUpdate: () => { },
			requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
		});
		const info = await connection.initialize();
		console.log(JSON.stringify(info, undefined, '\t'));
		expect(info.authMethods?.map(m => m.id)).toContain('oauth-personal');
	}, 60_000);
});
