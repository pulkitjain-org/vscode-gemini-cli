/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime, AgentRuntimeState } from '../../src/acp/agentRuntime';
import { isExtensionSource, parseExtensionList, parseMemoryList, runCliCommand } from '../../src/acp/cliCommands';
import { AgentSidecar } from '../../src/acp/sidecar';
import { fakeAgentCommand, waitFor } from '../helpers';

describe('runCliCommand', () => {
	let sidecar: AgentSidecar | undefined;
	let runtime: AgentRuntime | undefined;
	afterEach(() => {
		runtime?.dispose();
		sidecar?.dispose();
	});

	it('returns what the command replied, in a session of its own, without counting as work', async () => {
		sidecar = new AgentSidecar({
			command: () => fakeAgentCommand({ turns: [[{ step: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[{"name":"x",' } } }, { step: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '"version":"1"}]' } } }]] }),
			cwd: undefined, restartDelaysMs: [],
		});
		runtime = new AgentRuntime(sidecar);
		const ready = waitFor<AgentRuntimeState>(runtime.onDidChangeState, s => s.kind === 'ready');
		sidecar.start();
		await ready;
		let busy = false;
		runtime.onDidBecomeBusy(() => busy = true);
		const reply = await runCliCommand(runtime, '/work', '/extensions list');
		expect(parseExtensionList(reply).map(e => e.name)).toEqual(['x']);
		expect(busy).toBe(false);
		expect(runtime.sessionCount).toBe(0);
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
