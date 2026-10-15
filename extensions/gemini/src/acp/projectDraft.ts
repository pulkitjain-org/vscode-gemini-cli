/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Gemini's first draft of a project's Memory text. GeminiCode reads a few
// telling files from each repository (its README, its agent rules, its
// manifest and top folders) and sends them in one direct request; no agent
// session reads the repositories. The user reviews the draft in Project
// settings, which says it was drafted until they save their own.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ProjectRepo } from './projectStore';

export interface RepoFacts {
	readonly key: string;
	/** Top-level folders and files, without dot entries. */
	readonly top: readonly string[];
	/** The start of each telling file, by its path in the repository. */
	readonly files: readonly { readonly name: string; readonly text: string }[];
}

/** Files that say what a repository is, read in this order. */
const tellingFiles = ['README.md', 'readme.md', 'GEMINI.md', 'AGENTS.md', 'package.json', 'pom.xml', 'build.gradle', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'composer.json'];
/** How much of one file is read: enough to say what it is. */
const maxFileChars = 3_000;
const maxTopEntries = 40;

export async function repoFacts(repo: ProjectRepo): Promise<RepoFacts> {
	const entries = await fs.readdir(repo.folder, { withFileTypes: true }).catch(() => []);
	const top = entries
		.filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
		.map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name)
		.sort((a, b) => a.localeCompare(b))
		.slice(0, maxTopEntries);
	const names = new Set(entries.map(entry => entry.name));
	const files: { name: string; text: string }[] = [];
	for (const name of tellingFiles) {
		// README.md and readme.md are one file on a case-insensitive disk.
		if (!names.has(name) || files.some(file => file.name.toLowerCase() === name.toLowerCase())) {
			continue;
		}
		const text = await fs.readFile(path.join(repo.folder, name), 'utf8').catch(() => '');
		if (text.trim()) {
			files.push({ name, text: text.length > maxFileChars ? `${text.slice(0, maxFileChars)}\n[...]` : text });
		}
	}
	return { key: repo.key, top, files };
}

/** The direct request that drafts the Memory text from the repositories' facts. */
export function draftRequest(facts: readonly RepoFacts[]): { readonly system: string; readonly prompt: string } {
	const many = facts.length > 1;
	const system = [
		'You write the shared notes that every coding agent in a project reads before it works.',
		many
			? 'Say what each repository owns and where the repositories meet: the APIs, queries, content or data models, URLs, events or packages one side relies on from the other, and any order changes must ship in.'
			: 'Say what the repository is for, its stack, where the main parts live, and how to build and test it.',
		'Use only what the files show. Where they do not say, leave it out rather than guess.',
		'Plain Markdown, no title, at most about 25 short lines: a sentence or two, then bullet points. Name repositories exactly as given.',
	].join(' ');
	const prompt = facts.map(repo => [
		`<repository name="${repo.key}">`,
		`Top level: ${repo.top.join(', ') || '(empty)'}`,
		...repo.files.map(file => `<file name="${file.name}">\n${file.text.trim()}\n</file>`),
		'</repository>',
	].join('\n')).join('\n\n');
	return { system, prompt };
}

/** The model's draft, without fences or a heading it was asked not to write. */
export function cleanDraft(text: string): string {
	return text.trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, '$1').replace(/^#\s[^\n]*\n+/, '').trim();
}
