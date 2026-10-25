/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { isModelOutput, SessionUpdateAdapter } from '../../src/acp/sessionUpdates';

describe('SessionUpdateAdapter', () => {
	it('maps message chunks to text events', () => {
		const adapter = new SessionUpdateAdapter();
		expect(adapter.adapt({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })).toEqual({ kind: 'text', role: 'agent', text: 'hi', messageId: undefined });
		expect(adapter.adapt({ sessionUpdate: 'agent_thought_chunk', content: { type: 'image', data: '', mimeType: 'image/png' } })).toMatchObject({ role: 'thought', text: '[image]' });
	});

	it('merges tool call updates into the tool call', () => {
		const adapter = new SessionUpdateAdapter();
		adapter.adapt({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run npm test', kind: 'execute', status: 'pending', locations: [{ path: '/w/package.json' }] });
		expect(adapter.adapt({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] })).toEqual({
			kind: 'toolCall',
			call: { id: 't1', title: 'Run npm test', kind: 'execute', status: 'completed', locations: [{ path: '/w/package.json' }], content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] },
		});
	});

	it('passes unknown update kinds through generically', () => {
		const update = { sessionUpdate: 'something_new', value: 1 } as never;
		expect(new SessionUpdateAdapter().adapt(update)).toEqual({ kind: 'other', type: 'something_new', update });
	});
});

describe('isModelOutput', () => {
	it('counts thoughts, tool calls, plans and reply text as the first token, but not echoed prompts or session state', () => {
		const adapter = new SessionUpdateAdapter();
		const updates = {
			thought: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Hmm' } },
			toolCall: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', kind: 'read', status: 'pending' },
			plan: { sessionUpdate: 'plan', entries: [] },
			reply: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
			prompt: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } },
			state: { sessionUpdate: 'something_new' },
		};
		const counted = Object.entries(updates).filter(([, update]) => {
			const event = adapter.adapt(update as never);
			return !!event && isModelOutput(event);
		}).map(([name]) => name);
		expect(counted).toEqual(['thought', 'toolCall', 'plan', 'reply']);
	});
});
