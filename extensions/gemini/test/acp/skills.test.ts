/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSkills, parseSkillFrontmatter, skillFolders, skillPrompt, skillSlug, skillTemplate } from '../../src/acp/skills';

let dir: string;
beforeEach(async () => { dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-'))); });
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

async function write(file: string, text: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, text);
}

describe('skills', () => {
	it('reads front matter as the CLI does', () => {
		expect(parseSkillFrontmatter('---\nname: release\ndescription: Cut a release.\n---\n# Body')).toEqual({ name: 'release', description: 'Cut a release.' });
		expect(parseSkillFrontmatter('---\nname: "a:b"\ndescription:\n  Use when\n  releasing.\n---\n')).toEqual({ name: 'a-b', description: 'Use when releasing.' });
		expect(parseSkillFrontmatter('---\nname: x\ndescription: >\n  Folded\n  text\n---')).toEqual({ name: 'x', description: 'Folded text' });
		expect(parseSkillFrontmatter('---\nname: x\n---\n')).toBeUndefined();
		expect(parseSkillFrontmatter('# No front matter')).toBeUndefined();
	});

	it('finds skills in the user and project folders, the project winning a clash', async () => {
		const home = path.join(dir, 'home');
		const project = path.join(dir, 'shop');
		await write(path.join(home, '.gemini', 'skills', 'release', 'SKILL.md'), skillTemplate('release', 'Personal release.'));
		await write(path.join(home, '.agents', 'skills', 'notes', 'SKILL.md'), skillTemplate('notes', 'Notes.'));
		await write(path.join(project, '.gemini', 'skills', 'release', 'SKILL.md'), skillTemplate('release', 'Project release.'));
		await write(path.join(project, '.gemini', 'skills', 'broken', 'SKILL.md'), 'no front matter');
		await write(path.join(project, '.gemini', 'skills', 'empty', 'README.md'), 'not a skill');
		const folders = skillFolders(project, home);
		expect(folders.map(f => f.personal)).toEqual([true, true, false, false]);
		const skills = await loadSkills(folders);
		expect(skills.map(s => [s.name, s.description, s.personal])).toEqual([['notes', 'Notes.', true], ['release', 'Project release.', false]]);
		expect(skills[1].file).toBe(path.join(project, '.gemini', 'skills', 'release', 'SKILL.md'));
		expect(skillFolders(home, home)).toHaveLength(2);
	});

	it('makes names, templates and the prompt that loads a skill', () => {
		expect(skillSlug('  DB Migrations! ')).toBe('db-migrations');
		expect(parseSkillFrontmatter(skillTemplate('db', 'Use when\nmigrating.'))).toEqual({ name: 'db', description: 'Use when migrating.' });
		expect(skillPrompt('db', '')).toBe('Use the activate_skill tool to load the "db" skill, then follow it.');
		expect(skillPrompt('db', ' add users ')).toBe('Use the activate_skill tool to load the "db" skill, then follow it.\n\nadd users');
	});
});
