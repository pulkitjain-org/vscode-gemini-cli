/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The settings guide (gemini/docs/guide/settings.md), written from
// package.json's configuration sections and package.nls.json's words, so the
// guide's sections, defaults and descriptions are the editor's.
// scripts/settings-doc.mts writes it; settingsDoc.test.ts fails when the file
// drifts from what this renders.

interface Property {
	readonly type?: string | readonly string[];
	readonly default?: unknown;
	readonly enum?: readonly string[];
	readonly enumItemLabels?: readonly string[];
	readonly markdownDescription?: string;
	readonly deprecationMessage?: string;
}

interface Section {
	readonly title: string;
	readonly order?: number;
	readonly properties: Readonly<Record<string, Property>>;
}

export interface SettingsDocInput {
	readonly configuration: readonly Section[];
	readonly strings: Readonly<Record<string, string>>;
}

/** What the guide says beyond a setting's description in the editor, by setting. */
const more: Readonly<Record<string, string>> = {
	'gemini.agents.ownBranch': 'See [Agents on their own branch](agents.md#agents-on-their-own-branch).',
	'gemini.agents.worktreeSetup': 'Before a repository\'s script runs the first time, GeminiCode shows it and asks; the command can use `GEMINI_SOURCE_REPOSITORY`, the repository the copy came from, to copy files Git doesn\'t carry.',
	'gemini.agents.branchDefaults': 'Set those under **Defaults for new threads** in the project\'s settings.',
	'gemini.inlineEdit.model': 'Side questions and Enhance Prompt use it too; with a sign-in that can\'t make quick requests, a session on the Gemini CLI answers instead.',
	'gemini.browser.keepSignIns': 'In remote and untrusted windows, or when `workbench.browser.dataStorage` keeps your own pages\' data per workspace, agents\' pages stay in memory whatever this says.',
	'gemini.index.enabled': 'The tools are `code_search`, `find_symbol`, `related_files`, `repo_map` and `docs_search`; see [Workspace index and docs](agents.md#workspace-index-and-docs).',
	'gemini.index.include': '**Index Anyway** on the Index & Docs tab adds a file here for you.',
	'gemini.team.runTeamServers': 'Jira\'s and GitLab\'s servers start when an agent\'s session opens, the others on their first call.',
	'gemini.audit.keepDays': 'The Storage section of Settings\' Storage & Audit tab sets it too.',
	'gemini.chat.runCommands': 'See [Run a command from a reply](terminal.md#run-a-command-from-a-reply).',
	'gemini.notifications': 'On macOS, GeminiCode asks the system for permission the first time.',
};

/** The intro, the prose between the tables, and the closing lines, as the guide has them. */
const intro = [
	'# Settings',
	'',
	'Every GeminiCode setting, in the sections of the [Settings page](helpers.md) (**Gemini: Settings**), which gives each one a switch, a picker or a field. VS Code\'s own Settings editor lists them too, under `gemini`. The Settings page also sets [a few of the Gemini CLI\'s own settings](helpers.md#gemini-cli-settings).',
	'',
	'A setting in a workspace\'s settings applies only to that folder, and is shared with everyone who opens it when the folder\'s `.vscode/settings.json` is checked in. Settings marked *machine* are set per Mac, never by a workspace.',
	'',
	'<!-- Generated from extensions/gemini/package.json by `node scripts/settings-doc.mts` in extensions/gemini. Edit the descriptions there. -->',
	'',
];

const whenApplies = [
	'## When a change applies',
	'',
	'When a description ends in "Changing this restarts the agent", the agent restarts once no turn is running, or at once when the change takes a permission away or changes `gemini.mcp.allowedServers`. Open agents resume their sessions. "Applies to agents started afterwards" means running agents keep what they had. Every other change applies at once.',
	'',
];

/** `%key%` to its words. */
function localized(text: string | undefined, strings: Readonly<Record<string, string>>): string {
	if (!text) {
		return '';
	}
	return /^%.+%$/.test(text) ? strings[text.slice(1, -1)] ?? text : text;
}

/** The editor's `#gemini.x#` links as backticked names, and a table cell's bars escaped. */
function cell(text: string): string {
	return text.replace(/#(gemini\.[\w.]+)#/g, '`$1`').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function describeDefault(property: Property): string {
	const value = property.default;
	if (typeof value === 'boolean') {
		return value ? 'on' : 'off';
	}
	if (typeof value === 'string') {
		if (!value) {
			return 'empty';
		}
		const index = property.enum?.indexOf(value) ?? -1;
		return index >= 0 && property.enumItemLabels?.[index] ? `${property.enumItemLabels[index]} (\`${value}\`)` : `\`${value}\``;
	}
	if (typeof value === 'number') {
		return `\`${value}\``;
	}
	if (Array.isArray(value)) {
		return value.length ? `\`${JSON.stringify(value)}\`` : 'empty';
	}
	if (value && typeof value === 'object') {
		return Object.keys(value as object).length ? `\`${JSON.stringify(value)}\`` : 'empty';
	}
	return 'none';
}

/** The guide's Markdown. */
export function renderSettingsDoc(input: SettingsDocInput): string {
	const lines: string[] = [...intro];
	const sections = [...input.configuration].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
	const deprecated: { readonly key: string; readonly message: string }[] = [];
	for (const section of sections) {
		const title = localized(section.title, input.strings).replace(/^Gemini: /, '');
		lines.push(`## ${title}`, '', '| Setting | Default | What it does |', '| --- | --- | --- |');
		for (const [key, property] of Object.entries(section.properties)) {
			if (property.deprecationMessage) {
				deprecated.push({ key, message: localized(property.deprecationMessage, input.strings) });
				continue;
			}
			const extra = more[key];
			const choices = property.enum && property.enumItemLabels ? ` Choices: ${property.enum.map((value, i) => `${property.enumItemLabels![i]} (\`${value}\`)`).join(', ')}.` : '';
			const text = `${localized(property.markdownDescription, input.strings)}${choices}${extra ? ` ${extra}` : ''}`;
			const scope = (property as { readonly scope?: string }).scope === 'machine' ? ' *(machine)*' : '';
			lines.push(`| \`${key}\`${scope} | ${describeDefault(property)} | ${cell(text)} |`);
		}
		lines.push('');
	}
	if (deprecated.length) {
		lines.push('## Renamed and removed', '', 'These names are still read for a release, so nothing you set is lost; the editor marks them.', '', '| Setting | What happened |', '| --- | --- |');
		for (const { key, message } of deprecated) {
			lines.push(`| \`${key}\` | ${cell(message)} |`);
		}
		lines.push('');
	}
	lines.push(...whenApplies);
	return lines.join('\n');
}
