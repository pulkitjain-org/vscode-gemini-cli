/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Settings page's model, built from the extension's own contributed
// configuration (package.json), so the page lists every setting and never
// drifts from it: its sections in order, each setting with the control that
// edits it, and what is advanced, deprecated or an administrator's.

export interface ContributedSetting {
	readonly type?: string | readonly string[];
	readonly default?: unknown;
	readonly enum?: readonly unknown[];
	readonly enumDescriptions?: readonly string[];
	/** The choices' names, when they are not the values themselves. */
	readonly enumItemLabels?: readonly string[];
	readonly description?: string;
	readonly markdownDescription?: string;
	readonly deprecationMessage?: string;
	readonly markdownDeprecationMessage?: string;
	readonly tags?: readonly string[];
	readonly scope?: string;
	readonly minimum?: number;
	readonly maximum?: number;
}

export interface ContributedSection {
	readonly title: string;
	readonly order?: number;
	readonly properties: Readonly<Record<string, ContributedSetting>>;
}

export type SettingControl = 'toggle' | 'picker' | 'number' | 'text' | 'list' | 'json';

export interface SettingRow {
	/** The full key, `gemini.agents.ownBranch`. */
	readonly key: string;
	/** The key's last part as words: "Own branch". */
	readonly label: string;
	/** The description, with Markdown's code marks left as they are. */
	readonly help: string;
	readonly control: SettingControl;
	readonly default: unknown;
	readonly choices?: readonly { readonly value: unknown; readonly label: string; readonly help?: string }[];
	readonly minimum?: number;
	readonly maximum?: number;
	/** `machine`, `window`, `resource` or `application`; window when unsaid. */
	readonly scope: string;
	/** Hidden unless searched for, or shown under "Advanced". */
	readonly advanced: boolean;
	/** Read for a release more, under its message; hidden unless searched for. */
	readonly deprecated?: string;
}

export interface SettingSection {
	/** The section's title key or text as contributed, `%section.agents%` or "Agents". */
	readonly title: string;
	readonly order: number;
	readonly settings: readonly SettingRow[];
}

/** The key's last part as words: `ownBranch` -> "Own branch", `maxRunningThreads` -> "Max running threads", `cli.version` -> "Cli version". */
export function settingLabel(key: string): string {
	const parts = key.replace(/^gemini\./, '').split('.');
	const words = (parts.length > 2 ? parts.slice(1) : parts.slice(-1)).join(' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export function settingControl(setting: ContributedSetting): SettingControl {
	if (setting.enum?.length) {
		return 'picker';
	}
	const types = Array.isArray(setting.type) ? setting.type : [setting.type];
	if (types.includes('boolean')) {
		return 'toggle';
	}
	if (types.includes('number') || types.includes('integer')) {
		return 'number';
	}
	if (types.includes('array')) {
		return 'list';
	}
	if (types.includes('object')) {
		return 'json';
	}
	return 'text';
}

function row(key: string, setting: ContributedSetting): SettingRow {
	const deprecated = setting.deprecationMessage ?? setting.markdownDeprecationMessage;
	return {
		key,
		label: settingLabel(key),
		help: setting.markdownDescription ?? setting.description ?? '',
		control: settingControl(setting),
		default: setting.default,
		...setting.enum?.length ? { choices: setting.enum.map((value, i) => ({ value, label: setting.enumItemLabels?.[i] ?? String(value), ...setting.enumDescriptions?.[i] ? { help: setting.enumDescriptions[i] } : {} })) } : {},
		...setting.minimum !== undefined ? { minimum: setting.minimum } : {},
		...setting.maximum !== undefined ? { maximum: setting.maximum } : {},
		scope: setting.scope ?? 'window',
		advanced: !!setting.tags?.includes('advanced'),
		...deprecated ? { deprecated } : {},
	};
}

/** The sections in their contributed order, each setting in its contributed order. */
export function settingSections(configuration: readonly ContributedSection[]): SettingSection[] {
	const sections = configuration
		.map((section, index) => ({ title: section.title, order: section.order ?? index, settings: Object.entries(section.properties).map(([key, setting]) => row(key, setting)) }))
		.sort((a, b) => a.order - b.order);
	// Two settings with the same label (gemini.cli.checkForUpdates, gemini.app.checkForUpdates) are named by their group too.
	const counts = new Map<string, number>();
	for (const setting of sections.flatMap(section => section.settings)) {
		counts.set(setting.label, (counts.get(setting.label) ?? 0) + 1);
	}
	return sections.map(section => ({ ...section, settings: section.settings.map(setting => (counts.get(setting.label) ?? 0) > 1 ? { ...setting, label: groupedLabel(setting.key) } : setting) }));
}

/** Words in a key that are written in capitals. */
const acronyms: Readonly<Record<string, string>> = { cli: 'CLI', mcp: 'MCP', app: 'GeminiCode' };

/** A setting's label with its group in front: `gemini.cli.checkForUpdates` -> "CLI: Check for updates". */
function groupedLabel(key: string): string {
	const [group] = key.replace(/^gemini\./, '').split('.');
	return `${acronyms[group] ?? group.charAt(0).toUpperCase() + group.slice(1)}: ${settingLabel(key)}`;
}

/** What a search reads of a setting: the model's rows and the page's views both have it. */
export type SearchableSetting = Pick<SettingRow, 'key' | 'label' | 'help' | 'choices' | 'advanced' | 'deprecated'>;

/**
 * The sections with only the settings `query` matches, by key, label, help
 * or a choice; an empty query shows every section without its advanced and
 * deprecated settings. Sections left empty are left out.
 */
export function filterSettings<S extends { readonly settings: readonly SearchableSetting[] }>(sections: readonly S[], query: string): S[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const matches = (setting: SearchableSetting) => {
		if (!words.length) {
			return !setting.advanced && !setting.deprecated;
		}
		const text = [setting.key, setting.label, setting.help, ...(setting.choices ?? []).map(c => c.label)].join(' ').toLowerCase();
		return words.every(word => text.includes(word));
	};
	return sections.map(section => ({ ...section, settings: section.settings.filter(matches) })).filter(section => section.settings.length);
}

/** `text` with each `%key%` replaced by the string package.nls.json gives it; an unknown key stays as written. */
export function resolveNls(text: string, strings: Readonly<Record<string, string>>): string {
	return text.replace(/%([\w.-]+)%/g, (match, key: string) => strings[key] ?? match);
}

/** A section's title for the page: resolved, without the "Gemini: " every contributed title starts with. */
export function sectionTitle(title: string, strings: Readonly<Record<string, string>>): string {
	return resolveNls(title, strings).replace(/^Gemini:\s*/, '');
}

/** A section's id for anchors: `%configuration.accountTitle%` -> `account`, "Team Tools" -> `team-tools`. */
export function sectionId(title: string): string {
	const key = /^%([\w.-]+)%$/.exec(title)?.[1];
	const base = key ? key.replace(/^configuration\./, '').replace(/Title$/, '') : title;
	return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
}

/** A piece of a setting's help: plain text, or code to show as such. */
export interface HelpSegment {
	readonly text: string;
	readonly code?: true;
}

/**
 * A description's Markdown as the page shows it: `code` and `#gemini.key#`
 * references as code, links as their text, emphasis as plain words.
 */
export function helpSegments(help: string): HelpSegment[] {
	const segments: HelpSegment[] = [];
	const plain = (text: string) => {
		const words = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:])/g, '$1$2');
		if (words) {
			segments.push({ text: words });
		}
	};
	const pattern = /`([^`]+)`|#(gemini\.[\w.]+)#/g;
	let last = 0;
	for (const match of help.matchAll(pattern)) {
		plain(help.slice(last, match.index));
		// A setting named in backticks too (`#gemini.x#`) shows as the setting's key, without the link marks.
		segments.push({ text: (match[1] ?? match[2]).replace(/^#(gemini\.[\w.]+)#$/, '$1'), code: true });
		last = match.index + match[0].length;
	}
	plain(help.slice(last));
	return segments;
}

/** What `WorkspaceConfiguration.inspect` reports for a key: the values the settings files hold. */
export interface InspectedSetting {
	readonly defaultValue?: unknown;
	readonly globalValue?: unknown;
	readonly workspaceValue?: unknown;
	readonly workspaceFolderValue?: unknown;
}

/** Whether two setting values are the same, by their JSON. */
export function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The value the settings files give a key, as the editor merges them: the folder's, the workspace's, the user's, else the default. */
export function inspectedValue(inspected: InspectedSetting | undefined): unknown {
	return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue ?? inspected?.defaultValue;
}

/**
 * Whether an administrator's policy decides the setting. The editor's `get`
 * returns a policy's value ahead of every settings file, while `inspect`
 * reports only the files, so a value that matches none of them is a policy's.
 */
export function isPolicyLocked(effective: unknown, inspected: InspectedSetting | undefined): boolean {
	return !sameValue(effective, inspectedValue(inspected));
}

export type SettingTarget = 'global' | 'workspace';

/**
 * Where a change is written: the user's settings for most, the workspace's for
 * a resource-scoped setting when a folder is open; a machine- or
 * application-scoped one never goes into a workspace.
 */
export function settingTarget(scope: string, workspaceOpen: boolean): SettingTarget {
	return scope === 'resource' && workspaceOpen ? 'workspace' : 'global';
}

/** `value` as the setting's control gives it, checked against the contribution; undefined when it does not fit. */
export function parseSettingValue(setting: SettingRow, value: unknown): { readonly value: unknown } | undefined {
	switch (setting.control) {
		case 'toggle':
			return typeof value === 'boolean' ? { value } : undefined;
		case 'number': {
			const number = typeof value === 'string' ? Number(value) : value;
			if (typeof number !== 'number' || !Number.isFinite(number)) {
				return undefined;
			}
			if ((setting.minimum !== undefined && number < setting.minimum) || (setting.maximum !== undefined && number > setting.maximum)) {
				return undefined;
			}
			return { value: Number.isInteger(setting.default) && !Number.isInteger(number) ? Math.round(number) : number };
		}
		case 'picker':
			return setting.choices?.some(choice => sameValue(choice.value, value)) ? { value } : undefined;
		case 'text':
			return typeof value === 'string' ? { value } : undefined;
		case 'list':
			return Array.isArray(value) && value.every(item => typeof item === 'string') ? { value: value.map(item => item.trim()).filter(Boolean) } : undefined;
		case 'json':
			return value !== null && typeof value === 'object' && !Array.isArray(value) ? { value } : undefined;
	}
}
