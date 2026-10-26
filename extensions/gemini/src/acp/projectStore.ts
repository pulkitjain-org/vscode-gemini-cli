/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A project's settings and memory, kept in the project's own folder
// (~/.geminicode/projects/<id>, where its coordinator runs): project.json
// (repositories, which memory files each role reads, defaults for new
// threads), instructions.md (the Memory text: how the repositories connect,
// or the project's instructions) and memory/*.md (context files). Nothing is
// kept in the repositories. The coordinator reads the memory in its wake, and
// a thread in its brief; the CLI's own rules loading is not used for it,
// because it imports files only from inside a session's folder.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { samePath, writeFileAtomic } from './fsUtil';

/** One of a project's repositories: `key` names it to the agents and is its folder's name in a thread's folder. */
export interface ProjectRepo {
	readonly key: string;
	/** The repository's top folder. */
	readonly folder: string;
}

/** A context file in the project's memory folder, and who reads it. */
export interface MemoryFile {
	readonly name: string;
	readonly coordinator: boolean;
	readonly threads: boolean;
}

/** What new threads start with, unless the New thread dialog says otherwise. */
export interface ProjectDefaults {
	/** The thread's model; unset for the one new agents get. */
	readonly threadModel?: string;
	readonly planFirst?: boolean;
	/** Put before a thread's branch name, such as `gemini/`. */
	readonly branchPrefix?: string;
}

export interface ProjectConfig {
	/** The first is the project's own repository: the one it was made from. */
	readonly repos: readonly ProjectRepo[];
	/** The Memory text. */
	readonly instructions: string;
	readonly files: readonly MemoryFile[];
	readonly defaults: ProjectDefaults;
	/** When Gemini drafted the Memory text, until the user saves their own; the popup asks them to review it. */
	readonly draftedAt?: number;
}

export const configFile = 'project.json';
export const instructionsFile = 'instructions.md';
export const memoryFolder = 'memory';
/** The Memory text's limit, as the popup counts it. */
export const maxInstructionsChars = 16_000;
/** The most of any one context file an agent is sent. */
const maxFileChars = 24_000;

/** A repository's key: its folder's name, with its parent's name in front when another repository has that name. */
export function repoKey(folder: string, taken: readonly string[]): string {
	const base = path.basename(folder) || 'repository';
	if (!taken.includes(base)) {
		return base;
	}
	const parent = path.basename(path.dirname(folder));
	const named = parent ? `${parent}-${base}` : base;
	let key = named;
	for (let n = 2; taken.includes(key); n++) {
		key = `${named}-${n}`;
	}
	return key;
}

/** A project's name from its repositories: their names' shared start (`acme-content`, `acme-checkout` → `acme`), else the first one's. */
export function suggestedName(repos: readonly ProjectRepo[]): string {
	const names = repos.map(repo => repo.key);
	if (names.length < 2) {
		return names[0] ?? '';
	}
	const words = names.map(name => name.split(/[-_. ]+/));
	const shared: string[] = [];
	for (let i = 0; words.every(w => i < w.length - 1 && w[i].toLowerCase() === words[0][i].toLowerCase()); i++) {
		shared.push(words[0][i]);
	}
	return shared.length ? shared.join('-') : names[0];
}

/** Reads a project's config; a project without one has just `repository`. */
export async function readProjectConfig(folder: string, repository: string): Promise<ProjectConfig> {
	const [raw, instructions, onDisk] = await Promise.all([
		fs.readFile(path.join(folder, configFile), 'utf8').then(text => JSON.parse(text) as unknown, () => undefined),
		fs.readFile(path.join(folder, instructionsFile), 'utf8').catch(() => ''),
		memoryFileNames(folder),
	]);
	const saved = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const repos: ProjectRepo[] = [];
	for (const repo of Array.isArray(saved.repos) ? saved.repos : []) {
		if (typeof repo?.key === 'string' && typeof repo.folder === 'string' && path.isAbsolute(repo.folder) && !repos.some(r => r.key === repo.key)) {
			repos.push({ key: repo.key, folder: repo.folder });
		}
	}
	if (!repos.some(repo => samePath(repo.folder, repository))) {
		repos.unshift({ key: repoKey(repository, repos.map(r => r.key)), folder: repository });
	}
	// The file list follows the folder: a file added there shows up, read by both, and one deleted goes.
	const listed = (Array.isArray(saved.files) ? saved.files : []).filter((file): file is MemoryFile => typeof file?.name === 'string');
	const files = onDisk.map(name => {
		const entry = listed.find(file => file.name === name);
		return { name, coordinator: entry ? entry.coordinator !== false : true, threads: entry ? entry.threads !== false : true };
	});
	const defaults = (saved.defaults && typeof saved.defaults === 'object' ? saved.defaults : {}) as Record<string, unknown>;
	return {
		repos,
		instructions,
		files,
		defaults: {
			...(typeof defaults.threadModel === 'string' && defaults.threadModel ? { threadModel: defaults.threadModel } : {}),
			...(typeof defaults.planFirst === 'boolean' ? { planFirst: defaults.planFirst } : {}),
			...(typeof defaults.branchPrefix === 'string' ? { branchPrefix: defaults.branchPrefix } : {}),
		},
		...(typeof saved.draftedAt === 'number' ? { draftedAt: saved.draftedAt } : {}),
	};
}

/** How many repositories a project's saved config lists, without reading the rest; 0 when it has none saved. */
export async function savedRepoCount(folder: string): Promise<number> {
	const raw = await fs.readFile(path.join(folder, configFile), 'utf8').then(text => JSON.parse(text) as { repos?: unknown }, () => undefined);
	return Array.isArray(raw?.repos) ? raw.repos.length : 0;
}

/** Saves a project's config and Memory text. */
export async function writeProjectConfig(folder: string, config: ProjectConfig): Promise<void> {
	await fs.mkdir(folder, { recursive: true });
	const { instructions, ...rest } = config;
	await writeFileAtomic(path.join(folder, configFile), `${JSON.stringify({ version: 1, ...rest }, undefined, '\t')}\n`);
	await writeFileAtomic(path.join(folder, instructionsFile), instructions.slice(0, maxInstructionsChars));
}

/** The Markdown files in a project's memory folder, by name. */
export async function memoryFileNames(folder: string): Promise<string[]> {
	const entries = await fs.readdir(path.join(folder, memoryFolder), { withFileTypes: true }).catch(() => []);
	return entries.filter(entry => entry.isFile() && /\.md$/i.test(entry.name)).map(entry => entry.name).sort((a, b) => a.localeCompare(b));
}

/** Copies `sources` into the project's memory folder, renaming any whose name is taken; returns the new names. */
export async function addMemoryFiles(folder: string, sources: readonly string[]): Promise<string[]> {
	const dir = path.join(folder, memoryFolder);
	await fs.mkdir(dir, { recursive: true });
	const added: string[] = [];
	for (const source of sources) {
		const name = await freeName(dir, path.basename(source).replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '-') || 'notes');
		await fs.copyFile(source, path.join(dir, name));
		added.push(name);
	}
	return added;
}

/** Makes an empty context file named after `title`; returns its path. */
export async function newMemoryFile(folder: string, title: string): Promise<string> {
	const dir = path.join(folder, memoryFolder);
	await fs.mkdir(dir, { recursive: true });
	const name = await freeName(dir, title.trim().toLowerCase().replace(/\.md$/i, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'notes');
	const file = path.join(dir, name);
	await fs.writeFile(file, `# ${title.trim().replace(/\.md$/i, '') || 'Notes'}\n\n`, { flag: 'wx' });
	return file;
}

export async function removeMemoryFile(folder: string, name: string): Promise<void> {
	if (path.basename(name) !== name) {
		return;
	}
	await fs.rm(path.join(folder, memoryFolder, name), { force: true });
}

/**
 * The memory a role reads, as one block: the Memory text, then each context
 * file it reads. Undefined when there is none.
 */
export async function projectMemory(folder: string, config: ProjectConfig, role: 'coordinator' | 'threads'): Promise<string | undefined> {
	const parts: string[] = [];
	if (config.instructions.trim()) {
		parts.push(config.instructions.trim());
	}
	const files = config.files.filter(file => file[role]);
	const texts = await Promise.all(files.map(file => fs.readFile(path.join(folder, memoryFolder, file.name), 'utf8').catch(() => '')));
	files.forEach((file, i) => {
		const text = texts[i].trim();
		if (text) {
			parts.push(`## ${file.name}\n\n${text.length > maxFileChars ? `${text.slice(0, maxFileChars)}\n\n[cut: the file is longer]` : text}`);
		}
	});
	return parts.length ? parts.join('\n\n') : undefined;
}

/** Roughly how many tokens `text` costs: about four characters each. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

async function freeName(dir: string, stem: string): Promise<string> {
	for (let n = 1; ; n++) {
		const name = n === 1 ? `${stem}.md` : `${stem}-${n}.md`;
		if (!await fs.access(path.join(dir, name)).then(() => true, () => false)) {
			return name;
		}
	}
}
