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

	it('keeps no content of a tool call the turn left unfinished, and still merges a late update into it', () => {
		const adapter = new SessionUpdateAdapter();
		const diff = { type: 'diff' as const, path: '/w/cart.ts', oldText: 'a'.repeat(1000), newText: 'b'.repeat(1000) };
		adapter.adapt({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit cart.ts', kind: 'edit', status: 'in_progress', content: [diff] });
		// While the turn runs, an update that leaves the content out keeps it.
		const during = adapter.adapt({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Edit cart.ts (2)' });
		adapter.turnEnded();
		const after = adapter.adapt({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' });
		expect([during.kind === 'toolCall' && during.call.content, after.kind === 'toolCall' && [after.call.title, after.call.status, after.call.content]]).toEqual([[diff], ['Edit cart.ts (2)', 'failed', []]]);
	});

	it('shows why GeminiCode refused a file request where the CLI wrote [object Object]', () => {
		const failure = (text: string) => ({ sessionUpdate: 'tool_call_update' as const, toolCallId: 't1', status: 'failed' as const, content: [{ type: 'content' as const, content: { type: 'text' as const, text } }] });
		const text = (event: ReturnType<SessionUpdateAdapter['adapt']>) => event.kind === 'toolCall' && event.call.content[0]?.type === 'content' && event.call.content[0].content.type === 'text' ? event.call.content[0].content.text : undefined;
		expect([
			text(new SessionUpdateAdapter(() => 'Access to /w/.env was denied: .env may contain secrets.').adapt(failure('Error: [object Object]'))),
			text(new SessionUpdateAdapter(() => undefined).adapt(failure('[object Object]'))),
			text(new SessionUpdateAdapter(() => 'unused').adapt(failure('File not found.'))),
		]).toEqual(['Error: Access to /w/.env was denied: .env may contain secrets.', 'the Gemini CLI did not say why', 'File not found.']);
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
