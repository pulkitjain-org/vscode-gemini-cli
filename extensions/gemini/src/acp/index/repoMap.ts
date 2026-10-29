/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// An outline of a folder from its index, for orienting an agent before its
// first search: what the project says it is (its manifest and README), its
// languages, its main folders with their size, and the public definitions in
// each. Capped, since it travels with every session.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { IndexStore } from './indexStore';

export interface RepoMapOptions {
	/** A subfolder to outline instead of the whole folder. */
	readonly path?: string;
	/** How many folder levels to list. */
	readonly depth?: number;
	readonly maxChars?: number;
}

const defaultMaxChars = 6_000;
const symbolsPerFolder = 8;

export async function repoMap(store: IndexStore, root: string, options: RepoMapOptions = {}): Promise<string> {
	const maxChars = options.maxChars ?? defaultMaxChars;
	const prefix = (options.path ?? '').replace(/^\.?\/+|\/+$/g, '');
	const depth = Math.min(Math.max(options.depth ?? (prefix ? 2 : 2), 1), 4);
	const under = prefix ? `${prefix}/` : '';
	const files = (store.statement('SELECT path, lang FROM files WHERE skipped IS NULL AND path LIKE ? ESCAPE \'\\\' ORDER BY path').all(`${under.replace(/[%_\\]/g, '\\$&')}%`) as { path: string; lang: string }[]);
	if (!files.length) {
		return prefix ? `No indexed files under ${prefix}.` : 'The index has no files yet.';
	}
	const out: string[] = [];
	if (!prefix) {
		const about = await describeProject(root);
		if (about) {
			out.push(about, '');
		}
	}
	const languages = new Map<string, number>();
	for (const file of files) {
		languages.set(file.lang, (languages.get(file.lang) ?? 0) + 1);
	}
	const top = [...languages].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([lang, count]) => `${lang} ${count}`);
	out.push(`${files.length} files${prefix ? ` under ${prefix}` : ''} · ${top.join(', ')}`, '');

	// Folders to `depth` levels below the prefix, with their file counts.
	const folders = new Map<string, number>();
	const rootFiles: string[] = [];
	for (const file of files) {
		const rest = file.path.slice(under.length).split('/');
		if (rest.length === 1) {
			rootFiles.push(rest[0]);
		}
		for (let level = 1; level <= Math.min(depth, rest.length - 1); level++) {
			const folder = under + rest.slice(0, level).join('/');
			folders.set(folder, (folders.get(folder) ?? 0) + 1);
		}
	}
	const exportedBy = new Map<string, string[]>();
	for (const row of store.statement(`SELECT path, name, kind FROM symbols WHERE exported = 1 AND container IS NULL AND kind != 'heading' AND path LIKE ? ESCAPE '\\' ORDER BY path, line`).all(`${under.replace(/[%_\\]/g, '\\$&')}%`) as { path: string; name: string; kind: string }[]) {
		const folder = path.posix.dirname(row.path);
		const names = exportedBy.get(folder) ?? [];
		if (names.length < symbolsPerFolder * 3) {
			names.push(row.name);
			exportedBy.set(folder, names);
		}
	}
	if (rootFiles.length) {
		out.push(`${prefix || '.'}/: ${rootFiles.slice(0, 20).join(', ')}${rootFiles.length > 20 ? `, … ${rootFiles.length - 20} more` : ''}`);
	}
	for (const [folder, count] of [...folders].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
		const indent = '  '.repeat(folder.slice(under.length).split('/').length - 1);
		const names = exportedBy.get(folder);
		const line = `${indent}${folder}/ (${count} ${count === 1 ? 'file' : 'files'})${names?.length ? `: ${unique(names).slice(0, symbolsPerFolder).join(', ')}` : ''}`;
		if (out.join('\n').length + line.length > maxChars) {
			out.push(`${indent}…`);
			break;
		}
		out.push(line);
	}
	return out.join('\n').slice(0, maxChars);
}

function unique(names: readonly string[]): string[] {
	return [...new Set(names)];
}

/** One or two lines from the project's manifest and README. */
async function describeProject(root: string): Promise<string | undefined> {
	const lines: string[] = [];
	const read = (name: string) => fs.readFile(path.join(root, name), 'utf8').catch(() => undefined);
	const pkg = await read('package.json');
	if (pkg) {
		try {
			const json = JSON.parse(pkg) as { name?: string; description?: string; scripts?: Record<string, string> };
			const scripts = json.scripts ? Object.keys(json.scripts).slice(0, 12).join(', ') : '';
			lines.push(`package.json: ${[json.name, json.description].filter(Boolean).join(' · ')}${scripts ? ` · scripts: ${scripts}` : ''}`);
		} catch {
			// Not JSON; skip it.
		}
	}
	const manifests: [string, RegExp][] = [['pyproject.toml', /^name\s*=\s*"([^"]+)"/m], ['go.mod', /^module\s+(\S+)/m], ['Cargo.toml', /^name\s*=\s*"([^"]+)"/m], ['pom.xml', /<artifactId>([^<]+)<\/artifactId>/]];
	for (const [name, pattern] of manifests) {
		const text = await read(name);
		const match = text && pattern.exec(text);
		if (match) {
			lines.push(`${name}: ${match[1]}`);
		}
	}
	const readme = await read('README.md') ?? await read('readme.md');
	if (readme) {
		const paragraph = readme.split(/\n\s*\n/).map(p => p.trim()).find(p => p && !p.startsWith('#') && !p.startsWith('[!') && !p.startsWith('<') && !p.startsWith('![') && !p.startsWith('[!['));
		const title = /^#\s+(.+)$/m.exec(readme)?.[1];
		const summary = [title, paragraph?.replace(/\s+/g, ' ').slice(0, 300)].filter(Boolean).join(': ');
		if (summary) {
			lines.push(`README: ${summary}`);
		}
	}
	return lines.length ? lines.join('\n') : undefined;
}
