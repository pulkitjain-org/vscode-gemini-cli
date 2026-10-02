/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConnection } from '../../src/acp/agentConnection';
import { UnsupportedProtocolVersionError } from '../../src/acp/protocol';

const fakeAgent = path.join(import.meta.dirname, '..', 'fake-agent', 'fakeAgent.ts');
const scripts = path.join(import.meta.dirname, '..', 'fake-agent', 'scripts');

describe('AgentConnection', () => {
	let child: ChildProcessWithoutNullStreams | undefined;
	let connection: AgentConnection | undefined;

	function connect(script?: string): AgentConnection {
		const args = script ? [fakeAgent, path.join(scripts, script)] : [fakeAgent];
		child = spawn(process.execPath, args, { stdio: 'pipe' });
		connection = new AgentConnection(child.stdin, child.stdout, {
			sessionUpdate: () => { },
			requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
		});
		return connection;
	}

	afterEach(() => {
		connection?.dispose();
		child?.kill();
	});

	it('initializes and reports the agent', async () => {
		const info = await connect().initialize();
		expect(info.protocolVersion).toBe(acp.PROTOCOL_VERSION);
		expect(info.agentInfo?.name).toBe('fake-agent');
		expect(info.authMethods?.map(m => m.id)).toEqual(['oauth-personal']);
	});

	it('rejects an agent that speaks another protocol version', async () => {
		await expect(connect('futureProtocol.json').initialize()).rejects.toBeInstanceOf(UnsupportedProtocolVersionError);
	});
});
