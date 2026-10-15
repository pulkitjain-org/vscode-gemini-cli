/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMemoryFiles, configFile, estimateTokens, memoryFileNames, memoryFolder, newMemoryFile, projectMemory, readProjectConfig, removeMemoryFile, repoKey, savedRepoCount, suggestedName, writeProjectConfig } from '../../src/acp/projectStore';

let root: string;
let home: string;

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-store-')));
	home = path.join(root, 'projects', 'p1');
});

afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('project names', () => {
	it('keys a repository by its folder, with its parent when the name is taken', () => {
		expect(repoKey('/code/acme-content', [])).toBe('acme-content');
		expect(repoKey('/work/web', ['web'])).toBe('work-web');
		expect(repoKey('/work/web', ['web', 'work-web'])).toBe('work-web-2');
	});

	it('suggests a name from the repositories\' shared start', () => {
		expect(suggestedName([{ key: 'acme-content', folder: '/a' }, { key: 'acme-checkout', folder: '/b' }])).toBe('acme');
		expect(suggestedName([{ key: 'shop', folder: '/a' }, { key: 'cms', folder: '/b' }])).toBe('shop');
		expect(suggestedName([{ key: 'shop', folder: '/a' }])).toBe('shop');
	});
});

describe('project config', () => {
	it('is just the project\'s repository until saved', async () => {
		const config = await readProjectConfig(home, '/code/shop');
		expect(config).toEqual({ repos: [{ key: 'shop', folder: '/code/shop' }], instructions: '', files: [], defaults: {} });
		expect(await savedRepoCount(home)).toBe(0);
	});

	it('saves and reads back repositories, memory, defaults and the draft time', async () => {
		await writeProjectConfig(home, {
			repos: [{ key: 'shop', folder: '/code/shop' }, { key: 'cms', folder: '/code/cms' }],
			instructions: 'shop reads cms content.',
			files: [],
			defaults: { planFirst: true, branchPrefix: 'feature/' },
			draftedAt: 5,
		});
		expect(await fs.readFile(path.join(home, 'instructions.md'), 'utf8')).toBe('shop reads cms content.');
		expect(JSON.parse(await fs.readFile(path.join(home, configFile), 'utf8')).instructions).toBeUndefined();
		const config = await readProjectConfig(home, '/code/shop');
		expect(config.repos.map(repo => repo.key)).toEqual(['shop', 'cms']);
		expect(config.instructions).toBe('shop reads cms content.');
		expect(config.defaults).toEqual({ planFirst: true, branchPrefix: 'feature/' });
		expect(config.draftedAt).toBe(5);
		expect(await savedRepoCount(home)).toBe(2);
	});

	it('puts the project\'s repository first when the saved list lacks it', async () => {
		await writeProjectConfig(home, { repos: [{ key: 'cms', folder: '/code/cms' }], instructions: '', files: [], defaults: {} });
		expect((await readProjectConfig(home, '/code/shop')).repos).toEqual([{ key: 'shop', folder: '/code/shop' }, { key: 'cms', folder: '/code/cms' }]);
	});

	it('lists the memory folder\'s files, keeping who reads each', async () => {
		const source = path.join(root, 'API contract.md');
		await fs.writeFile(source, '# API\n\nGET /labels');
		expect(await addMemoryFiles(home, [source, source])).toEqual(['API-contract.md', 'API-contract-2.md']);
		const file = await newMemoryFile(home, 'Release process');
		expect(path.basename(file)).toBe('release-process.md');
		expect(await fs.readFile(file, 'utf8')).toBe('# Release process\n\n');
		await writeProjectConfig(home, { repos: [], instructions: '', files: [{ name: 'API-contract.md', coordinator: false, threads: true }], defaults: {} });
		const config = await readProjectConfig(home, '/code/shop');
		expect(config.files).toEqual([
			{ name: 'API-contract-2.md', coordinator: true, threads: true },
			{ name: 'API-contract.md', coordinator: false, threads: true },
			{ name: 'release-process.md', coordinator: true, threads: true },
		]);
		await removeMemoryFile(home, 'API-contract-2.md');
		await removeMemoryFile(home, '../project.json');
		expect(await memoryFileNames(home)).toEqual(['API-contract.md', 'release-process.md']);
		expect(await fs.access(path.join(home, configFile)).then(() => true)).toBe(true);
	});

	it('joins the memory a role reads: the text, then its files', async () => {
		await fs.mkdir(path.join(home, memoryFolder), { recursive: true });
		await fs.writeFile(path.join(home, memoryFolder, 'api.md'), 'GET /labels');
		await fs.writeFile(path.join(home, memoryFolder, 'release.md'), 'cms ships first');
		const config = {
			repos: [], instructions: 'shop reads cms.', defaults: {},
			files: [{ name: 'api.md', coordinator: false, threads: true }, { name: 'release.md', coordinator: true, threads: true }],
		};
		expect(await projectMemory(home, config, 'threads')).toBe('shop reads cms.\n\n## api.md\n\nGET /labels\n\n## release.md\n\ncms ships first');
		expect(await projectMemory(home, config, 'coordinator')).toBe('shop reads cms.\n\n## release.md\n\ncms ships first');
		expect(await projectMemory(home, { ...config, instructions: ' ', files: [] }, 'threads')).toBeUndefined();
		expect(estimateTokens('12345678')).toBe(2);
	});
});
