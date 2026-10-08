/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent skills: folders holding a SKILL.md whose front matter names the skill
// and says when to use it. Mirrors gemini-cli 0.62 (`loadSkillsFromDir`): it
// reads SKILL.md and */SKILL.md under ~/.gemini/skills and ~/.agents/skills,
// then, in trusted folders, under the project's .gemini/skills and
// .agents/skills; a later folder's skill replaces one with the same name.
// The model loads one with its `activate_skill` tool. `skills.disabled` in a
// settings file switches skills off by name, ignoring case; the CLI merges the
// lists of every file, so a skill off in any of them is off.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isRecord, updateSettingsFile } from './projectSettings';

export interface Skill {
	readonly name: string;
	readonly description: string;
	/** Its SKILL.md. */
	readonly file: string;
	/** Whether it is the user's own (home folder) rather than the project's. */
	readonly personal: boolean;
}

export interface SkillFolder {
	readonly folder: string;
	readonly personal: boolean;
}

/** Where skills are read from, lowest precedence first. */
export function skillFolders(projectRoot: string | undefined, home = os.homedir()): SkillFolder[] {
	const folders: SkillFolder[] = [
		{ folder: path.join(home, '.gemini', 'skills'), personal: true },
		{ folder: path.join(home, '.agents', 'skills'), personal: true },
	];
	if (projectRoot && path.resolve(projectRoot) !== path.resolve(home)) {
		folders.push(
			{ folder: path.join(projectRoot, '.gemini', 'skills'), personal: false },
			{ folder: path.join(projectRoot, '.agents', 'skills'), personal: false },
		);
	}
	return folders;
}

/** A SKILL.md is a page or two; larger files are not skills. */
const maxFileBytes = 256 * 1024;
const maxSkillsPerFolder = 200;

/** Reads the skills in `folders`, sorted by name; a later folder wins a name clash. */
export async function loadSkills(folders: readonly SkillFolder[]): Promise<Skill[]> {
	const byName = new Map<string, Skill>();
	for (const { folder, personal } of folders) {
		for (const file of await skillFiles(folder)) {
			try {
				const stat = await fs.stat(file);
				if (stat.size > maxFileBytes) {
					continue;
				}
				const meta = parseSkillFrontmatter(await fs.readFile(file, 'utf8'));
				if (meta) {
					byName.set(meta.name, { ...meta, file, personal });
				}
			} catch {
				// Unreadable: not offered, as in the CLI.
			}
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function skillFiles(folder: string): Promise<string[]> {
	let entries;
	try {
		entries = await fs.readdir(folder, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.isFile() && entry.name === 'SKILL.md') {
			files.push(path.join(folder, entry.name));
		} else if ((entry.isDirectory() || entry.isSymbolicLink()) && entry.name !== 'node_modules' && entry.name !== '.git') {
			const file = path.join(folder, entry.name, 'SKILL.md');
			if (await fs.access(file).then(() => true, () => false)) {
				files.push(file);
			}
		}
		if (files.length >= maxSkillsPerFolder) {
			break;
		}
	}
	return files.sort();
}

/**
 * The name and description from a SKILL.md's YAML front matter, or undefined
 * when either is missing. Handles plain, quoted, folded (`>`) and literal
 * (`|`) values and indented continuation lines; nothing else of YAML matters
 * here.
 */
export function parseSkillFrontmatter(text: string): { name: string; description: string } | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!match) {
		return undefined;
	}
	const lines = match[1].split(/\r?\n/);
	const fields: Record<string, string> = {};
	for (let i = 0; i < lines.length; i++) {
		const field = /^(name|description):\s*(.*)$/.exec(lines[i]);
		if (!field) {
			continue;
		}
		const parts = /^[|>][+-]?$/.test(field[2].trim()) ? [] : [field[2].trim()];
		while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) {
			parts.push(lines[++i].trim());
		}
		fields[field[1]] = unquote(parts.filter(Boolean).join(' '));
	}
	const name = fields.name?.replace(/[:\\/<>*?"|]/g, '-');
	return name && fields.description ? { name, description: fields.description } : undefined;
}

function unquote(value: string): string {
	const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
	return quoted ? quoted[2] : value;
}

/** The skill names, lowercased, that `skills.disabled` in a settings object switches off. */
export function disabledSkills(settings: Record<string, unknown>): Set<string> {
	const list = isRecord(settings.skills) && Array.isArray(settings.skills.disabled) ? settings.skills.disabled : [];
	return new Set(list.filter((n): n is string => typeof n === 'string').map(n => n.toLowerCase()));
}

/** Switches a skill on or off in `file`, as the CLI's /skills enable and disable do. False when the file has comments. */
export function setSkillEnabled(file: string, name: string, enabled: boolean): Promise<boolean> {
	return updateSettingsFile(file, settings => {
		const config = isRecord(settings.skills) ? settings.skills : {};
		const list = Array.isArray(config.disabled) ? config.disabled.filter((n): n is string => typeof n === 'string') : [];
		const others = list.filter(n => n.toLowerCase() !== name.toLowerCase());
		settings.skills = { ...config, disabled: enabled ? others : [...others, name] };
	});
}

/** A skill name as the CLI writes them: lowercase words joined by dashes. */
export function skillSlug(text: string): string {
	return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/** A new skill's SKILL.md: front matter, then sections to fill in. */
export function skillTemplate(name: string, description: string): string {
	return [
		'---',
		`name: ${name}`,
		`description: ${description.replace(/\s+/g, ' ').trim()}`,
		'---',
		'',
		`# ${name}`,
		'',
		'## When to use',
		'',
		'Describe the tasks this skill is for, so Gemini knows when to load it.',
		'',
		'## Steps',
		'',
		'1. The first thing to do.',
		'2. The next.',
		'',
		'## Notes',
		'',
		'Conventions, commands and pitfalls to know. Put longer references or scripts in files next to',
		'this one and say here when to read or run them.',
		'',
	].join('\n');
}

/** The prompt a skill picked from the "/" menu sends: load the skill, then the words typed after it. */
export function skillPrompt(name: string, args: string): string {
	const load = `Use the activate_skill tool to load the "${name}" skill, then follow it.`;
	return args.trim() ? `${load}\n\n${args.trim()}` : load;
}
