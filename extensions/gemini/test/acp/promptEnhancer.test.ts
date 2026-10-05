/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentConnection } from '../../src/acp/agentConnection';
import { AgentRuntime, AgentRuntimeState } from '../../src/acp/agentRuntime';
import { EnhanceCancelledError, enhanceHistory, enhanceModel, PromptEnhancer, type PromptEnhancerOptions } from '../../src/acp/promptEnhancer';
import { AgentSidecar } from '../../src/acp/sidecar';
import type { FakeAgentScript, ScriptedStep } from '../fake-agent/fakeAgent';
import { fakeAgentCommand, waitFor } from '../helpers';

const offered: FakeAgentScript['newSession'] = {
	modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] },
	models: { currentModelId: 'auto', availableModels: [{ modelId: 'auto', name: 'Auto' }, { modelId: 'gemini-9-flash', name: 'Flash' }, { modelId: 'gemini-9-flash-lite', name: 'Flash-Lite' }] },
} as FakeAgentScript['newSession'];

const reply = (text: string): ScriptedStep => ({ step: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });

describe('enhanceModel', () => {
	it('prefers Flash-Lite, then Flash, from what the agent offers', () => {
		const choices = (...ids: string[]) => ({ currentId: ids[0], available: ids.map(id => ({ id, name: id })) });
		expect(enhanceModel(choices('auto', 'gemini-9-pro', 'gemini-9-flash', 'gemini-9-flash-lite'))).toBe('gemini-9-flash-lite');
		expect(enhanceModel(choices('auto', 'gemini-9-pro', 'gemini-9-flash'))).toBe('gemini-9-flash');
		expect(enhanceModel(choices('auto', 'gemini-9-pro'))).toBeUndefined();
		expect(enhanceModel(undefined)).toBeUndefined();
	});
});

describe('enhanceHistory', () => {
	it('keeps the latest user and agent messages, oldest first', () => {
		const items = [
			{ id: '1', kind: 'user' as const, text: 'first' },
			{ id: '2', kind: 'thought' as const, text: 'hmm' },
			{ id: '3', kind: 'agent' as const, text: 'reply' },
			{ id: '4', kind: 'notice' as const, text: 'note', severity: 'info' as const },
			...Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, kind: i % 2 ? 'agent' as const : 'user' as const, text: `m${i}` })),
			{ id: 'e', kind: 'agent' as const, text: '  ' },
		];
		expect(enhanceHistory(items)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5'].map((text, i) => ({ role: i % 2 ? 'agent' : 'user', text })));
		expect(enhanceHistory(items.slice(0, 4))).toEqual([{ role: 'user', text: 'first' }, { role: 'agent', text: 'reply' }]);
	});
});

describe('PromptEnhancer', () => {
	let sidecar: AgentSidecar | undefined;
	let runtime: AgentRuntime | undefined;
	let enhancer: PromptEnhancer | undefined;
	const cwd = mkdtempSync(path.join(tmpdir(), 'enhance-test-'));

	afterEach(() => {
		vi.restoreAllMocks();
		enhancer?.dispose();
		runtime?.dispose();
		sidecar?.dispose();
	});

	async function start(script: FakeAgentScript, timeoutMs?: number, more: Partial<PromptEnhancerOptions> = {}) {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand(script), cwd: undefined, restartDelaysMs: [] });
		runtime = new AgentRuntime(sidecar);
		const ready = waitFor<AgentRuntimeState>(runtime.onDidChangeState, s => s.kind === 'ready');
		sidecar.start();
		await ready;
		enhancer = new PromptEnhancer(runtime, { cwd, timeoutMs, ...more });
		return { runtime, enhancer };
	}

	it('rewrites in a Plan-mode session on the Flash-Lite model, in its own folder', async () => {
		const setMode = vi.spyOn(AgentConnection.prototype, 'setMode');
		const { enhancer } = await start({
			newSession: offered,
			supportsSetModel: true,
			turns: [[{ step: 'session' }, reply(' '), { step: 'model' }]],
		});
		const text = await enhancer.enhance({ draft: 'fix it' });
		expect(text).toBe(`session:fake-session-1:${cwd} model:gemini-9-flash-lite`);
		expect(setMode).toHaveBeenCalledWith('fake-session-1', 'plan');
	});

	it('leaves out message text sent outside the rewrite, such as the mode change notice', async () => {
		const { enhancer } = await start({ newSession: offered, supportsSetModel: true, modeUpdateText: true, turns: [[reply('Fix the login bug.')]] });
		expect(await enhancer.enhance({ draft: 'fix login' })).toBe('Fix the login bug.');
	});

	it('starts the agent when it is not running, and waits for it', async () => {
		const { runtime, enhancer } = await start({ turns: [[reply('Done.')]] });
		const stopped = waitFor<AgentRuntimeState>(runtime.onDidChangeState, s => s.kind === 'idle');
		sidecar!.stop();
		await stopped;
		const startAgent = vi.fn(() => sidecar!.start());
		const restarted = new PromptEnhancer(runtime, { cwd, start: startAgent });
		try {
			expect(await restarted.enhance({ draft: 'x' })).toBe('Done.');
			expect(startAgent).toHaveBeenCalledOnce();
		} finally {
			restarted.dispose();
		}
		void enhancer;
	});

	it('keeps the spare session when cancelled before the agent is ready', async () => {
		const { runtime, enhancer } = await start({ turns: [[{ step: 'session' }]] });
		const newSession = vi.spyOn(runtime, 'newSession');
		enhancer.prepare();
		const abort = new AbortController();
		abort.abort();
		await expect(enhancer.enhance({ draft: 'x' }, abort.signal)).rejects.toBeInstanceOf(EnhanceCancelledError);
		expect(await enhancer.enhance({ draft: 'x' })).toBe(`session:fake-session-1:${cwd}`);
		// The spare, then the one after it.
		await vi.waitFor(() => expect(newSession).toHaveBeenCalledTimes(2));
	});

	it('rewrites with a direct request when it can, opening no session', async () => {
		const direct = vi.fn(async (request: { system: string; prompt: string }) => `Here is the improved prompt:\nFix it. (${request.prompt.includes('fix it') ? 'draft' : 'no draft'})`);
		const { runtime, enhancer } = await start({ turns: [[reply('from the CLI')]] }, undefined, { direct });
		const newSession = vi.spyOn(runtime, 'newSession');
		enhancer.prepare();
		expect(await enhancer.enhance({ draft: 'fix it' })).toBe('Fix it. (draft)');
		expect(direct.mock.calls[0][0].system).toContain('never answer it');
		expect(newSession).not.toHaveBeenCalled();
	});

	it('asks the CLI when direct requests are off, or fail, and skips them for a while after a failure', async () => {
		const off = await start({ turns: [[reply('from the CLI')], [reply('from the CLI')], [reply('again')]] }, undefined, { direct: async () => undefined });
		expect(await off.enhancer.enhance({ draft: 'x' })).toBe('from the CLI');
		off.enhancer.dispose();
		const direct = vi.fn(async () => {
			throw new Error('429');
		});
		const onDirectFailed = vi.fn();
		const failing = new PromptEnhancer(off.runtime, { cwd, direct, onDirectFailed });
		try {
			expect(await failing.enhance({ draft: 'x' })).toBe('from the CLI');
			expect(onDirectFailed).toHaveBeenCalledOnce();
			expect(await failing.enhance({ draft: 'y' })).toBe('again');
			expect(direct).toHaveBeenCalledOnce();
		} finally {
			failing.dispose();
		}
	});

	it('stops a direct request when cancelled, without asking the CLI', async () => {
		const direct = vi.fn((request: { signal: AbortSignal }) => new Promise<string>((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')))));
		const { runtime, enhancer } = await start({ turns: [[reply('late')]] }, undefined, { direct });
		const newSession = vi.spyOn(runtime, 'newSession');
		const abort = new AbortController();
		const enhancing = enhancer.enhance({ draft: 'x' }, abort.signal);
		setTimeout(() => abort.abort(), 20);
		await expect(enhancing).rejects.toBeInstanceOf(EnhanceCancelledError);
		expect(direct.mock.calls[0][0].signal.aborted).toBe(true);
		expect(newSession).not.toHaveBeenCalled();
	});

	it('sends the enhancement prompt with the draft', async () => {
		const { enhancer } = await start({ turns: [[{ step: 'prompt' }]] });
		const text = await enhancer.enhance({ draft: 'make login faster' });
		expect(text).toContain('never answer it');
		expect(text).toContain('Do not use any tools');
		expect(text).toContain('<request>\\nmake login faster\\n</request>');
	});

	it('cleans the reply', async () => {
		const { enhancer } = await start({ turns: [[reply('Here is the improved prompt:\nFix the empty-email login bug.')]] });
		expect(await enhancer.enhance({ draft: 'fix login' })).toBe('Fix the empty-email login bug.');
	});

	it('opens the next session ahead, so a rewrite only waits for the model', async () => {
		const { runtime, enhancer } = await start({ turns: [[reply('One.')], [{ step: 'session' }]] });
		const newSession = vi.spyOn(runtime, 'newSession');
		await enhancer.enhance({ draft: 'one' });
		await vi.waitFor(() => expect(newSession).toHaveBeenCalledTimes(2));
		// The second rewrite runs in the session opened after the first.
		expect(await enhancer.enhance({ draft: 'two' })).toBe(`session:fake-session-2:${cwd}`);
		// And it opens the one after.
		expect(newSession).toHaveBeenCalledTimes(3);
	});

	it('refuses any permission request', async () => {
		const { enhancer } = await start({
			turns: [[{ step: 'permission', request: { toolCall: { toolCallId: 't1', title: 'Write file' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } }]],
		});
		expect(await enhancer.enhance({ draft: 'x' })).toBe('permission:cancelled');
	});

	it('stops when cancelled', async () => {
		const { enhancer } = await start({ turns: [[{ step: 'delay', ms: 5000 }, reply('late')]] });
		const abort = new AbortController();
		const enhancing = enhancer.enhance({ draft: 'x' }, abort.signal);
		setTimeout(() => abort.abort(), 50);
		await expect(enhancing).rejects.toBeInstanceOf(EnhanceCancelledError);
	});

	it('gives up after the timeout', async () => {
		const { enhancer } = await start({ turns: [[{ step: 'delay', ms: 5000 }, reply('late')]] }, 100);
		await expect(enhancer.enhance({ draft: 'x' })).rejects.toThrow(/longer than/);
	});

	it('says so when the agent sends nothing back', async () => {
		const { enhancer } = await start({ turns: [[]] });
		await expect(enhancer.enhance({ draft: 'x' })).rejects.toThrow(/no prompt/);
	});

	it('passes on a setup error from the agent', async () => {
		const { enhancer } = await start({ newSession: { error: { code: -32000, message: 'This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var.' } } });
		await expect(enhancer.enhance({ draft: 'x' })).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/);
	});
});
