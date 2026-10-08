/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { TeamCommand } from '../../src/acp/slashCommands';
import { ExpansionHost, expandTeamCommandWithInjections, findInjections, quoteShellArg, runShellCommand, TeamCommandCancelled } from '../../src/acp/teamCommandExpansion';

function team(prompt: string): TeamCommand {
	return { name: 'cmd', description: '', source: 'team', prompt, file: 'cmd.toml' };
}

function host(overrides: Partial<ExpansionHost> = {}): ExpansionHost & { ran: string[]; asked: string[][] } {
	const ran: string[] = [];
	const asked: string[][] = [];
	return {
		platform: 'linux',
		readFile: async p => p === 'README.md' ? 'readme text' : Promise.reject(new Error('not found in the workspace')),
		confirm: async commands => { asked.push([...commands]); return true; },
		runShell: async command => { ran.push(command); return { output: `out(${command})`, exitCode: 0 }; },
		...overrides,
		ran,
		asked,
	};
}

describe('findInjections', () => {
	it('finds both kinds in order and counts nested braces', () => {
		expect(findInjections('a !{echo {x,y}} b @{ f.md } c', 'cmd').map(i => [i.kind, i.content])).toEqual([['shell', 'echo {x,y}'], ['file', 'f.md']]);
	});

	it('refuses an unclosed one', () => {
		expect(() => findInjections('run !{git diff', 'cmd')).toThrow(/unclosed !\{/);
	});
});

describe('expandTeamCommandWithInjections', () => {
	it('expands a plain template as before', async () => {
		const h = host();
		expect(await expandTeamCommandWithInjections(team('Review {{args}}'), '/cmd main.ts', h)).toEqual({ text: 'Review main.ts', problems: [] });
		expect(h.asked).toEqual([]);
	});

	it('pulls in files and command output, quoting the arguments only for the shell', async () => {
		const h = host();
		const result = await expandTeamCommandWithInjections(team('Diff:\n!{git diff {{args}}}\nDocs: @{README.md}\nFocus on {{args}}'), `/cmd it's`, h);
		expect(h.asked).toEqual([[`git diff 'it'\\''s'`]]);
		expect(result.text).toBe(`Diff:\nout(git diff 'it'\\''s')\nDocs: readme text\nFocus on it's`);
		expect(result.problems).toEqual([]);
	});

	it('keeps a file it cannot read as written and reports why', async () => {
		const result = await expandTeamCommandWithInjections(team('See @{missing.md}'), '/cmd', host());
		expect(result.text).toBe('See @{missing.md}');
		expect(result.problems).toEqual(['@{missing.md}: not found in the workspace']);
	});

	it('appends the invocation when the template has no {{args}}, like the CLI', async () => {
		expect((await expandTeamCommandWithInjections(team('Read @{README.md}'), '/cmd quickly', host())).text).toBe('Read readme text\n\n/cmd quickly');
	});

	it('notes a failing command and runs nothing when the user says no', async () => {
		const failing = host({ runShell: async () => ({ output: 'boom', exitCode: 2 }) });
		expect((await expandTeamCommandWithInjections(team('!{make}'), '/cmd', failing)).text).toBe(`boom\n[Shell command 'make' exited with code 2]`);
		const refused = host({ confirm: async () => false });
		await expect(expandTeamCommandWithInjections(team('!{make}'), '/cmd', refused)).rejects.toBeInstanceOf(TeamCommandCancelled);
		expect(refused.ran).toEqual([]);
	});

	it('does not run commands found in file contents', async () => {
		const h = host({ readFile: async () => '!{rm -rf /}' });
		expect((await expandTeamCommandWithInjections(team('@{x}'), '/cmd', h)).text).toBe('!{rm -rf /}');
		expect(h.ran).toEqual([]);
	});
});

describe('quoteShellArg', () => {
	it('quotes for sh and cmd.exe', () => {
		expect(quoteShellArg(`a 'b'`, 'darwin')).toBe(`'a '\\''b'\\'''`);
		expect(quoteShellArg('a "b"', 'win32')).toBe('"a ""b"""');
	});
});

describe('runShellCommand', () => {
	it.skipIf(process.platform === 'win32')('captures output and the exit code', async () => {
		expect(await runShellCommand('echo hi; echo err >&2; exit 3', process.cwd(), process.env)).toMatchObject({ output: 'hi\nerr\n', exitCode: 3 });
	});

	it.skipIf(process.platform === 'win32')('stops a command that runs too long', async () => {
		expect(await runShellCommand('sleep 5', process.cwd(), process.env, 100)).toMatchObject({ timedOut: true });
	});
});
