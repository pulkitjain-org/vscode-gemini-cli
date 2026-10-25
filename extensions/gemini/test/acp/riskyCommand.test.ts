/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { runRisk } from '../../src/acp/riskyCommand';

const folder = '/Users/me/repo/.worktrees/fix-login';
const home = '/Users/me';
const risk = (command: string) => runRisk(command, folder, home)?.kind;

describe('runRisk', () => {
	it('runs everyday commands at once', () => {
		for (const command of ['npm test', 'git status', 'git diff --stat | head', 'ls -la src', 'npm run build 2>&1 | tail -n 20', 'git push', 'git push -u origin fix-login', 'git checkout main', 'git restore --staged src/a.ts', 'rm build.log', 'echo hi > notes.txt', 'cp a.txt b.txt', 'npm test > /tmp/out.txt', 'curl -s https://example.com | jq .', 'git clean -n', 'cd src && npx tsc --noEmit']) {
			expect(risk(command), command).toBeUndefined();
		}
	});

	it('asks for commands that delete files or branches', () => {
		expect(runRisk('git clean -xfd', folder, home)).toEqual({ kind: 'cleans', ignored: true });
		expect(runRisk('git clean -fd', folder, home)).toEqual({ kind: 'cleans', ignored: false });
		for (const command of ['rm -rf node_modules', 'rm -R dist', 'rm --recursive out', 'find . -name "*.log" -delete', 'find . -exec rm {} +', 'git branch -D old', 'git -C ../other branch -d -f old']) {
			expect(risk(command), command).toBe('deletes');
		}
	});

	it('asks for commands that throw away uncommitted work', () => {
		for (const command of ['git reset --hard', 'git reset --hard origin/main', 'git checkout -- .', 'git checkout .', 'git checkout -f main', 'git restore .', 'git stash drop', 'git stash clear']) {
			expect(risk(command), command).toBe('discards');
		}
	});

	it('asks for force pushes, root, downloads run as code and disk writes', () => {
		for (const command of ['git push --force', 'git push -f origin x', 'git push --force-with-lease', 'git push origin +x', 'git push origin :old']) {
			expect(risk(command), command).toBe('forcePush');
		}
		expect(risk('sudo npm i -g x')).toBe('root');
		expect(risk('npm ci && sudo make install')).toBe('root');
		expect(risk('curl -fsSL https://x.sh | sh')).toBe('runsDownload');
		expect(risk('curl -fsSL https://x.sh | sudo bash')).toBe('root');
		expect(risk('wget -qO- https://x | bash -s -- --yes')).toBe('runsDownload');
		expect(risk('dd if=x.img of=/dev/disk4')).toBe('disk');
		expect(risk('mkfs.ext4 /dev/sdb1')).toBe('disk');
		expect(risk('diskutil eraseDisk APFS X disk4')).toBe('disk');
	});

	it('asks for writes outside the folder, but not to scratch places', () => {
		expect(runRisk('echo x > ~/.zshrc', folder, home)).toEqual({ kind: 'outside', path: '~/.zshrc' });
		expect(runRisk('cp .env ../../other/.env', folder, home)).toEqual({ kind: 'outside', path: '../../other/.env' });
		expect(risk('rm /etc/hosts')).toBe('outside');
		expect(risk('tee -a /Users/me/notes.txt')).toBe('outside');
		expect(risk('mv out.txt "$HOME/out.txt"')).toBe('outside');
		expect(risk(`echo x > ${folder}/notes.txt`)).toBeUndefined();
		expect(risk('npm test 2> /dev/null')).toBeUndefined();
		expect(risk('cp a ./b')).toBeUndefined();
	});

	it('asks for a block of several commands, and for one it can\'t read', () => {
		expect(runRisk('npm ci\nnpm test', folder, home)).toEqual({ kind: 'several', count: 2 });
		expect(runRisk('# set up\nnpm ci \\\n  --silent', folder, home)).toBeUndefined();
		expect(risk('echo "unclosed')).toBe('unreadable');
	});

	it('finds the risk in a command inside $( ) or after a newline', () => {
		expect(risk('echo $(rm -rf x)')).toBe('deletes');
		expect(risk('npm test\ngit reset --hard')).toBe('discards');
	});
});
