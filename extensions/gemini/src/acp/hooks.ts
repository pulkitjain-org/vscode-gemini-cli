/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Gemini CLI hooks: commands the CLI runs at points in a turn, kept in
// settings.json. Mirrors gemini-cli 0.62 (`HookRegistry`):
//
//   "hooks": { "AfterTool": [ { "matcher": "write_file|replace",
//                               "hooks": [ { "type": "command", "command": "npx prettier --write ." } ] } ] },
//   "hooksConfig": { "disabled": ["npx prettier --write ."] }
//
// A hook is named by its `name`, else its command; `hooksConfig.disabled`
// lists the names switched off. Project hooks run only in trusted folders.

import { isRecord, updateSettingsFile } from './projectSettings';

/** The events the CLI runs hooks for, in the order a turn meets them. */
export const hookEvents = [
	'SessionStart', 'BeforeAgent', 'BeforeModel', 'AfterModel', 'BeforeToolSelection',
	'BeforeTool', 'AfterTool', 'Notification', 'AfterAgent', 'PreCompress', 'SessionEnd',
] as const;
export type HookEvent = typeof hookEvents[number];

/** Events whose `matcher` picks tools by name. */
export const toolEvents: ReadonlySet<string> = new Set(['BeforeTool', 'AfterTool']);

export interface HookEntry {
	readonly event: string;
	/** The tool names it applies to (a regular expression), for tool events. */
	readonly matcher?: string;
	readonly command: string;
	/** What `hooksConfig.disabled` lists: its name, else its command. */
	readonly name: string;
	readonly enabled: boolean;
	/** The settings file it is in. */
	readonly file: string;
}

/** The command hooks a settings object defines, in its order. Runtime and plugin hooks are not the user's to edit here. */
export function hooksIn(settings: Record<string, unknown>, file: string, disabled: ReadonlySet<string>): HookEntry[] {
	const hooks = settings.hooks;
	if (!isRecord(hooks)) {
		return [];
	}
	const entries: HookEntry[] = [];
	for (const [event, definitions] of Object.entries(hooks)) {
		if (!(hookEvents as readonly string[]).includes(event) || !Array.isArray(definitions)) {
			continue;
		}
		for (const definition of definitions) {
			if (!isRecord(definition) || !Array.isArray(definition.hooks)) {
				continue;
			}
			const matcher = typeof definition.matcher === 'string' && definition.matcher ? definition.matcher : undefined;
			for (const hook of definition.hooks) {
				if (!isRecord(hook) || hook.type !== 'command' || typeof hook.command !== 'string' || !hook.command) {
					continue;
				}
				const name = typeof hook.name === 'string' && hook.name ? hook.name : hook.command;
				entries.push({ event, ...(matcher ? { matcher } : {}), command: hook.command, name, enabled: !disabled.has(name), file });
			}
		}
	}
	return entries;
}

/** The hook names `hooksConfig.disabled` switches off. */
export function disabledHooks(settings: Record<string, unknown>): Set<string> {
	const config = settings.hooksConfig;
	const list = isRecord(config) && Array.isArray(config.disabled) ? config.disabled : [];
	return new Set(list.filter((n): n is string => typeof n === 'string'));
}

/** Adds a command hook. False when the file has comments, which GeminiCode will not rewrite. */
export function addHook(file: string, event: HookEvent, command: string, matcher?: string): Promise<boolean> {
	return updateSettingsFile(file, settings => {
		const hooks = isRecord(settings.hooks) ? settings.hooks : {};
		const definitions = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
		const definition: Record<string, unknown> = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] };
		settings.hooks = { ...hooks, [event]: [...definitions, definition] };
	});
}

/** Switches a hook on or off in `file`, as the CLI's /hooks enable and disable do. False when the file has comments. */
export function setHookEnabled(file: string, name: string, enabled: boolean): Promise<boolean> {
	return updateSettingsFile(file, settings => {
		const config = isRecord(settings.hooksConfig) ? settings.hooksConfig : {};
		const disabled = [...disabledHooks(settings)].filter(n => n !== name);
		settings.hooksConfig = { ...config, disabled: enabled ? disabled : [...disabled, name] };
	});
}
