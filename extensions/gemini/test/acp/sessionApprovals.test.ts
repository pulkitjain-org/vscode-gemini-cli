/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { decidesWhatRuns, isBuildFile, isGitHookFile, isIgnoreFile, isProtectedSetting, isReadOnlyGitRead, parseCommand, SessionApprovals } from '../../src/acp/sessionApprovals';

describe('parseCommand', () => {
	it('finds each prefix of a pipeline or list, outside quotes', () => {
		expect(parseCommand('grep -iao "a | b" src/x.ts | cut -d: -f1 | head -n 10')).toEqual({ kind: 'ok', programs: ['grep', 'cut', 'head'], prefixes: ['grep', 'cut', 'head'], redirects: [], outside: [] });
		expect(parseCommand('cd src && ls -la; CI=1 npm test || echo failed')).toEqual({ kind: 'ok', programs: ['cd', 'ls', 'npm', 'echo'], prefixes: ['cd', 'ls', 'npm test', 'echo'], redirects: [], outside: [] });
		expect(parseCommand('rg \'x;y\' --json\nwc -l file')).toEqual({ kind: 'ok', programs: ['rg', 'wc'], prefixes: ['rg', 'wc'], redirects: [], outside: [] });
	});

	it('keys programs with subcommands by the subcommand, and scripts by name', () => {
		expect(parseCommand('git status -s && git -C src log -n 3 && npm run lint -- --fix && make test && kubectl -n ns get pods && go mod tidy && yarn workspace web build')).toMatchObject({
			prefixes: ['git status', 'git -C src log', 'npm run lint', 'make test', 'kubectl -n ns get', 'go mod tidy', 'yarn workspace web build'],
		});
	});

	it('notes the files a redirection writes, but not /dev/null or another stream', () => {
		expect(parseCommand('npm test 2>&1 | tail -n 20')).toMatchObject({ redirects: [], prefixes: ['npm test', 'tail'] });
		expect(parseCommand('ls > /dev/null')).toMatchObject({ redirects: [], prefixes: ['ls'] });
		expect(parseCommand('echo hi >> notes.txt')).toMatchObject({ redirects: ['notes.txt'], outside: [] });
		expect(parseCommand('sort <input.txt >out.txt')).toMatchObject({ redirects: ['out.txt'], outside: [] });
	});

	it('tells redirects inside the agent\'s folders from ones outside', () => {
		const roots = ['/work/app'];
		expect(parseCommand('echo x > /work/app/notes.txt && echo y > /tmp/scratch.txt', { roots })).toMatchObject({ redirects: ['/work/app/notes.txt', '/tmp/scratch.txt'], outside: [] });
		expect(parseCommand('echo x > /Users/me/.zshrc', { roots })).toMatchObject({ outside: ['/Users/me/.zshrc'] });
		expect(parseCommand('echo x > ../other/notes.txt', { roots })).toMatchObject({ outside: ['../other/notes.txt'] });
		expect(parseCommand('cd /etc && echo x > hosts', { roots })).toMatchObject({ outside: ['hosts'] });
		expect(parseCommand('echo x > /work/app/notes.txt')).toMatchObject({ outside: ['/work/app/notes.txt'] });
		expect(parseCommand('echo x > $HOME/notes.txt', { roots })).toEqual({ kind: 'asks', reason: 'dynamic' });
	});

	it('asks for anything that reaches the network', () => {
		for (const command of ['curl https://example.com', 'wget -q x', 'git clone git@github.com:a/b.git', 'ls && ssh host', 'grep x http://a', '/usr/bin/nc -l 80',
			'npm install left-pad', 'npm i -D vitest', 'pnpm add zod', 'yarn add react', 'pip install requests', 'uv pip install x', 'cargo install ripgrep', 'go install golang.org/x/tools/gopls@latest',
			'go run example.com/x@v1', 'gh pr merge 3', 'gcloud auth print-access-token', 'aws s3 ls']) {
			expect(parseCommand(command), command).toEqual({ kind: 'asks', reason: 'network' });
		}
	});

	it('still covers installing what the project lists', () => {
		expect(parseCommand('npm install && npm ci && pip install -r requirements.txt && pip install -e .')).toMatchObject({ kind: 'ok', prefixes: ['npm install', 'npm ci', 'pip install', 'pip install'] });
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
		'$EDITOR notes.md', '/bin/*sh -c id', 'rg --pre ./x.sh TODO', 'rg --pre=cat x', 'tar --to-command=sh -xf a.tar', 'tar -I ./x -cf a.tar src',
		'sort --compress-program=./x big.txt', 'git config core.fsmonitor ./x.sh', 'git config --global alias.st "!sh -c id"', 'git config --unset core.pager',
		'git -C src rebase -x "make test" main', 'git submodule foreach make', 'git bisect run make test', 'git difftool -x ./x.sh',
	])('asks for %s', command => {
		expect(parseCommand(command)).toEqual({ kind: 'asks', reason: 'dynamic' });
	});

	// The payloads from the security review: each ran code after "Allow git" (or npm, awk, make) before.
	it.each([
		'git grep -O\'sh -c "touch pwned"\' -e x', 'git grep -nO./x.sh TODO', 'git grep --open-files-in-pager=./x.sh TODO',
		'git fetch --upload-pack=\'sh -c "touch pwned"\' .', 'git pull --upload-pack ./x.sh', 'git ls-remote -u ./x.sh .', 'git ls-remote --upload-pack=./x.sh .',
		'git push --receive-pack=./x.sh .', 'git push --exec=./x.sh .', 'git clone -u ./x.sh . copy', 'git clone --template=./t . copy', 'git clone --config core.hooksPath=h . c',
		'git archive --exec=./x.sh --remote=. HEAD', 'git --git-dir=evil status', 'git diff --output=notes.txt', 'git diff --no-index /etc/passwd x', 'git log --ext-diff', 'git credential fill', 'git init --template=./t',
		'npm exec -- touch pwned', 'npm x cowsay', 'npm --prefix /tmp exec x', 'pnpm exec vitest', 'pnpm dlx create-x', 'yarn dlx x', 'yarn exec x', 'npm init vite', 'npm create vite',
		'npm test --script-shell=./x.sh', 'npm config set script-shell ./x.sh', 'bundle exec rake', 'poetry run x', 'uv run x', 'kubectl exec pod -- sh',
		'make -f evil.mk', 'make -E \'$(shell touch pwned)\'', 'make --eval=x', 'make test SHELL=./x.sh', 'make CC=./x build', 'make -nf evil.mk',
		'awk -f prog.awk data', 'gawk -i inplace 1 x', 'awk --file=prog.awk data', 'sed -f script.sed data', 'sed --file=script.sed data', 'sed \'1e id\' data', 'sed s/a/b/w out data',
		'go test -exec ./x.sh ./...', 'go build -toolexec=./x', 'go env -w GOFLAGS=-toolexec=./x',
		'/Users/me/work/app/scripts/x.sh', '/tmp/x.sh', '/private/var/folders/x/run', 'docker ps', 'docker inspect c1', '/usr/local/bin/docker inspect c1', 'podman ps',
	])('asks for %s, which runs code it is given', command => {
		expect(parseCommand(command)).toEqual({ kind: 'asks', reason: 'dynamic' });
	});

	it.each([
		'echo \'{"scripts":{"test":"x"}}\' > package.json', 'cat x >> Makefile', 'echo x > "pyproject.toml"', 'echo id > .git/hooks/pre-commit',
		'cp /tmp/x package.json', 'tee -a .git/config < x', 'dd if=x of=Makefile', 'sed -i "" s/a/b/ package.json', 'mv x.mk build.mk',
		'echo "npx x" > .husky/pre-commit', 'cp x .pre-commit-config.yaml', 'echo x > .githooks/pre-push', 'echo x > .lintstagedrc.json', 'echo x > sub/.git',
		'echo x > .gemini/worktree-setup.sh', 'cp x .gemini/settings.json', 'echo {} > .vscode/tasks.json', 'tee .vscode/settings.json < x', 'echo x > vitest.config.ts',
	])('asks when %s writes what a later command runs', command => {
		expect(parseCommand(command)).toEqual({ kind: 'asks', reason: 'dynamic' });
	});

	it('still covers plain programs, formatting variables and installed programs by absolute path', () => {
		expect(parseCommand('LC_ALL=C sort a.txt | NO_COLOR=1 uniq -c')).toMatchObject({ kind: 'ok', programs: ['sort', 'uniq'] });
		expect(parseCommand('/opt/homebrew/bin/rg x && git grep -n TODO && sed -n 1,5p a && sed s/old/new/ a && awk -F: \'{ print $1 }\' a && make -j4 lint V=1')).toMatchObject({ kind: 'ok' });
		expect(parseCommand('find src -name "*.ts" | awk \'{ print $1 }\'')).toMatchObject({ kind: 'ok', programs: ['find', 'awk'] });
		expect(parseCommand('/usr/bin/git status && git log -n 3')).toMatchObject({ kind: 'ok', programs: ['/usr/bin/git', 'git'] });
		expect(parseCommand('git config user.email && git config --get remote.origin.url && git -C src log --oneline')).toMatchObject({ kind: 'ok', programs: ['git', 'git', 'git'] });
		expect(parseCommand('rg --pre-glob "*.gz" TODO && tar -tf a.tar && sed -n 1,5p package.json && cp a.txt b.txt')).toMatchObject({ kind: 'ok', programs: ['rg', 'tar', 'sed', 'cp'] });
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

	it('keeps asking when a command adds a redirection, the network or a new prefix', () => {
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

	it('covers the subcommand allowed, never another one of the same program', () => {
		const approvals = new SessionApprovals();
		approvals.approve('git status');
		approvals.approve('npm run lint');
		expect({
			status: approvals.covers('git status --short').kind,
			grep: approvals.covers('git grep -n TODO').kind,
			push: approvals.covers('git push').kind,
			lint: approvals.covers('npm run lint -- --fix').kind,
			deploy: approvals.covers('npm run deploy').kind,
			exec: approvals.covers('npm exec x').kind,
		}).toEqual({ status: 'covered', grep: 'asks', push: 'asks', lint: 'covered', deploy: 'asks', exec: 'asks' });
	});

	it('remembers each file a redirection writes, and never one outside the folder', () => {
		const approvals = new SessionApprovals(() => ({ roots: ['/work/app'] }));
		approvals.approve('npm test > /work/app/test.log');
		approvals.approve('echo x >> /Users/me/.zshrc');
		expect({
			same: approvals.covers('npm test > /work/app/test.log').kind,
			other: approvals.covers('npm test > /work/app/package-notes.txt').kind,
			outside: approvals.covers('echo x >> /Users/me/.zshrc').kind,
			echo: approvals.covers('echo x').kind,
		}).toEqual({ same: 'covered', other: 'asks', outside: 'asks', echo: 'covered' });
	});

	it('lets one approval cover the built-in read-only and test prefixes, whose programs otherwise always ask', () => {
		const approvals = new SessionApprovals();
		expect(['npx vitest run', 'npx tsc --noEmit -p .', 'npx eslint src', 'python -m pytest -q', './gradlew test --offline'].map(command => approvals.approve(command))).toEqual([
			['npx vitest'], ['npx tsc --noEmit'], ['npx eslint'], ['python -m pytest'], ['./gradlew test'],
		]);
		expect({
			again: approvals.covers('npx vitest run src/cart.test.ts').kind,
			otherTool: approvals.approve('npx cowsay hi'),
			tscEmits: approvals.approve('npx tsc -p .'),
			gradleBuild: approvals.approve('./gradlew build'),
			pythonCode: approvals.approve('python -c "import os"'),
			builtin: ['git status', 'npx vitest', 'npm run deploy'].map(SessionApprovals.isBuiltin),
		}).toEqual({ again: 'covered', otherTool: undefined, tscEmits: undefined, gradleBuild: undefined, pythonCode: undefined, builtin: [true, true, false] });
	});

	it('lets task runners ask again once the agent writes a file that defines what they run', () => {
		const approvals = new SessionApprovals();
		approvals.approve('npm test && make lint && npx vitest run');
		approvals.approve('git status && git commit -m x');
		expect({
			afterSource: approvals.noteWrite('/work/src/cart.ts'),
			afterScripts: approvals.noteWrite('/work/package.json'),
			npm: approvals.covers('npm test').kind,
			status: approvals.covers('git status').kind,
			commit: approvals.covers('git commit -m y').kind,
			approved: approvals.approved,
			buildFiles: ['/w/Makefile', '/w/build.gradle.kts', '/w/app/App.csproj', '/w/conftest.py', '/w/vitest.config.ts', '/w/gradlew', '/w/node_modules/.bin/vitest', '/w/README.md', '/w/package-lock.json'].map(isBuildFile),
		}).toEqual({
			afterSource: [],
			afterScripts: ['npm test', 'make lint', 'npx vitest', 'git commit'],
			npm: 'asks',
			status: 'covered',
			commit: 'asks',
			approved: ['git status'],
			buildFiles: [true, true, true, true, true, true, true, false, false],
		});
	});

	it('lets git ask again once the agent writes a hook or a hook manager\'s settings', () => {
		const hooks = ['/w/.husky/pre-commit', '/w/.pre-commit-config.yaml', '/w/.lintstagedrc.json', '/w/lint-staged.config.mjs', '/w/scripts/git-hooks/pre-push', '/w/lefthook.yml', '/w/sub/.git', '/w/bare/config'];
		expect(hooks.map(file => {
			const approvals = new SessionApprovals();
			approvals.approve('git status && git commit -m x && ls');
			return { lapsed: approvals.noteWrite(file), left: approvals.approved };
		})).toEqual(hooks.map(() => ({ lapsed: ['git status', 'git commit'], left: ['ls'] })));
		expect(['/w/src/hooks/useCart.ts', '/w/docs/config.md'].map(isGitHookFile)).toEqual([false, false]);
	});

	it('takes permanent rules from outside, which lapse for the session like its own', () => {
		const approvals = new SessionApprovals();
		approvals.setPermanent(['npm test', 'git status']);
		expect(approvals.covers('npm test -- --watch=false').kind).toBe('covered');
		expect(approvals.noteWrite('/w/package.json')).toEqual(['npm test']);
		expect({ npm: approvals.covers('npm test').kind, rules: approvals.rules }).toEqual({ npm: 'asks', rules: [{ prefix: 'git status', source: 'permanent' }] });
		approvals.approve('npm test');
		expect(approvals.rules).toEqual([{ prefix: 'npm test', source: 'session' }, { prefix: 'npm test', source: 'permanent' }, { prefix: 'git status', source: 'permanent' }]);
		expect(approvals.prefixesOf('git status && grep x a | head')).toEqual(['git status', 'grep', 'head']);
	});

	it('names the settings an agent\'s write always asks for, the ignore files among them', () => {
		expect(['/w/.gemini/worktree-setup.sh', '/w/.gemini/settings.json', '/w/.vscode/settings.json', '/w/.vscode/tasks.json', '/w/.gitignore', '/w/sub/.gitignore', '/w/.geminiignore', '/w/.git/info/exclude', '/w/.gemini/GEMINI.md', '/w/.vscode/launch.json', '/w/src/settings.json', '/w/gitignore.md'].map(isProtectedSetting))
			.toEqual([true, true, true, true, true, true, true, true, false, false, false, false]);
		expect(['/w/.gitignore', '/w/.geminiignore', '/w/.git/info/exclude', '/w/.gemini/settings.json'].map(isIgnoreFile)).toEqual([true, true, true, false]);
	});

	it('says which writes decide what runs next: hooks and build files as well as the settings', () => {
		expect(['/w/.husky/pre-commit', '/w/package.json', '/w/.gemini/settings.json', '/w/.gitignore', '/w/src/cart.ts', '/w/README.md'].map(decidesWhatRuns)).toEqual([true, true, true, true, false, false]);
	});
});

describe('isReadOnlyGitRead', () => {
	it('allows a reviewer git\'s reads of the repository, and nothing that writes, reads outside it or runs something else', () => {
		const commands = [
			'git diff origin/main...HEAD -- src/cart.ts', 'git log --oneline -20 origin/main..HEAD', 'git show HEAD:src/cart.ts', 'git status --short', 'git diff --stat && git log -3',
			'git diff --output=/tmp/x.patch', 'git diff --no-index /etc/passwd /dev/null', 'git diff --ext-diff', 'git log > notes.txt', 'git diff | head -50',
			'git -c core.pager=sh log', 'git push', 'git checkout main', 'git diff; rm -rf build', 'git show $(cat ref)', 'GIT_EXTERNAL_DIFF=x git diff',
		];
		expect(commands.filter(command => isReadOnlyGitRead(command))).toEqual(commands.slice(0, 5));
	});
});
