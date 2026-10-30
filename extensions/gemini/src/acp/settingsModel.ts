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
		...setting.enum?.length ? { choices: setting.enum.map((value, i) => ({ value, label: String(value), ...setting.enumDescriptions?.[i] ? { help: setting.enumDescriptions[i] } : {} })) } : {},
		...setting.minimum !== undefined ? { minimum: setting.minimum } : {},
		...setting.maximum !== undefined ? { maximum: setting.maximum } : {},
		scope: setting.scope ?? 'window',
		advanced: !!setting.tags?.includes('advanced'),
		...deprecated ? { deprecated } : {},
	};
}

/** The sections in their contributed order, each setting in its contributed order. */
export function settingSections(configuration: readonly ContributedSection[]): SettingSection[] {
	return configuration
		.map((section, index) => ({ title: section.title, order: section.order ?? index, settings: Object.entries(section.properties).map(([key, setting]) => row(key, setting)) }))
		.sort((a, b) => a.order - b.order);
}

/**
 * The sections with only the settings `query` matches, by key, label, help
 * or a choice; an empty query shows every section without its advanced and
 * deprecated settings. Sections left empty are left out.
 */
export function filterSettings(sections: readonly SettingSection[], query: string): SettingSection[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const matches = (setting: SettingRow) => {
		if (!words.length) {
			return !setting.advanced && !setting.deprecated;
		}
		const text = [setting.key, setting.label, setting.help, ...(setting.choices ?? []).map(c => c.label)].join(' ').toLowerCase();
		return words.every(word => text.includes(word));
	};
	return sections.map(section => ({ ...section, settings: section.settings.filter(matches) })).filter(section => section.settings.length);
}
