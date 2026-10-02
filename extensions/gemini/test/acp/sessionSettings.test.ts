/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient, AgentClientState } from '../../src/acp/agentClient';
import { readSessionSettings, SessionSettings } from '../../src/acp/sessionSettings';
import { AgentSidecar } from '../../src/acp/sidecar';
import type { ChatEvent } from '../../src/acp/sessionUpdates';
import type { FakeAgentScript } from '../fake-agent/fakeAgent';
import { fakeAgentCommand, waitFor } from '../helpers';

/** What gemini-cli 0.62 returns from `session/new`. */
const geminiSession = {
	sessionId: 's1',
	modes: {
		currentModeId: 'default',
		availableModes: [
			{ id: 'default', name: 'Default', description: 'Prompts for approval' },
			{ id: 'autoEdit', name: 'Auto Edit', description: 'Auto-approves edit tools' },
			{ id: 'yolo', name: 'YOLO', description: 'Auto-approves all tools' },
		],
	},
	models: {
		currentModelId: 'auto',
		availableModels: [
			{ modelId: 'auto', name: 'Auto', description: 'Picks the model per request' },
			{ modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
			{ modelId: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
		],
	},
};

describe('readSessionSettings', () => {
	it('reads the modes and the models the agent offers', () => {
		const settings = readSessionSettings(geminiSession as acp.NewSessionResponse);
		expect(settings.mode).toEqual({
			currentId: 'default',
			available: [
				{ id: 'default', name: 'Default', description: 'Prompts for approval' },
				{ id: 'autoEdit', name: 'Auto Edit', description: 'Auto-approves edit tools' },
				{ id: 'yolo', name: 'YOLO', description: 'Auto-approves all tools' },
			],
		});
		expect(settings.model?.currentId).toBe('auto');
		expect(settings.model?.available.map(m => m.id)).toEqual(['auto', 'gemini-2.5-pro', 'gemini-2.5-flash']);
	});

	it('offers no control when the agent reports nothing to choose from', () => {
		expect(readSessionSettings({ sessionId: 's1' })).toEqual({});
		expect(readSessionSettings({ sessionId: 's1', modes: { currentModeId: 'a', availableModes: [{ id: 'a', name: 'A' }] } })).toEqual({});
		expect(readSessionSettings({ sessionId: 's1', models: { currentModelId: 1, availableModels: 'x' } } as never)).toEqual({});
	});
});

describe('AgentClient session settings', () => {
	let sidecar: AgentSidecar | undefined;
	let client: AgentClient | undefined;

	afterEach(() => {
		client?.dispose();
		sidecar?.dispose();
	});

	async function start(script: FakeAgentScript): Promise<AgentClient> {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand(script), cwd: undefined, restartDelaysMs: [] });
		client = new AgentClient(sidecar, { cwd: process.cwd(), requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) });
		const settled = waitFor<AgentClientState>(client.onDidChangeState, s => s.kind === 'ready' || s.kind === 'error');
		sidecar.start();
		expect(await settled).toMatchObject({ kind: 'ready' });
		return client;
	}

	const { sessionId: _, ...newSession } = geminiSession;

	it('changes the mode and follows the agent\'s mode updates', async () => {
		const client = await start({ newSession });
		expect(client.settings.mode?.currentId).toBe('default');
		const changed = waitFor<SessionSettings>(client.onDidChangeSettings, s => s.mode?.currentId === 'autoEdit');
		await client.setMode('autoEdit');
		await changed;
		expect(client.settings.mode?.currentId).toBe('autoEdit');
	});

	it('changes the model when the agent supports it', async () => {
		const client = await start({ newSession, supportsSetModel: true, turns: [[{ step: 'model' }]] });
		await client.setModel('gemini-2.5-flash');
		expect(client.settings.model?.currentId).toBe('gemini-2.5-flash');
		const events: ChatEvent[] = [];
		client.onDidReceiveEvent(e => events.push(e));
		await client.prompt('which model?');
		expect(events).toContainEqual(expect.objectContaining({ kind: 'text', text: 'model:gemini-2.5-flash' }));
	});

	it('hides the model control when the agent does not implement set_model', async () => {
		const client = await start({ newSession, supportsSetModel: false });
		await client.setModel('gemini-2.5-flash');
		expect(client.settings.model).toBeUndefined();
		expect(client.settings.mode).toBeDefined();
	});

	it('ignores choices the agent did not offer', async () => {
		const client = await start({ newSession, supportsSetModel: true });
		await client.setModel('made-up-model');
		expect(client.settings.model?.currentId).toBe('auto');
	});

	it('starts a new session on the same agent', async () => {
		const client = await start({ newSession });
		const ready = waitFor<AgentClientState>(client.onDidChangeState, s => s.kind === 'ready');
		await client.newSession();
		expect(await ready).toMatchObject({ kind: 'ready', sessionId: 'fake-session-2' });
		expect(client.settings.mode?.currentId).toBe('default');
	});
});
