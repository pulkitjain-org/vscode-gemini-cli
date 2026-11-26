/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { blockCommands, canRun, commandCount, commandFromReply, commandName, commandReport, OutputTail, placeFor, plainTerminalText, selectionReport } from '../../src/acp/runCommands';

describe('canRun', () => {
	it('runs shell blocks only', () => {
		expect(['sh', 'bash', 'zsh', 'shell', 'console', 'fish', 'powershell', 'ps1', 'Bash'].every(canRun)).toBe(true);
		expect(['', 'ts', 'json', 'text', 'python'].some(canRun)).toBe(false);
	});
});

describe('blockCommands', () => {
	it('runs only the prompted lines of a console block, without the prompt', () => {
		expect(blockCommands('console', '$ npm test\n> fake@1.0.0 test\nok\n$ git status\n')).toBe('npm test\ngit status');
		expect(blockCommands('console', 'PS C:\\repo> npm test\nok\n> dir')).toBe('npm test\ndir');
		expect(blockCommands('console', 'just output')).toBe('');
	});

	it('takes a $ prompt off every line when every line has one', () => {
		expect(blockCommands('bash', '$ npm ci\n$ npm test\n')).toBe('npm ci\nnpm test');
		expect(blockCommands('bash', 'echo $ x\nls\n')).toBe('echo $ x\nls');
		expect(blockCommands('sh', 'git clean -xfd\r\n')).toBe('git clean -xfd');
	});
});

describe('commandFromReply', () => {
	it('takes the command out of a fenced or prompted answer', () => {
		expect(commandFromReply('```bash\n$ du -sh * | sort -h | tail\n```')).toBe('du -sh * | sort -h | tail');
		expect(commandFromReply('`ls -la`')).toBe('ls -la');
		expect(commandFromReply('git log --oneline -5\n')).toBe('git log --oneline -5');
	});
});

describe('commandCount', () => {
	it('counts lines that run, joining continued lines', () => {
		expect(commandCount('npm ci \\\n  --silent\n# then\nnpm test\n\n')).toBe(2);
	});
});

describe('placeFor', () => {
	const places = [{ name: 'api', folder: '/w/t/api' }, { name: 'web', folder: '/w/t/web' }];

	it('takes the only place, or the one place a command names', () => {
		expect(placeFor('npm test', places.slice(0, 1))).toEqual(places[0]);
		expect(placeFor('cd web && npm test', places)).toEqual(places[1]);
		expect(placeFor('npm --prefix /w/t/api test', places)).toEqual(places[0]);
		expect(placeFor('cat api/README.md', places)).toEqual(places[0]);
	});

	it('asks when no place, or more than one, is named', () => {
		expect(placeFor('npm test', places)).toBeUndefined();
		expect(placeFor('diff api/a web/a', places)).toBeUndefined();
		expect(placeFor('npm run rapid', places)).toBeUndefined();
	});
});

describe('OutputTail', () => {
	it('keeps the last lines as plain text, across chunks that split lines and sequences', () => {
		const tail = new OutputTail(3);
		tail.push('\x1b[32mone\x1b[0m\ntw');
		tail.push('o\nthree\nfour\n\x1b]633;D;0\x07');
		tail.push('progress 10%\rprogress 100%');
		expect(tail.finish()).toEqual({ lines: ['three', 'four', 'progress 100%'], dropped: 2 });
	});

	it('keeps the last line of a chunk that ends in \\r\\n, as zsh and npm write it', () => {
		const tail = new OutputTail();
		tail.push('\x1b]633;C\x07');
		tail.push('\r\n> test\r\n> echo running tests && exit 3\r\n\r\nrunning tests\r\n\u2819\x1b[1G\x1b[0K\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m      \r \r');
		expect(tail.finish()).toEqual({ lines: ['> test', '> echo running tests && exit 3', '', 'running tests'], dropped: 0 });
	});

	it('drops empty lines at either end', () => {
		const tail = new OutputTail();
		tail.push('\n\nok\n\n\n');
		expect(tail.finish()).toEqual({ lines: ['ok'], dropped: 0 });
	});
});

describe('reports', () => {
	it('sends the command, where it ran, its exit code and its output', () => {
		expect(commandReport({ commandLine: 'npm test', cwd: '/w/repo', exitCode: 1, lines: ['FAIL a.test.ts'], dropped: 40 })).toBe([
			'$ npm test', '# in /w/repo', '# exit code 1', '# output: the last 1 lines (40 earlier lines left out)', 'FAIL a.test.ts',
		].join('\n'));
		expect(commandReport({ commandLine: 'ls', lines: [], dropped: 0 })).toBe('$ ls');
	});

	it('caps a selection to its last lines, and names a long command short', () => {
		expect(selectionReport('a\nb\nc', 2)).toBe('# the last 2 lines of 3 selected\nb\nc');
		expect(selectionReport('\x1b[1mbold\x1b[0m')).toBe('bold');
		expect(commandName('npm run build -- --watch --verbose --mode=production', 20)).toBe('npm run build -- --…');
		expect(plainTerminalText('a\r\nb')).toBe('a\nb');
	});
});
