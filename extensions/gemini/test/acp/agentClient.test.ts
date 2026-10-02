/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient, AgentClientState } from '../../src/acp/agentClient';
import { AgentSidecar } from '../../src/acp/sidecar';
import type { ChatEvent } from '../../src/acp/sessionUpdates';
import type { FakeAgentScript } from '../fake-agent/fakeAgent';
import { fakeAgentCommand, waitFor } from '../helpers';

describe('AgentClient', () => {
	let sidecar: AgentSidecar | undefined;
	let client: AgentClient | undefined;

	afterEach(() => {
		client?.dispose();
		sidecar?.dispose();
	});

	function start(script: FakeAgentScript, requestPermission?: (p: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>) {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand(script), cwd: undefined, restartDelaysMs: [] });
		client = new AgentClient(sidecar, {
			cwd: process.cwd(),
			requestPermission: requestPermission ?? (async () => ({ outcome: { outcome: 'cancelled' } })),
		});
		const settled = waitFor<AgentClientState>(client.onDidChangeState, s => s.kind === 'ready' || s.kind === 'error');
		sidecar.start();
		return { client, settled };
	}

	it('opens a session', async () => {
		const { settled } = start({});
		expect(await settled).toMatchObject({ kind: 'ready', sessionId: 'fake-session-1' });
	});

	it('authenticates once with oauth-personal when the agent asks, then retries', async () => {
		const { settled } = start({ requireAuth: true });
		expect(await settled).toMatchObject({ kind: 'ready', sessionId: 'fake-session-1' });
	});

	it('does not authenticate for a setup error and reports its kind', async () => {
		const { settled } = start({
			newSession: { error: { code: -32000, message: 'This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var. See https://geminicli.com/docs/get-started/authentication/#set-gcp' } },
		});
		expect(await settled).toMatchObject({ kind: 'error', error: { kind: 'project-id-required' } });
	});

	it('streams a turn through the adapter', async () => {
		const { client, settled } = start({
			turns: [[
				{ step: 'update', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } } },
				{ step: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', status: 'in_progress' } },
				{ step: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } },
				{ step: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } },
			]],
		});
		await settled;
		const events: ChatEvent[] = [];
		client.onDidReceiveEvent(e => events.push(e));
		expect(await client.prompt('hello')).toBe('end_turn');
		expect(events.map(e => e.kind === 'text' ? `${e.role}:${e.text}` : e.kind === 'toolCall' ? `tool:${e.call.status}` : e.kind)).toEqual([
			'thought:thinking', 'tool:in_progress', 'tool:completed', 'agent:done',
		]);
	});

	it('cancels a running turn', async () => {
		const { client, settled } = start({ turns: [[{ step: 'delay', ms: 200 }, { step: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'too late' } } }]] });
		await settled;
		const turn = client.prompt('long task');
		await client.cancel();
		expect(await turn).toBe('cancelled');
	});

	it('routes permission requests to the host', async () => {
		const asked: string[] = [];
		const { client, settled } = start({
			turns: [[{
				step: 'permission',
				request: {
					toolCall: { toolCallId: 't1', title: 'Write file' },
					options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
				},
			}]],
		}, async params => {
			asked.push(params.toolCall.title ?? '');
			return { outcome: { outcome: 'selected', optionId: 'allow' } };
		});
		await settled;
		const texts: string[] = [];
		client.onDidReceiveEvent(e => e.kind === 'text' && texts.push(e.text));
		await client.prompt('edit it');
		expect(asked).toEqual(['Write file']);
		expect(texts).toEqual(['permission:allow']);
	});

	it('reports a fatal agent exit', async () => {
		const { settled } = start({ exitCode: 41 });
		expect(await settled).toMatchObject({ kind: 'error', error: { kind: 'auth-failed' } });
	});
});
