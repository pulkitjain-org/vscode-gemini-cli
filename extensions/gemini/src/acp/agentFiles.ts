/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The logic of an agent's Files page (src/host/agentFilesPage.ts): the order
// of a folder's entries, each file's icon, and the page's recent files.

/** One entry of a folder in the Files page's tree. */
export interface TreeEntry {
	readonly name: string;
	/** Absolute. */
	readonly path: string;
	readonly folder: boolean;
	/** Ignored by git (node_modules, build output, .env): shown dimmed. */
	readonly ignored: boolean;
}

/** How many recent files the page keeps per agent. */
export const maxRecents = 12;

/** Folders first, then files, each by name as the Explorer sorts them: case-insensitive, numbers in order. */
export function sortEntries(entries: readonly TreeEntry[]): TreeEntry[] {
	const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
	return [...entries].sort((a, b) => Number(b.folder) - Number(a.folder) || collator.compare(a.name, b.name));
}

/** `recents` with `filePath` first, without repeats, at most `maxRecents`. */
export function withRecent(recents: readonly string[], filePath: string): string[] {
	return [filePath, ...recents.filter(each => each !== filePath)].slice(0, maxRecents);
}

const codeExtensions = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'cs', 'c', 'h', 'cpp', 'hpp', 'swift', 'scala', 'sh', 'vue', 'svelte', 'html', 'css', 'scss', 'less', 'sql']);
const configExtensions = new Set(['toml', 'yml', 'yaml', 'ini', 'conf', 'cfg', 'properties', 'lock', 'env']);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']);

/** The codicon for a file named `name`. */
export function fileIcon(name: string): string {
	const lower = name.toLowerCase();
	const dot = lower.lastIndexOf('.');
	const extension = dot > 0 ? lower.slice(dot + 1) : '';
	if (extension === 'md' || extension === 'mdx') {
		return 'markdown';
	}
	if (extension === 'json' || extension === 'jsonc') {
		return 'json';
	}
	if (imageExtensions.has(extension)) {
		return 'file-media';
	}
	if (extension === 'pdf') {
		return 'file-pdf';
	}
	if (extension === 'zip' || extension === 'gz' || extension === 'tgz') {
		return 'file-zip';
	}
	if (codeExtensions.has(extension)) {
		return 'file-code';
	}
	// Dotfiles (.env, .gitignore, .nvmrc) and settings files.
	if (configExtensions.has(extension) || dot === 0 || /rc$/.test(lower) || lower === 'dockerfile' || lower.startsWith('dockerfile')) {
		return 'gear';
	}
	return 'file';
}
