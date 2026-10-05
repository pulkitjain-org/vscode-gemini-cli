/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient, AgentClientState } from '../../src/acp/agentClient';
import { ChatTranscript, countChangedLines, TranscriptItem } from '../../src/acp/chatTranscript';
import { SessionUpdateAdapter } from '../../src/acp/sessionUpdates';
import { AgentRuntime } from '../../src/acp/agentRuntime';
import { AgentSidecar } from '../../src/acp/sidecar';
import { fakeAgentCommand, waitFor } from '../helpers';

function summary(items: readonly TranscriptItem[]): string[] {
	return items.map(item => {
		switch (item.kind) {
			case 'user': case 'agent': case 'thought': return `${item.kind}:${item.text}`;
			case 'toolCall': return `tool:${item.title}:${item.status}`;
			case 'plan': return `plan:${item.entries.map(e => `${e.content}=${e.status}`).join(',')}`;
			case 'other': return `other:${item.type}`;
			case 'notice': return `notice:${item.severity}:${item.text}`;
			case 'permission': return `permission:${item.title}:${item.answer ? (item.answer.kind === 'selected' ? item.answer.name : 'cancelled') : 'pending'}`;
			case 'turnEnd': return 'turnEnd';
		}
	});
}

describe('ChatTranscript', () => {
	it('labels the context sent with a prompt, without keeping its contents', () => {
		const transcript = new ChatTranscript(() => 7000);
		transcript.addPrompt('look', [
			{ kind: 'file', path: '/w/a.ts' },
			{ kind: 'selection', path: '/w/b.ts', text: 'x', startLine: 3, endLine: 4 },
			{ kind: 'image', name: 'shot.png', mimeType: 'image/png', data: 'AAAA' },
		]);
		expect(transcript.items[0]).toEqual({
			id: 'item-0', kind: 'user', text: 'look', at: 7000, attachments: [
				{ kind: 'file', label: 'a.ts', path: '/w/a.ts' },
				{ kind: 'selection', label: 'b.ts:3-4', path: '/w/b.ts', line: 3 },
				{ kind: 'image', label: 'shot.png' },
			],
		});
	});

	it('joins streamed chunks into one message and starts a new one when the kind changes', () => {
		const transcript = new ChatTranscript();
		const adapter = new SessionUpdateAdapter();
		transcript.addPrompt('hi');
		for (const update of [
			{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'let me ' } },
			{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } },
			{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } },
			{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } },
		] as const) {
			transcript.apply(adapter.adapt(update));
		}
		expect(summary(transcript.items)).toEqual(['user:hi', 'thought:let me think', 'agent:Hello']);
	});

	it('starts a new message when the agent sends a new message id', () => {
		const transcript = new ChatTranscript();
		transcript.apply({ kind: 'text', role: 'agent', text: 'one', messageId: 'm1' });
		transcript.apply({ kind: 'text', role: 'agent', text: ' more', messageId: 'm1' });
		transcript.apply({ kind: 'text', role: 'agent', text: 'two', messageId: 'm2' });
		expect(summary(transcript.items)).toEqual(['agent:one more', 'agent:two']);
	});

	it('updates a tool call card in place and keeps one plan per turn', () => {
		const transcript = new ChatTranscript();
		const adapter = new SessionUpdateAdapter();
		const changed: string[] = [];
		transcript.onDidChangeItem(item => changed.push(item.id));
		transcript.addPrompt('edit it');
		transcript.apply(adapter.adapt({ sessionUpdate: 'plan', entries: [{ content: 'Read', priority: 'medium', status: 'in_progress' }] }));
		transcript.apply(adapter.adapt({
			sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.ts', kind: 'edit', status: 'in_progress',
			locations: [{ path: '/w/a.ts', line: 3 }],
		}));
		transcript.apply(adapter.adapt({
			sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed',
			content: [{ type: 'diff', path: '/w/a.ts', oldText: 'a\nb\n', newText: 'a\nc\nd\n' }],
		}));
		transcript.apply(adapter.adapt({ sessionUpdate: 'plan', entries: [{ content: 'Read', priority: 'medium', status: 'completed' }] }));

		expect(summary(transcript.items)).toEqual(['user:edit it', 'plan:Read=completed', 'tool:Edit a.ts:completed']);
		expect(transcript.items[2]).toMatchObject({ locations: [{ path: '/w/a.ts', line: 3 }], details: [{ type: 'diff', path: '/w/a.ts', added: 2, removed: 1 }] });
		expect(changed).toEqual(['item-0', 'item-1', 'tool-t1', 'tool-t1', 'item-1']);
	});

	it('renders unknown updates generically but skips session-state updates', () => {
		const transcript = new ChatTranscript();
		transcript.apply({ kind: 'other', type: 'available_commands_update', update: { sessionUpdate: 'available_commands_update', availableCommands: [] } });
		transcript.apply({ kind: 'other', type: 'something_new', update: { sessionUpdate: 'something_new' } as never });
		expect(summary(transcript.items)).toEqual(['other:something_new']);
	});

	it('clears and tells listeners', () => {
		const transcript = new ChatTranscript();
		let resets = 0;
		transcript.onDidReset(() => resets++);
		transcript.addPrompt('hi');
		transcript.addNotice('Stopped.');
		transcript.clear();
		expect(transcript.items).toEqual([]);
		expect(resets).toBe(1);
	});
});

describe('ChatTranscript permissions', () => {
	const request = {
		sessionId: 's1',
		toolCall: {
			toolCallId: 'w1', title: 'Write a.ts',
			content: [{ type: 'diff' as const, path: '/w/a.ts', oldText: 'a', newText: 'b' }, { type: 'content' as const, content: { type: 'text' as const, text: 'why' } }],
		},
		options: [
			{ optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' as const },
			{ optionId: 'cancel', name: 'Reject', kind: 'reject_once' as const },
		],
	};

	it('shows the request with its own options and the files it would change', () => {
		const transcript = new ChatTranscript();
		transcript.addPermission({ id: 'permission-0', request });
		expect(transcript.items[0]).toEqual({
			id: 'permission-0', kind: 'permission', title: 'Write a.ts',
			options: [{ optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' }, { optionId: 'cancel', name: 'Reject', kind: 'reject_once' }],
			diffPaths: ['/w/a.ts'],
		});
	});

	it('records the answer in place', () => {
		const transcript = new ChatTranscript();
		transcript.addPermission({ id: 'permission-0', request });
		transcript.addPermission({ id: 'permission-1', request });
		transcript.resolvePermission('permission-0', { outcome: 'selected', optionId: 'cancel' });
		transcript.resolvePermission('permission-1', { outcome: 'cancelled' });
		expect(summary(transcript.items)).toEqual(['permission:Write a.ts:Reject', 'permission:Write a.ts:cancelled']);
	});
});

describe('countChangedLines', () => {
	it('counts added and removed lines', () => {
		expect(countChangedLines('', 'a\nb')).toEqual({ added: 2, removed: 0 });
		expect(countChangedLines('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
		expect(countChangedLines('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 });
	});
});

describe('ChatTranscript with the fake agent', () => {
	let sidecar: AgentSidecar | undefined;
	let runtime: AgentRuntime | undefined;
	let client: AgentClient | undefined;

	afterEach(() => {
		client?.dispose();
		runtime?.dispose();
		sidecar?.dispose();
	});

	it('records a whole turn, including a permission answer', async () => {
		sidecar = new AgentSidecar({
			command: () => fakeAgentCommand({
				turns: [[
					{ step: 'update', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Need to write.' } } },
					{ step: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'w1', title: 'Write notes.md', kind: 'edit', status: 'pending' } },
					{ step: 'permission', request: { toolCall: { toolCallId: 'w1', title: 'Write notes.md' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } },
					{ step: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'w1', status: 'completed' } },
				]],
			}),
			cwd: undefined,
			restartDelaysMs: [],
		});
		client = new AgentClient(runtime = new AgentRuntime(sidecar), {
			cwd: process.cwd(),
			requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
		});
		const settled = waitFor<AgentClientState>(client.onDidChangeState, s => s.kind === 'ready' || s.kind === 'error');
		sidecar.start();
		expect(await settled).toMatchObject({ kind: 'ready' });

		const transcript = new ChatTranscript();
		client.onDidReceiveEvent(event => transcript.apply(event));
		transcript.addPrompt('write notes');
		expect(await client.prompt('write notes')).toBe('end_turn');
		expect(summary(transcript.items)).toEqual([
			'user:write notes', 'thought:Need to write.', 'tool:Write notes.md:completed', 'agent:permission:allow',
		]);
	});
});

describe('ChatTranscript.updateTurnEnd', () => {
	it('adds and removes what a turn end offers', () => {
		const transcript = new ChatTranscript(() => 5000);
		transcript.addPrompt('hi');
		const id = transcript.addTurnEnd(1200);
		transcript.updateTurnEnd(id, { retry: true, undo: 'available', files: 2 });
		expect(transcript.items.at(-1)).toEqual({ id, kind: 'turnEnd', durationMs: 1200, at: 5000, retry: true, undo: 'available', files: 2 });
		transcript.updateTurnEnd(id, { retry: undefined, undo: 'undone' });
		expect(transcript.items.at(-1)).toEqual({ id, kind: 'turnEnd', durationMs: 1200, at: 5000, undo: 'undone', files: 2 });
	});
});
