/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expandTeamCommand, loadTeamCommands, mergeCommands, parseInvocation, parseToml, TeamCommand, teamCommandFolders } from '../../src/acp/slashCommands';

function team(name: string, prompt: string): TeamCommand {
	return { name, description: '', source: 'team', prompt, file: `${name}.toml` };
}

describe('parseToml', () => {
	it('reads basic and literal strings', () => {
		expect(parseToml(`# a comment\ndescription = "Say \\"hi\\"\\n"\nprompt = 'C:\\path'\n`)).toEqual({ description: 'Say "hi"\n', prompt: 'C:\\path' });
	});

	it('reads multi-line strings without the first newline', () => {
		expect(parseToml(`prompt = """\nReview {{args}}.\n  Be brief.\n"""\nother = '''\nraw \\n\n'''`)).toEqual({ prompt: 'Review {{args}}.\n  Be brief.\n', other: 'raw \\n\n' });
	});

	it('joins lines ending in a backslash in multi-line basic strings', () => {
		expect(parseToml('prompt = """one \\\n    two"""')).toEqual({ prompt: 'one two' });
	});

	it('ignores values it does not read and stops at the first table', () => {
		expect(parseToml('count = 3\nprompt = "p"\n[table]\ndescription = "no"')).toEqual({ prompt: 'p' });
	});

	it('skips an unterminated string', () => {
		expect(parseToml('prompt = "open\ndescription = "d"')).toEqual({ description: 'd' });
	});
});

describe('parseInvocation', () => {
	it('splits the name from the arguments', () => {
		expect(parseInvocation('/git:commit  fix the build\nplease ')).toEqual({ name: 'git:commit', args: 'fix the build\nplease' });
		expect(parseInvocation('/init')).toEqual({ name: 'init', args: '' });
	});

	it('is not a command without a name after the slash, or with a path', () => {
		expect(parseInvocation('/ hello')).toBeUndefined();
		expect(parseInvocation('/usr/bin is missing')).toBeUndefined();
		expect(parseInvocation('fix /init')).toBeUndefined();
	});
});

describe('expandTeamCommand', () => {
	it('puts the arguments in place of {{args}}', () => {
		expect(expandTeamCommand(team('review', 'Review {{args}} then {{args}}.'), '/review src/a.ts')).toBe('Review src/a.ts then src/a.ts.');
	});

	it('appends the invocation when the prompt takes no {{args}}', () => {
		expect(expandTeamCommand(team('plan', 'Write a plan.'), '/plan for login')).toBe('Write a plan.\n\n/plan for login');
		expect(expandTeamCommand(team('plan', 'Write a plan.'), '/plan')).toBe('Write a plan.');
	});
});

describe('mergeCommands', () => {
	it('keeps the agent command when a team command has its name', () => {
		const merged = mergeCommands(
			[{ name: 'init', description: 'cli', source: 'cli' }],
			[team('init', 'x'), team('review', 'y')],
		);
		expect(merged).toEqual([
			{ name: 'init', description: 'cli', source: 'cli' },
			{ name: 'review', description: '', source: 'team' },
		]);
	});
});

describe('loadTeamCommands', () => {
	let dir: string | undefined;

	afterEach(async () => {
		if (dir) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('names commands by their path and lets the later folder win', async () => {
		dir = await mkdtemp(path.join(tmpdir(), 'gemini-commands-'));
		const user = path.join(dir, 'user');
		const project = path.join(dir, 'project');
		await mkdir(path.join(user, 'git'), { recursive: true });
		await mkdir(project, { recursive: true });
		await writeFile(path.join(user, 'git', 'commit.toml'), 'description = "Commit"\nprompt = "Commit {{args}}"');
		await writeFile(path.join(user, 'review.toml'), 'prompt = "User review"');
		await writeFile(path.join(project, 'review.toml'), 'prompt = """\n\nProject review\nmore"""');
		await writeFile(path.join(project, 'shell.toml'), 'prompt = "Run !{git diff}"');
		await writeFile(path.join(project, 'empty.toml'), 'description = "nothing"');
		await writeFile(path.join(project, 'notes.txt'), 'prompt = "no"');

		const result = await loadTeamCommands([user, project, path.join(dir, 'missing')]);

		expect(result.commands.map(c => [c.name, c.description, c.prompt])).toEqual([
			['git:commit', 'Commit', 'Commit {{args}}'],
			['review', 'Project review', '\nProject review\nmore'],
		]);
		expect(result.skipped.map(s => path.basename(s.file)).sort()).toEqual(['empty.toml', 'shell.toml']);
	});
});

describe('teamCommandFolders', () => {
	it('reads the user folder, then the project', () => {
		expect(teamCommandFolders('/work/app', '/home/me')).toEqual([
			path.join('/home/me', '.gemini', 'commands'),
			path.join('/work/app', '.gemini', 'commands'),
		]);
		expect(teamCommandFolders('/home/me', '/home/me')).toHaveLength(1);
	});
});
