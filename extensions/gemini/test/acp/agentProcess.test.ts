/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { resolveAgentCommand } from '../../src/acp/agentProcess';

const base = { execPath: '/app/electron', env: { PATH: '/usr/bin' }, platform: 'linux' as const };

describe('resolveAgentCommand', () => {
	it('looks up gemini on PATH when no path is set', () => {
		const command = resolveAgentCommand({ ...base, cliPath: '' });
		expect(command).toMatchObject({ command: 'gemini', args: ['--acp'], shell: false });
		expect(command.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
	});

	it('runs a JavaScript entry point with the bundled Node', () => {
		const command = resolveAgentCommand({ ...base, cliPath: '/opt/gemini/bundle/gemini.js' });
		expect(command).toMatchObject({ command: '/app/electron', args: ['/opt/gemini/bundle/gemini.js', '--acp'] });
		expect(command.env.ELECTRON_RUN_AS_NODE).toBe('1');
		expect(command.env.PATH).toBe('/usr/bin');
	});

	it('starts Windows shims through a shell', () => {
		expect(resolveAgentCommand({ ...base, platform: 'win32', cliPath: undefined })).toMatchObject({ command: 'gemini.cmd', shell: true });
		expect(resolveAgentCommand({ ...base, platform: 'win32', cliPath: 'C:\\tools\\gemini.exe' })).toMatchObject({ shell: false });
	});
});
