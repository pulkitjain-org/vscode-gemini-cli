/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterSettings, settingControl, settingLabel, settingSections, type ContributedSection } from '../../src/acp/settingsModel';

const sections: ContributedSection[] = [
	{
		title: '%section.agents%', order: 2, properties: {
			'gemini.agents.ownBranch': { type: 'boolean', default: false, markdownDescription: 'Start new agents on a branch of their own.' },
			'gemini.agents.defaultMode': { type: 'string', enum: ['default', 'autoEdit', 'yolo'], enumDescriptions: ['Asks', 'Edits', 'Runs'], default: 'default', description: 'What agents may do.' },
			'gemini.projects.maxRunningThreads': { type: 'integer', default: 3, minimum: 1, maximum: 8, description: 'Threads at once.', tags: ['advanced'] },
			'gemini.agents.mergeBack': { type: 'boolean', default: true, deprecationMessage: 'Use Try in Workspace.' },
		},
	},
	{ title: '%section.account%', order: 1, properties: { 'gemini.cliPath': { type: 'string', default: '', scope: 'machine', description: 'Where the CLI is.' }, 'gemini.index.include': { type: 'array', default: [], description: 'Globs.' } } },
];

describe('settings model', () => {
	it('names and types each setting from its contribution', () => {
		expect(['gemini.agents.ownBranch', 'gemini.projects.maxRunningThreads', 'gemini.cli.version', 'gemini.chat.reactions.enabled'].map(settingLabel)).toEqual(['Own branch', 'Max running threads', 'Version', 'Reactions enabled']);
		expect([{ type: 'boolean' }, { type: 'string', enum: ['a'] }, { type: 'integer' }, { type: ['string', 'null'] }, { type: 'array' }, { type: 'object' }].map(settingControl)).toEqual(['toggle', 'picker', 'number', 'text', 'list', 'json']);
	});

	it('lists the sections in their order, with every setting and its control, choices, scope and flags', () => {
		const model = settingSections(sections);
		expect(model.map(section => section.title)).toEqual(['%section.account%', '%section.agents%']);
		expect(model[1].settings).toEqual([
			{ key: 'gemini.agents.ownBranch', label: 'Own branch', help: 'Start new agents on a branch of their own.', control: 'toggle', default: false, scope: 'window', advanced: false },
			{ key: 'gemini.agents.defaultMode', label: 'Default mode', help: 'What agents may do.', control: 'picker', default: 'default', choices: [{ value: 'default', label: 'default', help: 'Asks' }, { value: 'autoEdit', label: 'autoEdit', help: 'Edits' }, { value: 'yolo', label: 'yolo', help: 'Runs' }], scope: 'window', advanced: false },
			{ key: 'gemini.projects.maxRunningThreads', label: 'Max running threads', help: 'Threads at once.', control: 'number', default: 3, minimum: 1, maximum: 8, scope: 'window', advanced: true },
			{ key: 'gemini.agents.mergeBack', label: 'Merge back', help: '', control: 'toggle', default: true, scope: 'window', advanced: false, deprecated: 'Use Try in Workspace.' },
		]);
		expect(model[0].settings.map(setting => [setting.key, setting.control, setting.scope])).toEqual([['gemini.cliPath', 'text', 'machine'], ['gemini.index.include', 'list', 'window']]);
	});

	it('hides advanced and deprecated settings until searched for, and searches keys, labels, help and choices', () => {
		const model = settingSections(sections);
		expect(filterSettings(model, '').flatMap(section => section.settings.map(setting => setting.key))).toEqual(['gemini.cliPath', 'gemini.index.include', 'gemini.agents.ownBranch', 'gemini.agents.defaultMode']);
		expect(filterSettings(model, 'threads').flatMap(section => section.settings.map(setting => setting.key))).toEqual(['gemini.projects.maxRunningThreads']);
		expect(filterSettings(model, 'merge back').flatMap(section => section.settings.map(setting => setting.key))).toEqual(['gemini.agents.mergeBack']);
		expect(filterSettings(model, 'yolo').flatMap(section => section.settings.map(setting => setting.key))).toEqual(['gemini.agents.defaultMode']);
		expect(filterSettings(model, 'nothing like this')).toEqual([]);
	});

	it('models every setting GeminiCode contributes', () => {
		const { contributes } = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { configuration: ContributedSection[] } };
		const model = settingSections(contributes.configuration);
		const all = model.flatMap(section => section.settings);
		expect(all.length).toBe(contributes.configuration.reduce((n, section) => n + Object.keys(section.properties).length, 0));
		expect(all.filter(setting => !setting.help).map(setting => setting.key)).toEqual([]);
		expect(model.map(section => section.title)).toHaveLength(8);
	});
});
