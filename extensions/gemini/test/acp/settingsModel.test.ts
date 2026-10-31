/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterSettings, helpSegments, inspectedValue, isPolicyLocked, parseSettingValue, resolveNls, sectionId, sectionTitle, settingControl, settingLabel, settingSections, settingTarget, type ContributedSection, type SettingRow } from '../../src/acp/settingsModel';

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

	it('names a choice by its item label when the contribution gives one', () => {
		const [section] = settingSections([{ title: 'T', properties: { 'gemini.a': { type: 'string', enum: ['x', 'y'], enumItemLabels: ['Ex', 'Why'], default: 'x', description: 'Picks.' } } }]);
		expect(section.settings[0].choices).toEqual([{ value: 'x', label: 'Ex' }, { value: 'y', label: 'Why' }]);
	});

	it('resolves %key% strings, titles a section without its Gemini prefix, and gives it an anchor', () => {
		const strings = { 'configuration.accountTitle': 'Gemini: Account and CLI', 'configuration.a': 'Where the `gemini` command is.' };
		expect(resolveNls('%configuration.a%', strings)).toBe('Where the `gemini` command is.');
		expect(resolveNls('%configuration.missing%', strings)).toBe('%configuration.missing%');
		expect([sectionTitle('%configuration.accountTitle%', strings), sectionTitle('Gemini: Team Tools', {}), sectionTitle('Plain', {})]).toEqual(['Account and CLI', 'Team Tools', 'Plain']);
		expect([sectionId('%configuration.accountTitle%'), sectionId('%configuration.indexTitle%'), sectionId('Gemini: Team Tools'), sectionId('%%')]).toEqual(['account', 'index', 'gemini-team-tools', 'section']);
	});

	it('splits help into text and code: backticks, #gemini.key# references, links as their text, emphasis as words', () => {
		expect(helpSegments('Use `pnpm` here. See #gemini.cliPath# and [the guide](https://example.com), **always**.')).toEqual([
			{ text: 'Use ' }, { text: 'pnpm', code: true }, { text: ' here. See ' }, { text: 'gemini.cliPath', code: true }, { text: ' and the guide, always.' },
		]);
		expect(helpSegments('')).toEqual([]);
	});

	it('tells a policy\'s value from the settings files\', which inspect reports and get does not', () => {
		expect(inspectedValue({ defaultValue: true, globalValue: false })).toBe(false);
		expect(inspectedValue({ defaultValue: true, globalValue: false, workspaceValue: true })).toBe(true);
		expect(inspectedValue(undefined)).toBeUndefined();
		// get returns the files' value: no policy.
		expect(isPolicyLocked(false, { defaultValue: true, globalValue: false })).toBe(false);
		expect(isPolicyLocked(['a'], { defaultValue: [], globalValue: ['a'] })).toBe(false);
		// get returns something no file holds: a policy decides it.
		expect(isPolicyLocked(false, { defaultValue: true })).toBe(true);
		expect(isPolicyLocked([], { defaultValue: [], globalValue: ['github'] })).toBe(true);
	});

	it('writes to the user\'s settings, or the workspace\'s for a resource-scoped setting with a folder open, never a machine one', () => {
		expect([settingTarget('resource', true), settingTarget('resource', false), settingTarget('window', true), settingTarget('machine', true), settingTarget('application', true)]).toEqual(['workspace', 'global', 'global', 'global', 'global']);
	});

	it('takes a control\'s value only when it fits the contribution', () => {
		const row = (control: SettingRow['control'], more: Partial<SettingRow> = {}): SettingRow => ({ key: 'gemini.x', label: 'X', help: '', control, default: undefined, scope: 'window', advanced: false, ...more });
		expect([
			parseSettingValue(row('toggle'), true), parseSettingValue(row('toggle'), 'true'),
			parseSettingValue(row('number', { minimum: 1, maximum: 8, default: 3 }), '4'), parseSettingValue(row('number', { minimum: 1, maximum: 8, default: 3 }), 9), parseSettingValue(row('number', { default: 3 }), 2.6), parseSettingValue(row('number', { default: 0.5 }), 2.6), parseSettingValue(row('number'), 'abc'),
			parseSettingValue(row('picker', { choices: [{ value: 'a', label: 'a' }] }), 'a'), parseSettingValue(row('picker', { choices: [{ value: 'a', label: 'a' }] }), 'b'),
			parseSettingValue(row('text'), 'hi'), parseSettingValue(row('text'), 1),
			parseSettingValue(row('list'), [' a ', '', 'b']), parseSettingValue(row('list'), ['a', 1]), parseSettingValue(row('list'), 'a'),
			parseSettingValue(row('json'), { a: 1 }), parseSettingValue(row('json'), [1]), parseSettingValue(row('json'), null),
		]).toEqual([
			{ value: true }, undefined,
			{ value: 4 }, undefined, { value: 3 }, { value: 2.6 }, undefined,
			{ value: 'a' }, undefined,
			{ value: 'hi' }, undefined,
			{ value: ['a', 'b'] }, undefined, undefined,
			{ value: { a: 1 } }, undefined, undefined,
		]);
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
