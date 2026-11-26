/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	annotateTokens, cssVariableName, designSystemChanges, designSystemConfig, designSystemRoots, designSystemFiles, designSystemNoteFor, documentPages, keepRules,
	pageComponents, pageParts, parseVariableDefs, readSyncRecord, syncPages, tokenIndex,
} from '../../src/acp/designSystem';
import { figmaDesignSystem } from '../../src/acp/designTokens';
import { readTeamDefaults } from '../../src/acp/teamDefaults';

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function repo(defaults: unknown): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-ds-'));
	dirs.push(dir);
	await fs.mkdir(path.join(dir, '.gemini'), { recursive: true });
	await fs.writeFile(path.join(dir, '.gemini', 'geminicode-tools.json'), JSON.stringify(defaults));
	return dir;
}

// As Figma's Dev Mode server writes them: a document of pages, and a page with a component set (a frame of variant symbols) and a lone component.
const documentOutline = '<document id="0:0" name="Acme DS" x="0" y="0" width="0" height="0">\n  <canvas id="0:1" name="Foundations" x="0" y="0" width="0" height="0" />\n  <canvas id="0:2" name="Components" x="0" y="0" width="0" height="0" />\n  <canvas id="0:3" name="Archive" x="0" y="0" width="0" height="0" hidden="true" />\n</document>';
const componentsOutline = [
	'<canvas id="0:2" name="Components" x="0" y="0" width="0" height="0">',
	'  <frame id="1:1" name="Button" x="0" y="0" width="400" height="200">',
	'    <symbol id="1:2" name="Size=Small, State=Default" x="0" y="0" width="80" height="32">',
	'      <text id="1:3" name="Label" x="8" y="8" width="60" height="16" />',
	'    </symbol>',
	'    <symbol id="1:4" name="Size=Large, State=Hover" x="0" y="40" width="120" height="48" />',
	'  </frame>',
	'  <symbol id="2:1" name="Avatar &amp; Badge" x="0" y="300" width="40" height="40">',
	'    <symbol id="2:2" name="Inner" x="0" y="0" width="40" height="40" />',
	'  </symbol>',
	'  <instance id="3:1" name="Button" x="0" y="400" width="80" height="32" />',
	'</canvas>',
].join('\n');

describe('design system', () => {
	it('reads the variables, pages and components Figma gives', () => {
		expect({
			variables: parseVariableDefs('{"color/brand/primary":"#2F5BD3","type/body":"Font(family: \\"Inter\\", size: 16)","space/200":8}\nIMPORTANT: use these variables.'),
			none: parseVariableDefs('No variables here.'),
			pages: documentPages(documentOutline),
			components: pageComponents(componentsOutline, 'Components'),
		}).toEqual({
			variables: { 'color/brand/primary': '#2F5BD3', 'type/body': 'Font(family: "Inter", size: 16)', 'space/200': '8' },
			none: undefined,
			pages: { fileName: 'Acme DS', pages: [{ id: '0:1', name: 'Foundations', hidden: false }, { id: '0:2', name: 'Components', hidden: false }, { id: '0:3', name: 'Archive', hidden: true }] },
			components: [
				{ name: 'Button', page: 'Components', properties: [{ name: 'Size', values: ['Small', 'Large'] }, { name: 'State', values: ['Default', 'Hover'] }] },
				{ name: 'Avatar & Badge', page: 'Components', properties: [] },
			],
		});
	});

	it('picks the pages the team file names, whatever their spacing in Figma, and says which it could not find', () => {
		// As a client's file names them: a tree prefix with two spaces, and one page that ends in a space.
		const pages = [
			{ id: '2:144', name: '\u2514\u2500  colors', hidden: false },
			{ id: '2:148', name: '\u2514\u2500  ratios ', hidden: false },
			{ id: '2:149', name: '\u2514\u2500  icons', hidden: false },
			{ id: '0:3', name: 'Archive', hidden: true },
		];
		const ids = (result: { readonly wanted: readonly { readonly id: string }[]; readonly missing: readonly string[] }) =>({ wanted: result.wanted.map(page => page.id), missing: result.missing });
		expect({
			named: ids(syncPages(pages, ['\u2514\u2500  colors', '\u2514\u2500  ratios'])),
			spacing: ids(syncPages(pages, ['\u2514\u2500 Colors', '\u2514\u2500  RATIOS', '\u2514\u2500  grid'])),
			unnamed: ids(syncPages(pages, undefined)),
		}).toEqual({
			named: { wanted: ['2:144', '2:148'], missing: [] },
			spacing: { wanted: ['2:144', '2:148'], missing: ['\u2514\u2500  grid'] },
			unnamed: { wanted: ['2:144', '2:148', '2:149'], missing: [] },
		});
	});

	it('reads a page\'s variables frame by frame, and knows a page Figma has not loaded', () => {
		// As the desktop app gives a page it has not loaded since the file opened, and a loaded one.
		const unloaded = '<canvas id="2:144" name="colors" x="0" y="0" width="0" height="0" />';
		const loaded = [
			'<canvas id="2:146" name="space" x="0" y="0" width="0" height="0">',
			'  <frame id="43:2882" name="spacing" x="0" y="0" width="960" height="1878">',
			'    <instance id="43:2895" name="header" x="0" y="0" width="960" height="160" />',
			'  </frame>',
			'  <frame id="5685:2982" name="notes" x="0" y="0" width="856" height="4055" hidden="true">',
			'    <text id="5712:2729" name="Enter" x="0" y="0" width="45" height="20" />',
			'  </frame>',
			'  <section id="7:1" name="Spacing scale" x="0" y="0" width="800" height="400" />',
			'  <instance id="7:2" name="cover" x="0" y="0" width="620" height="344" />',
			'  <symbol id="43:3262" name="space_5" x="0" y="0" width="5" height="5" />',
			'  <text id="7:3" name="Note" x="0" y="0" width="100" height="20" />',
			'</canvas>',
		].join('\n');
		expect({ unloaded: pageParts(unloaded), loaded: pageParts(loaded), components: pageComponents(loaded, 'space').map(c => c.name) }).toEqual({
			unloaded: { empty: true, frames: [] },
			loaded: { empty: false, frames: ['43:2882', '7:1', '7:2'] },
			components: ['space_5'],
		});
	});

	it('offers each repository in the window that names a design system, the one in front first', () => {
		const ds = { figma: { designSystem: { name: 'VCA', file: 'https://www.figma.com/design/AbC/VCA' } } };
		const at = (repo: string, defaults: object) => ({ ...defaults, file: path.join(repo, '.gemini', 'geminicode-tools.json') });
		const cms = path.join(os.tmpdir(), 'cms'), fea = path.join(os.tmpdir(), 'fea'), other = path.join(os.tmpdir(), 'other');
		// Two folders of the same repository, one repository without a design system, and a folder with no defaults.
		const folders = [at(cms, ds), at(cms, ds), at(fea, ds), at(other, { jira: { site: 'https://acme.atlassian.net' } }), {}];
		expect({
			window: designSystemRoots(folders, undefined),
			inFront: designSystemRoots(folders, fea),
			elsewhere: designSystemRoots(folders, other),
			one: designSystemRoots([at(fea, ds), {}], undefined),
		}).toEqual({ window: [cms, fea], inFront: [fea, cms], elsewhere: [cms, fea], one: [fea] });
	});

	it('writes the skill, its references and the tokens file, and says what changed since the last sync', () => {
		const config = { name: 'Acme DS', file: 'https://www.figma.com/design/AbC/Acme', skill: path.join('.gemini', 'skills', 'design-system'), tokens: path.join('src', 'tokens.css') };
		const read = {
			fileName: 'Acme DS',
			tokens: [{ name: 'color/brand/primary', value: '#2F5BD3' }, { name: 'space/200', value: '8' }, { name: 'type/body', value: 'Font(size: 16)' }],
			components: [{ name: 'Button', page: 'Components', properties: [{ name: 'Size', values: ['Small', 'Large'] }] }],
		};
		const files = designSystemFiles(read, config, '2026-10-28');
		const record = readSyncRecord(files[path.join(config.skill, 'references', 'tokens.md')]);
		const next = { ...read, tokens: [{ name: 'color/brand/primary', value: '#1F4BC3' }, { name: 'radius/control', value: '6' }], components: [] };
		expect({
			files: Object.keys(files),
			css: files[config.tokens],
			skillName: /^name: (.*)$/m.exec(files[path.join(config.skill, 'SKILL.md')])?.[1],
			component: files[path.join(config.skill, 'references', 'components.md')].split('\n').at(-2),
			record,
			changes: designSystemChanges(record, next),
			cssName: cssVariableName('Color / Brand Primary'),
		}).toEqual({
			files: [path.join(config.skill, 'SKILL.md'), path.join(config.skill, 'references', 'tokens.md'), path.join(config.skill, 'references', 'components.md'), config.tokens],
			css: '/* Acme DS tokens, synced from Figma on 2026-10-28 by GeminiCode\'s Sync Design System. Sync again rather than editing. */\n:root {\n\t--color-brand-primary: #2F5BD3;\n\t--space-200: 8px;\n}\n',
			skillName: 'design-system',
			component: '| Button | Size: Small, Large | Components |',
			record: { tokens: { 'color/brand/primary': '#2F5BD3', 'space/200': '8', 'type/body': 'Font(size: 16)' }, components: ['Button'] },
			changes: { addedTokens: ['radius/control'], changedTokens: ['color/brand/primary'], removedTokens: ['space/200', 'type/body'], addedComponents: [], removedComponents: ['Button'] },
			cssName: '--color-brand-primary',
		});
	});

	it('keeps the rules a team wrote in its skill', () => {
		const generated = '---\nname: design-system\n---\n\n# Acme\n\n## Rules\n\n- Generated rule.\n\n## References\n\n- tokens\n';
		const existing = '---\nname: design-system\n---\n\n# Acme\n\n## Rules\n\n- Our own rule.\n- Another.\n\n## References\n\n- old\n';
		expect([keepRules(generated, existing), keepRules(generated, undefined)]).toEqual([
			'---\nname: design-system\n---\n\n# Acme\n\n## Rules\n\n- Our own rule.\n- Another.\n\n## References\n\n- tokens\n',
			generated,
		]);
	});

	it('names the colours that are tokens in Figma\'s answers, once', () => {
		const index = tokenIndex(designSystemFiles({ fileName: 'DS', tokens: [{ name: 'color/brand/primary', value: '#2F5BD3' }, { name: 'space/200', value: '8' }], components: [] }, { skill: 'ds' }, '2026-10-28')[path.join('ds', 'references', 'tokens.md')]);
		expect([...index]).toEqual([['#2f5bd3', 'color/brand/primary']]);
		expect(annotateTokens('bg-[#2f5bd3] text-[#111111] border #2F5BD3 (color/brand/primary)', index)).toBe('bg-[#2f5bd3 (color/brand/primary)] text-[#111111] border #2F5BD3 (color/brand/primary)');
	});

	it('reads the team\'s design system, never outside the repository, and notes the skill only once it exists', async () => {
		const dir = await repo({ figma: { viewports: ['S'], designSystem: { name: 'Acme DS', pages: ['Foundations', ''], skill: '../outside', tokens: 'src/tokens.css', codeConnect: true } } });
		const defaults = await readTeamDefaults(dir);
		const config = designSystemConfig(defaults)!;
		const before = await designSystemNoteFor(defaults);
		await fs.mkdir(path.join(dir, config.skill, 'references'), { recursive: true });
		await fs.writeFile(path.join(dir, config.skill, 'SKILL.md'), '---\nname: acme-ds\ndescription: Acme.\n---\n');
		await fs.writeFile(path.join(dir, config.skill, 'references', 'tokens.md'), designSystemFiles({ fileName: 'DS', tokens: [{ name: 'c', value: '#abcdef' }], components: [] }, config, '2026-10-28')[path.join(config.skill, 'references', 'tokens.md')]);
		expect({
			figma: defaults.figma,
			config: { ...config, root: path.relative(dir, config.root) },
			before,
			after: await designSystemNoteFor(defaults),
			figmaRead: await figmaDesignSystem(defaults).then(found => found && { ...found, tokens: [...found.tokens] }),
			none: designSystemConfig(await readTeamDefaults(await repo({ figma: { viewports: ['S'] } }))),
		}).toEqual({
			figma: { viewports: ['S'], designSystem: { name: 'Acme DS', pages: ['Foundations', ''], skill: '../outside', tokens: 'src/tokens.css', codeConnect: true } },
			config: { name: 'Acme DS', pages: ['Foundations'], tokens: path.join('src', 'tokens.css'), codeConnect: true, skill: path.join('.gemini', 'skills', 'design-system'), root: '' },
			before: undefined,
			after: 'This project has a design-system skill, "acme-ds" (Acme DS). Load it before building this design, and build with its tokens and components: never hard-code a colour, size or font the design system defines, and use the team\'s component before writing new markup.',
			figmaRead: { codeConnect: true, tokens: [['#abcdef', 'c']] },
			none: undefined,
		});
	});
});
