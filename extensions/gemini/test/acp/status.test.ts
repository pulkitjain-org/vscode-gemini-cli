/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { AgentClientState } from '../../src/acp/agentClient';
import type { SidecarState } from '../../src/acp/sidecar';
import { describeAgentStatus } from '../../src/acp/status';

const running: SidecarState = { kind: 'running', process: {} as ChildProcessWithoutNullStreams };
const ready: AgentClientState = {
	kind: 'ready',
	sessionId: 's1',
	savedSessionId: 's1',
	agent: { protocolVersion: 1, agentInfo: { name: 'gemini-cli', version: '0.62.0' } } as acp.InitializeResponse,
	session: { sessionId: 's1' },
};

describe('describeAgentStatus', () => {
	it('is ready with the CLI version once a session is open', () => {
		expect(describeAgentStatus(running, ready)).toEqual({ phase: 'ready', agentName: 'gemini-cli', agentVersion: '0.62.0' });
	});

	it('is starting while the process runs but the session is not open yet', () => {
		expect(describeAgentStatus(running, { kind: 'connecting' })).toEqual({ phase: 'starting' });
		expect(describeAgentStatus({ kind: 'starting' }, { kind: 'connecting' })).toEqual({ phase: 'starting' });
	});

	it('reports restarts with the attempt number', () => {
		expect(describeAgentStatus({ kind: 'restarting', attempt: 2, delayMs: 4000, exitCode: 1 }, { kind: 'connecting' }))
			.toEqual({ phase: 'restarting', restartAttempt: 2 });
	});

	it('reports a session error and a sidecar failure as errors', () => {
		const error = { kind: 'project-id-required', message: 'set a project' } as const;
		expect(describeAgentStatus(running, { kind: 'error', error })).toEqual({ phase: 'error', error });
		expect(describeAgentStatus({ kind: 'failed', reason: 'agent-not-found', exitCode: null, message: 'not found' }, { kind: 'error', error }))
			.toEqual({ phase: 'error', error: { kind: 'agent-not-found', message: 'not found' } });
	});

	it('is stopped before first use, unless something blocked the start', () => {
		expect(describeAgentStatus({ kind: 'stopped' }, { kind: 'idle' })).toEqual({ phase: 'stopped' });
		const blocked = { kind: 'project-id-numeric', message: 'a number' } as const;
		expect(describeAgentStatus({ kind: 'stopped' }, { kind: 'idle' }, blocked)).toEqual({ phase: 'error', error: blocked });
	});
});
