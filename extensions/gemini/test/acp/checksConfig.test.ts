/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checksConfig, defaultProtected, protectedAmong } from '../../src/acp/checksConfig';
import { readTeamDefaults } from '../../src/acp/teamDefaults';

describe('a repository\'s checks', () => {
	it('are the commands it names, with the default protected files and Ask after a turn', () => {
		expect(checksConfig({ commands: [' npm test ', 'npm run lint'] })).toEqual({ commands: ['npm test', 'npm run lint'], protected: defaultProtected(), afterTurn: 'ask' });
	});

	it('take the repository\'s own protected files and when to run', () => {
		expect(checksConfig({ commands: ['make check'], protected: ['spec/**'], afterTurn: 'always' })).toEqual({ commands: ['make check'], protected: ['spec/**'], afterTurn: 'always' });
	});

	it('leave out what is malformed, and are nothing without a command', () => {
		expect([
			checksConfig({ commands: ['npm test', 7, '', 'a\nb', 'x'.repeat(401)], afterTurn: 'sometimes' }),
			checksConfig({ commands: [] }),
			checksConfig({ protected: ['**'] }),
			checksConfig(['npm test']),
			checksConfig(undefined),
		]).toEqual([{ commands: ['npm test'], protected: defaultProtected(), afterTurn: 'ask' }, undefined, undefined, undefined, undefined]);
	});

	it('keep at most eight commands', () => {
		expect(checksConfig({ commands: Array.from({ length: 12 }, (_, i) => `step ${i}`) })?.commands).toHaveLength(8);
	});

	it('come with the team defaults, which older files without the section still read', async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'checks-config-'));
		try {
			await fs.mkdir(path.join(repo, '.gemini'));
			const file = path.join(repo, '.gemini', 'geminicode-tools.json');
			await fs.writeFile(file, JSON.stringify({ gitlab: { defaultTarget: 'develop' } }));
			const before = await readTeamDefaults(repo);
			await fs.writeFile(file, JSON.stringify({ gitlab: { defaultTarget: 'develop' }, checks: { commands: ['npm test'], afterTurn: 'never' } }));
			const after = await readTeamDefaults(repo);
			expect([before.checks, before.gitlab?.defaultTarget, after.checks?.commands, after.checks?.afterTurn, after.gitlab?.defaultTarget]).toEqual([undefined, 'develop', ['npm test'], 'never', 'develop']);
		} finally {
			await fs.rm(repo, { recursive: true, force: true });
		}
	});
});

describe('protected files', () => {
	it('are tests, lockfiles and test configuration by default, at any depth', () => {
		const files = [
			'src/cart.ts', 'src/cart.test.ts', 'test/cart.ts', 'packages/shop/tests/unit/a.py', 'package.json', 'packages/shop/package.json',
			'pnpm-lock.yaml', 'vitest.config.mts', 'web/jest.config.js', 'README.md', 'src/testing.ts', 'src/latest/index.ts', 'conftest.py', 'api/test_orders.py',
		];
		expect(protectedAmong(files, defaultProtected())).toEqual([
			'src/cart.test.ts', 'test/cart.ts', 'packages/shop/tests/unit/a.py', 'package.json', 'packages/shop/package.json',
			'pnpm-lock.yaml', 'vitest.config.mts', 'web/jest.config.js', 'conftest.py', 'api/test_orders.py',
		]);
	});

	it('follow a repository\'s own globs: one folder per star, any number per two', () => {
		expect(protectedAmong(['spec/a.rb', 'spec/unit/b.rb', 'lib/spec/c.rb', 'Makefile', 'ci/check.sh', 'a+b.txt'], ['spec/*.rb', './ci/**', 'Makefile', 'a+b.txt'])).toEqual(['spec/a.rb', 'Makefile', 'ci/check.sh', 'a+b.txt']);
	});
});
