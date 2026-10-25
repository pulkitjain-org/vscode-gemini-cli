/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The pure pieces of Projects: project roles on agents, thread
// cards and coordinator posts in the transcript, instant permission answers,
// and the coordinator's model.

import type * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { AgentsModel } from '../../src/acp/agents';
import { ChatTranscript, threadCardId } from '../../src/acp/chatTranscript';
import { PermissionBroker, PermissionEvent } from '../../src/acp/permissions';
import { coordinatorModel, threadCounts, threadPrompt } from '../../src/acp/projectHub';
import { coordinatorTools, isProjectToolCall, isProjectToolTitle, threadTools } from '../../src/acp/projectMcp';

const mcpOptions: acp.PermissionOption[] = [
	{ optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
	{ optionId: 'proceed_always_server', name: 'Allow all server tools for this session', kind: 'allow_always' },
	{ optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
];

describe('project roles on agents', () => {
	it('keeps a coordinator and its threads, and finds the threads in order', () => {
		let now = 1_000;
		const model = new AgentsModel(undefined, () => now++);
		const workspace = model.addWorkspace('/repo');
		const coordinator = model.addAgent(workspace.id, 'Account revamp', undefined, undefined, { role: 'coordinator' });
		const first = model.addAgent(workspace.id, 'Mobile sizes', undefined, undefined, { role: 'thread', coordinator: coordinator.id, byCoordinator: true });
		const second = model.addAgent(workspace.id, 'Loader', undefined, undefined, { role: 'thread', coordinator: coordinator.id, byCoordinator: false, planFirst: true });
		expect(model.threadsOf(coordinator.id).map(a => a.id)).toEqual([first.id, second.id]);
		expect(model.coordinatorOf(second)?.id).toBe(coordinator.id);
		const reloaded = new AgentsModel(JSON.parse(JSON.stringify(model.snapshot())));
		expect(reloaded.agent(second.id)?.project).toEqual({ role: 'thread', coordinator: coordinator.id, byCoordinator: false, planFirst: true });
		model.removeAgent(coordinator.id);
		expect(model.coordinatorOf(first)).toBeUndefined();
	});

	it('drops saved agents with a malformed project role', () => {
		const model = new AgentsModel({
			workspaces: [{ id: 'w', folder: '/repo' }],
			agents: [{ id: 'a', workspaceId: 'w', title: 'x', createdAt: 1, updatedAt: 1, project: { role: 'thread' } as never }],
		});
		expect(model.agent('a')).toBeUndefined();
	});
});

describe('thread cards and coordinator posts', () => {
	it('adds a thread card once and updates it in place', () => {
		const transcript = new ChatTranscript(() => 5);
		const changed: string[] = [];
		transcript.onDidChangeItem(item => changed.push(item.id));
		transcript.showThread({ thread: 't1', title: 'Mobile sizes', state: 'starting', startedAt: 1 });
		transcript.showThread({ thread: 't1', title: 'Mobile sizes', state: 'working', detail: 'Edit panel.css', startedAt: 1 });
		transcript.showThread({ thread: 't1', title: 'Mobile sizes', state: 'working', detail: 'Edit panel.css', startedAt: 1 });
		expect(transcript.items).toHaveLength(1);
		expect(transcript.items[0]).toMatchObject({ id: threadCardId('t1'), kind: 'thread', state: 'working', detail: 'Edit panel.css' });
		// The same card twice in a row sends nothing new.
		expect(changed).toEqual([threadCardId('t1'), threadCardId('t1')]);
	});

	it('keeps a post apart from the reply that follows it', () => {
		const transcript = new ChatTranscript();
		transcript.addCoordinatorPost('Starting two threads.');
		transcript.apply({ kind: 'text', role: 'agent', text: 'Done.' });
		expect(transcript.items.map(item => item.kind === 'agent' ? item.text : item.kind)).toEqual(['Starting two threads.', 'Done.']);
	});

	it('drops a reply that only repeats the post', () => {
		const transcript = new ChatTranscript();
		const texts = () => transcript.items.map(item => item.kind === 'agent' ? item.text : item.kind);
		transcript.addCoordinatorPost('Which repositories?\nacme-content, acme-checkout or both.');
		transcript.apply({ kind: 'text', role: 'agent', text: 'Which repositories? ' });
		transcript.apply({ kind: 'text', role: 'agent', text: 'acme-content,  acme-checkout or both.' });
		expect(texts()).toEqual(['Which repositories?\nacme-content, acme-checkout or both.']);
		transcript.addTurnEnd(10);
		expect(texts()).toEqual(['Which repositories?\nacme-content, acme-checkout or both.', 'turnEnd']);
	});

	it('keeps what a reply adds after repeating the post', () => {
		const transcript = new ChatTranscript();
		transcript.addCoordinatorPost('Which repositories?');
		transcript.apply({ kind: 'text', role: 'agent', text: 'Which repositories?' });
		transcript.apply({ kind: 'text', role: 'agent', text: ' I will start once you say.' });
		expect(transcript.items.map(item => item.kind === 'agent' ? item.text : item.kind)).toEqual(['Which repositories?', 'I will start once you say.']);
	});

	it('shows a reply that stops partway through the post', () => {
		const transcript = new ChatTranscript();
		transcript.addCoordinatorPost('Which repositories?');
		transcript.apply({ kind: 'text', role: 'agent', text: 'Which' });
		transcript.addTurnEnd(10);
		expect(transcript.items.map(item => item.kind === 'agent' ? item.text : item.kind)).toEqual(['Which repositories?', 'Which', 'turnEnd']);
	});

	it('marks a prompt the coordinator sent', () => {
		const transcript = new ChatTranscript(() => 5);
		transcript.addPrompt('Keep the 300 ms fade.', [], 'coordinator');
		expect(transcript.items[0]).toMatchObject({ kind: 'user', from: 'coordinator' });
	});
});

describe('project tools in permission requests', () => {
	it('tells the project tools from the agent\'s own and the user\'s other servers', () => {
		const call = (title: string, options = mcpOptions) => ({ toolCall: { title }, options });
		expect(isProjectToolCall(call('start_thread(title: Fix, brief: Fix it)'), coordinatorTools)).toBe(true);
		expect(isProjectToolCall(call('post(text: Hi)'), coordinatorTools)).toBe(true);
		// A built-in tool offers no "all server tools".
		expect(isProjectToolCall(call('post(text: Hi)', mcpOptions.filter(o => o.optionId !== 'proceed_always_server')), coordinatorTools)).toBe(false);
		expect(isProjectToolCall(call('poster(text: Hi)'), coordinatorTools)).toBe(false);
		expect(isProjectToolCall(call('report(kind: result, text: Done)'), threadTools)).toBe(true);
		expect(isProjectToolCall(call('report(kind: result, text: Done)'), coordinatorTools)).toBe(false);
		expect(isProjectToolTitle('message_thread(thread: t1, text: x)', coordinatorTools)).toBe(true);
		expect(isProjectToolTitle('Edit cli.js', coordinatorTools)).toBe(false);
	});

	it('answers at once as told: quietly, or with a row that says why', async () => {
		const broker = new PermissionBroker();
		const events: PermissionEvent[] = [];
		broker.onDidChange(event => events.push(event));
		broker.answerAtOnce = request => request.toolCall.title?.startsWith('post(')
			? { optionId: 'proceed_once', quiet: true }
			: { optionId: 'cancel', label: 'Refused' };
		await expect(broker.request({ sessionId: 's', toolCall: { toolCallId: 'a', title: 'post(text: Hi)' }, options: mcpOptions }))
			.resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'proceed_once' } });
		expect(events).toHaveLength(0);
		await expect(broker.request({ sessionId: 's', toolCall: { toolCallId: 'b', title: 'rm -rf build' }, options: mcpOptions }))
			.resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'cancel' } });
		expect(events).toMatchObject([{ kind: 'allowed', label: 'Refused' }]);
		expect(broker.pendingPermissions).toHaveLength(0);
	});

	it('asks as usual when the instant answer names an option the request lacks', () => {
		const broker = new PermissionBroker();
		broker.answerAtOnce = () => ({ optionId: 'nope', quiet: true });
		void broker.request({ sessionId: 's', toolCall: { toolCallId: 'a', title: 'Edit a.ts' }, options: mcpOptions });
		expect(broker.pendingPermissions).toHaveLength(1);
	});
});

describe('the coordinator', () => {
	it('runs on the newest named Flash model, never Lite or Auto', () => {
		expect(coordinatorModel(['auto', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-2.5-flash-image'])).toBe('gemini-3.8-flash');
		expect(coordinatorModel(['gemini-3-flash-preview', 'gemini-2.5-flash'])).toBe('gemini-3-flash-preview');
		expect(coordinatorModel(['auto', 'gemini-2.5-pro'])).toBeUndefined();
	});

	it('briefs a thread with how to report, and to plan first when asked', () => {
		expect(threadPrompt('Fix range()', false)).toMatch(/^Fix range\(\)\n\nWhen the work is done.*report tool/s);
		expect(threadPrompt('Fix range()', true)).toContain('write a short plan and stop');
	});
});

describe('the project side panel', () => {
	it('counts threads by state, with merged ones apart and undone ones left out', () => {
		const threads = [
			{ id: 'a', state: 'starting' as const },
			{ id: 'b', state: 'working' as const },
			{ id: 'c', state: 'waiting' as const },
			{ id: 'd', state: 'planned' as const },
			{ id: 'e', state: 'done' as const },
			{ id: 'f', state: 'error' as const },
			{ id: 'g', state: 'done' as const },
			{ id: 'h', state: 'done' as const },
		];
		expect(threadCounts(threads, new Set(['g']), new Set(['h']))).toEqual({ working: 2, waiting: 1, planned: 1, done: 2, merged: 1 });
		expect(threadCounts([], new Set(), new Set())).toEqual({ working: 0, waiting: 0, planned: 0, done: 0, merged: 0 });
	});
});
