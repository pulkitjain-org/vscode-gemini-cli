/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { cliHeapSizeMb, includeDirectoryArgs, resolveAgentCommand } from '../../src/acp/agentProcess';

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

	it('tells the agent not to relaunch itself and sets its heap instead', () => {
		const script = resolveAgentCommand({ ...base, cliPath: '/opt/gemini/bundle/gemini.js', heapSizeMb: 8192 });
		expect(script.args).toEqual(['--max-old-space-size=8192', '/opt/gemini/bundle/gemini.js', '--acp']);
		expect(script.env.GEMINI_CLI_NO_RELAUNCH).toBe('true');
		expect(script.env.NODE_OPTIONS).toBeUndefined();

		const executable = resolveAgentCommand({ ...base, env: { NODE_OPTIONS: '--enable-source-maps' }, cliPath: '', heapSizeMb: 8192 });
		expect(executable.args).toEqual(['--acp']);
		expect(executable.env.GEMINI_CLI_NO_RELAUNCH).toBe('true');
		expect(executable.env.NODE_OPTIONS).toBe('--enable-source-maps --max-old-space-size=8192');
	});

	it('leaves the interactive CLI as it is', () => {
		const command = resolveAgentCommand({ ...base, cliPath: '', interactive: true, heapSizeMb: 8192 });
		expect(command.env.GEMINI_CLI_NO_RELAUNCH).toBeUndefined();
		expect(command.env.NODE_OPTIONS).toBeUndefined();
	});

	it('starts Windows shims through a shell', () => {
		expect(resolveAgentCommand({ ...base, platform: 'win32', cliPath: undefined })).toMatchObject({ command: 'gemini.cmd', shell: true });
		expect(resolveAgentCommand({ ...base, platform: 'win32', cliPath: 'C:\\tools\\gemini.exe' })).toMatchObject({ shell: false });
	});
});

describe('cliHeapSizeMb', () => {
	const sixteenGb = 16 * 1024 * 1024 * 1024;

	it('is half the machine memory, like the CLI', () => {
		expect(cliHeapSizeMb(undefined, sixteenGb)).toBe(8192);
		expect(cliHeapSizeMb('{"advanced":{}}', sixteenGb)).toBe(8192);
		expect(cliHeapSizeMb('not json', sixteenGb)).toBe(8192);
	});

	it('honours autoConfigureMemory: false', () => {
		expect(cliHeapSizeMb('{"advanced":{"autoConfigureMemory":false}}', sixteenGb)).toBeUndefined();
	});
});

describe('includeDirectoryArgs', () => {
	it('passes every folder of a multi-root window, and nothing for one folder', () => {
		expect(includeDirectoryArgs(['/a'])).toEqual([]);
		expect(includeDirectoryArgs(['/a', '/b c'])).toEqual(['--include-directories', '/a', '--include-directories', '/b c']);
	});

	it('leaves out a folder with a comma, which the CLI would split', () => {
		expect(includeDirectoryArgs(['/a', '/x,y'])).toEqual(['--include-directories', '/a']);
	});
});
