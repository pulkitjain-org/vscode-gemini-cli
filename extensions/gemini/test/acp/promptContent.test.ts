/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient, AgentClientState } from '../../src/acp/agentClient';
import { attachmentLabel } from '../../src/acp/attachments';
import { buildPromptContent, readPromptCapabilities } from '../../src/acp/promptContent';
import type { ChatEvent } from '../../src/acp/sessionUpdates';
import { AgentSidecar } from '../../src/acp/sidecar';
import { fakeAgentCommand, waitFor } from '../helpers';

const all = { image: true, embeddedContext: true };
const none = { image: false, embeddedContext: false };
const selection = { kind: 'selection', path: '/w/src/app.ts', text: 'const a = 1;', startLine: 10, endLine: 12, languageId: 'typescript' } as const;

describe('buildPromptContent', () => {
	it('sends files as resource links the agent reads itself', () => {
		expect(buildPromptContent('explain', [{ kind: 'file', path: '/w/a b.ts' }], all)).toEqual([
			{ type: 'text', text: 'explain' },
			{ type: 'resource_link', uri: 'file:///w/a%20b.ts', name: 'a b.ts' },
		]);
	});

	it('embeds selections when the agent allows it, and inlines them as text otherwise', () => {
		expect(buildPromptContent('fix', [selection], all)[1]).toEqual({
			type: 'resource', resource: { uri: 'file:///w/src/app.ts#L10-L12', text: 'const a = 1;', mimeType: 'text/plain' },
		});
		expect(buildPromptContent('fix', [selection], none)[1]).toEqual({
			type: 'text', text: 'app.ts:10-12 (/w/src/app.ts):\n```typescript\nconst a = 1;\n```',
		});
	});

	it('sends images only to agents that take them, and skips empty text', () => {
		const image = { kind: 'image', name: 'shot.png', mimeType: 'image/png', data: 'iVBOR' } as const;
		expect(buildPromptContent('  ', [image], all)).toEqual([{ type: 'image', data: 'iVBOR', mimeType: 'image/png' }]);
		expect(buildPromptContent('look', [image], none)).toEqual([{ type: 'text', text: 'look' }]);
	});
});

describe('attachment helpers', () => {
	it('labels attachments', () => {
		expect(attachmentLabel({ kind: 'file', path: 'C:\\w\\a.ts' })).toBe('a.ts');
		expect(attachmentLabel(selection)).toBe('app.ts:10-12');
		expect(attachmentLabel({ ...selection, endLine: 10 })).toBe('app.ts:10');
	});

	it('reads prompt capabilities, defaulting to text only', () => {
		expect(readPromptCapabilities(undefined)).toEqual(none);
		expect(readPromptCapabilities({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } } })).toEqual(all);
	});
});

describe('prompting with attachments', () => {
	let sidecar: AgentSidecar | undefined;
	let client: AgentClient | undefined;

	afterEach(() => {
		client?.dispose();
		sidecar?.dispose();
	});

	it('reaches the agent as built, using the capabilities it advertised', async () => {
		sidecar = new AgentSidecar({
			command: () => fakeAgentCommand({
				initialize: { agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } } },
				turns: [[{ step: 'prompt' }]],
			}),
			cwd: undefined,
			restartDelaysMs: [],
		});
		client = new AgentClient(sidecar, { cwd: process.cwd(), requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) });
		const ready = waitFor<AgentClientState>(client.onDidChangeState, s => s.kind === 'ready');
		sidecar.start();
		await ready;
		expect(client.promptCapabilities).toEqual(all);

		const echoed = waitFor<ChatEvent>(client.onDidReceiveEvent, e => e.kind === 'text');
		const content = buildPromptContent('explain', [{ kind: 'file', path: '/w/a.ts' }, selection], client.promptCapabilities);
		expect(await client.prompt(content)).toBe('end_turn');
		const event = await echoed;
		expect(event.kind === 'text' && JSON.parse(event.text.slice('prompt:'.length))).toEqual(content);
	});
});
