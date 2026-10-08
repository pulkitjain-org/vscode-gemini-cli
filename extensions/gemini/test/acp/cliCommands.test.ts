/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime, AgentRuntimeState } from '../../src/acp/agentRuntime';
import { isExtensionSource, parseExtensionList, parseMemoryList, runCliCommands } from '../../src/acp/cliCommands';
import { AgentSidecar } from '../../src/acp/sidecar';
import type { FakeAgentScript } from '../fake-agent/fakeAgent';
import { fakeAgentCommand, waitFor } from '../helpers';

describe('runCliCommands', () => {
	let sidecar: AgentSidecar | undefined;
	let runtime: AgentRuntime | undefined;
	afterEach(() => {
		runtime?.dispose();
		sidecar?.dispose();
	});

	async function start(script: FakeAgentScript): Promise<AgentRuntime> {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand(script), cwd: undefined, restartDelaysMs: [] });
		const started = new AgentRuntime(sidecar);
		runtime = started;
		const ready = waitFor<AgentRuntimeState>(started.onDidChangeState, s => s.kind === 'ready');
		sidecar.start();
		await ready;
		return started;
	}

	it('runs the commands the CLI offers in one session, without counting as work, and skips the rest', async () => {
		const started = await start({
			availableCommands: [{ name: 'extensions', description: '' }, { name: 'init', description: '' }],
			turns: [
				[{ step: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[{"name":"x",' } } }, { step: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '"version":"1"}]' } } }],
				[{ step: 'session' }],
			],
		});
		let busy = false;
		started.onDidBecomeBusy(() => busy = true);
		const [extensions, memory, init] = await runCliCommands(started, '/work', ['/extensions list', '/memory list', '/init']);
		expect({ extensions: parseExtensionList(extensions!).map(e => e.name), memory, init, busy, sessions: started.sessionCount })
			.toEqual({ extensions: ['x'], memory: undefined, init: 'session:fake-session-1:/work', busy: false, sessions: 0 });
	});

	it('sends nothing when the CLI lists no commands', async () => {
		const started = await start({ turns: [[{ step: 'session' }]] });
		expect(await runCliCommands(started, '/work', ['/extensions list'], 1_000, 50)).toEqual([undefined]);
	});

	it('cancels a command that does not answer in time', async () => {
		const started = await start({
			availableCommands: [{ name: 'memory', description: '' }],
			turns: [[{ step: 'delay', ms: 300 }, { step: 'session' }], [{ step: 'auth' }]],
		});
		await expect(runCliCommands(started, '/work', ['/memory list'], 100)).rejects.toThrow('did not answer /memory list in time');
		expect(started.sessionCount).toBe(0);
	});
});

describe('CLI command replies', () => {
	it('reads /extensions list', () => {
		expect(parseExtensionList('No extensions installed.')).toEqual([]);
		const reply = JSON.stringify([{
			name: 'security', version: '1.2.0', isActive: true, path: '/h/.gemini/extensions/security',
			installMetadata: { source: 'https://github.com/gemini-cli-extensions/security', type: 'git' },
			mcpServers: { scanner: {} }, contextFiles: ['/h/GEMINI.md'], skills: [{ name: 'a' }, { name: 'b' }], hooks: {},
			resolvedSettings: [{ name: 'API key', value: 'secret' }],
		}, { name: 'off', version: '0.1.0', isActive: false }, { version: 'nameless' }], null, 2);
		const list = parseExtensionList(reply);
		expect(list).toEqual([
			{ name: 'security', version: '1.2.0', active: true, source: 'https://github.com/gemini-cli-extensions/security', kind: 'git', path: '/h/.gemini/extensions/security', mcpServers: ['scanner'], contextFiles: ['/h/GEMINI.md'], skills: 2, hooks: false },
			{ name: 'off', version: '0.1.0', active: false, mcpServers: [], contextFiles: [], skills: 0, hooks: false },
		]);
		expect(JSON.stringify(list)).not.toContain('secret');
		expect(() => parseExtensionList('[not json')).toThrow();
	});

	it('reads /memory list', () => {
		expect(parseMemoryList('No GEMINI.md files in use.')).toEqual([]);
		expect(parseMemoryList('There are 2 GEMINI.md file(s) in use:\n\n/h/.gemini/GEMINI.md\n/w/shop/GEMINI.md\n')).toEqual(['/h/.gemini/GEMINI.md', '/w/shop/GEMINI.md']);
	});

	it('accepts only plain extension sources', () => {
		expect(isExtensionSource('https://github.com/a/b')).toBe(true);
		expect(isExtensionSource('../local/ext')).toBe(true);
		expect(isExtensionSource('a; rm -rf /')).toBe(false);
		expect(isExtensionSource('"quoted"')).toBe(false);
		expect(isExtensionSource('  ')).toBe(false);
	});
});
