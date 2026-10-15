/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { parseCommand, SessionApprovals } from '../../src/acp/sessionApprovals';

describe('parseCommand', () => {
	it('finds each program of a pipeline or list, outside quotes', () => {
		expect(parseCommand('grep -iao "a | b" src/x.ts | cut -d: -f1 | head -n 10')).toEqual({ kind: 'ok', programs: ['grep', 'cut', 'head'], redirects: false });
		expect(parseCommand('cd src && ls -la; CI=1 npm test || echo failed')).toEqual({ kind: 'ok', programs: ['cd', 'ls', 'npm', 'echo'], redirects: false });
		expect(parseCommand('rg \'x;y\' --json\nwc -l file')).toEqual({ kind: 'ok', programs: ['rg', 'wc'], redirects: false });
	});

	it('notes redirection into files, but not into /dev/null or another stream', () => {
		expect(parseCommand('npm test 2>&1 | tail -n 20')).toMatchObject({ redirects: false, programs: ['npm', 'tail'] });
		expect(parseCommand('ls > /dev/null')).toMatchObject({ redirects: false, programs: ['ls'] });
		expect(parseCommand('echo hi >> notes.txt')).toMatchObject({ redirects: true, programs: ['echo'] });
		expect(parseCommand('sort <input.txt >out.txt')).toMatchObject({ redirects: true, programs: ['sort'] });
	});

	it('asks for anything that reaches the network', () => {
		for (const command of ['curl https://example.com', 'wget -q x', 'git clone git@github.com:a/b.git', 'ls && ssh host', 'grep x http://a', '/usr/bin/nc -l 80']) {
			expect(parseCommand(command)).toEqual({ kind: 'asks', reason: 'network' });
		}
	});

	it('asks for code it builds as it runs, and for what it cannot read', () => {
		for (const command of ['echo $(whoami)', 'echo `id`', 'eval "$X"', 'cat <<EOF\nx\nEOF', '(cd a && ls)', 'diff <(ls a) <(ls b)', 'echo "$(id)"', 'source env.sh']) {
			expect(parseCommand(command)).toEqual({ kind: 'asks', reason: 'dynamic' });
		}
		expect(parseCommand('echo "unclosed')).toEqual({ kind: 'asks', reason: 'unreadable' });
		expect(parseCommand('  ')).toEqual({ kind: 'asks', reason: 'unreadable' });
	});
});

describe('parseCommand and programs that run other code', () => {
	it.each([
		'GIT_SSH_COMMAND="sh -c x" git fetch', 'LD_PRELOAD=./x.so ls', 'BASH_ENV=./x.sh make', 'ls && PAGER=./x git log',
		'grep -l x . | xargs sed -i s/a/b/', 'env curl x', 'bash -c "nc host 80"', 'timeout 5 rm -rf build', 'python -c "import os"',
		'node -e 1', 'sudo ls', 'find . -name "*.tmp" -exec rm {} ;', 'find . -delete', 'awk \'BEGIN { system("id") }\'',
		'git -c core.pager=less log', './build.sh', 'scripts/run.sh --fast', 'nohup make',
	])('asks for %s', command => {
		expect(parseCommand(command)).toEqual({ kind: 'asks', reason: 'dynamic' });
	});

	it('still covers plain programs, formatting variables and absolute paths', () => {
		expect(parseCommand('LC_ALL=C sort a.txt | NO_COLOR=1 uniq -c')).toMatchObject({ kind: 'ok', programs: ['sort', 'uniq'] });
		expect(parseCommand('find src -name "*.ts" | awk \'{ print $1 }\'')).toMatchObject({ kind: 'ok', programs: ['find', 'awk'] });
		expect(parseCommand('/usr/bin/git status && git log -n 3')).toMatchObject({ kind: 'ok', programs: ['/usr/bin/git', 'git'] });
	});
});

describe('SessionApprovals', () => {
	it('stops asking for the programs allowed, as in the reported investigation', () => {
		const approvals = new SessionApprovals();
		const asked: string[] = [];
		const run = (command: string) => {
			if (approvals.covers(command).kind !== 'covered') {
				asked.push(command);
				approvals.approve(command);
			}
		};
		run('grep -iao "Socrate" /var/log/app.log | cut -c1-80 | head -n 10');
		run('grep -n "Socrate" /var/log/other.log | head -n 10');
		run('cut -d, -f2 data.csv | grep 10 | head -n 5');
		run('ls -la /var/log');
		run('ls /tmp | head');
		expect(asked).toEqual(['grep -iao "Socrate" /var/log/app.log | cut -c1-80 | head -n 10', 'ls -la /var/log']);
	});

	it('keeps asking when a command adds a redirection, the network or a new program', () => {
		const approvals = new SessionApprovals();
		expect(approvals.approve('cat a.txt | grep x')).toEqual(['cat', 'grep']);
		expect(approvals.covers('cat a > b.txt')).toEqual({ kind: 'asks', reason: 'redirect' });
		expect(approvals.covers('cat https://x')).toEqual({ kind: 'asks', reason: 'network' });
		expect(approvals.covers('cat a | sed s/a/b/')).toEqual({ kind: 'asks', reason: 'new-program' });
		expect(approvals.approve('curl x')).toBeUndefined();
		approvals.forget('grep');
		expect(approvals.covers('grep x a')).toEqual({ kind: 'asks', reason: 'new-program' });
		approvals.clear();
		expect(approvals.approved).toEqual([]);
	});
});
