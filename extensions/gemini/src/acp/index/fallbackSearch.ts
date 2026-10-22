/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Search without an index, while a folder's first build runs: the app's own
// ripgrep (it ships with VS Code), with the same caps as indexed results, so
// a session that starts before any index exists still gets answers.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { listFiles } from '../folderFiles';
import { queryTerms, type SearchHit, type SearchResult } from './query';

const timeoutMs = 5_000;
const maxOutputBytes = 2 * 1024 * 1024;

/** The ripgrep that ships with the app, under `appRoot`, unpacked from its archive in a release build. */
export async function appRipgrep(appRoot: string, platform: string = process.platform, arch: string = process.arch): Promise<string | undefined> {
	const binary = platform === 'win32' ? 'rg.exe' : 'rg';
	for (const modules of ['node_modules.asar.unpacked', 'node_modules']) {
		const candidate = path.join(appRoot, modules, '@vscode', 'ripgrep-universal', 'bin', `${platform}-${arch}`, binary);
		if (await fs.access(candidate).then(() => true, () => false)) {
			return candidate;
		}
	}
	return undefined;
}

/** Lines matching any of the query's words, grouped into hits of nearby lines, best-covered files first. */
export async function ripgrepSearch(rg: string | undefined, root: string, query: string, limit: number, glob?: string): Promise<SearchResult> {
	const { words } = queryTerms(query);
	if (!rg || !words.length) {
		return { hits: [], total: 0, terms: words };
	}
	const args = ['--line-number', '--no-heading', '--ignore-case', '--max-count', '20', '--max-columns', '300', '--max-filesize', '1M', '--color', 'never'];
	if (glob) {
		args.push('--glob', glob);
	}
	for (const word of words) {
		args.push('-e', word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	}
	args.push('--', '.');
	const output = await run(rg, args, root);
	return groupLines(output, words, limit);
}

/** Definitions of `name` in common languages, for find_symbol without an index. */
export async function ripgrepDefinitions(rg: string | undefined, root: string, name: string): Promise<{ path: string; line: number; text: string }[]> {
	if (!rg || !/^\w+$/.test(name)) {
		return [];
	}
	const pattern = `\\b(class|interface|type|enum|struct|trait|def|function|func|fn|module|namespace)\\s+${name}\\b|\\b(const|let|var)\\s+${name}\\s*[:=]|^\\s*func\\s+\\([^)]*\\)\\s*${name}\\b`;
	const output = await run(rg, ['--line-number', '--no-heading', '--max-count', '5', '--max-columns', '300', '--color', 'never', '-e', pattern, '--', '.'], root);
	return parseLines(output).slice(0, 20).map(({ file, line, text }) => ({ path: file, line, text: text.trim() }));
}

function run(rg: string, args: string[], cwd: string): Promise<string> {
	return new Promise(resolve => {
		execFile(rg, args, { cwd, timeout: timeoutMs, maxBuffer: maxOutputBytes, windowsHide: true }, (_err, stdout) => resolve(typeof stdout === 'string' ? stdout : ''));
	});
}

function parseLines(output: string): { file: string; line: number; text: string }[] {
	const lines: { file: string; line: number; text: string }[] = [];
	for (const raw of output.split('\n')) {
		const match = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(raw);
		if (match) {
			lines.push({ file: match[1].replace(/\\/g, '/'), line: Number(match[2]), text: match[3] });
		}
	}
	return lines;
}

export function groupLines(output: string, words: readonly string[], limit: number): SearchResult {
	const byFile = new Map<string, { line: number; text: string }[]>();
	for (const { file, line, text } of parseLines(output)) {
		const list = byFile.get(file) ?? [];
		list.push({ line, text });
		byFile.set(file, list);
	}
	const covered = (lines: readonly { text: string }[]) => words.filter(word => lines.some(l => l.text.toLowerCase().includes(word))).length;
	const ranked = [...byFile].sort((a, b) => covered(b[1]) - covered(a[1]) || b[1].length - a[1].length);
	const hits: SearchHit[] = [];
	for (const [file, lines] of ranked) {
		let group: { line: number; text: string }[] = [];
		const flush = () => {
			if (group.length) {
				hits.push({ path: file, startLine: group[0].line, endLine: group[group.length - 1].line, text: group.map(l => l.text).join('\n') });
			}
			group = [];
		};
		for (const line of lines.sort((a, b) => a.line - b.line)) {
			if (group.length && line.line - group[group.length - 1].line > 1) {
				flush();
			}
			group.push(line);
		}
		flush();
	}
	return { hits: hits.slice(0, limit), total: hits.length, terms: words };
}

/** A plain outline of the folder while its index is being built: its top folders and how many files each holds. */
export async function fallbackRepoMap(root: string, maxChars = 4_000): Promise<string> {
	const files = await listFiles(root).catch(() => [] as string[]);
	const folders = new Map<string, number>();
	const top: string[] = [];
	for (const file of files) {
		const slash = file.indexOf('/');
		if (slash < 0) {
			top.push(file);
		} else {
			const folder = file.slice(0, slash);
			folders.set(folder, (folders.get(folder) ?? 0) + 1);
		}
	}
	const lines = [`${files.length} files`, `./: ${top.slice(0, 20).join(', ')}${top.length > 20 ? ', …' : ''}`];
	for (const [folder, count] of [...folders].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
		lines.push(`${folder}/ (${count} files)`);
	}
	return lines.join('\n').slice(0, maxChars);
}
