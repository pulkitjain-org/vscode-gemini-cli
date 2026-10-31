/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The extension host's bundles of features loaded on first use (src/pages.ts
// and src/onDemand.ts, see src/host/lazyFeature.ts). Each is built on its own,
// so it has its own copy of every module it imports, and a copy of a module's
// state is not the extension bundle's: a trace recording started there, or a
// CLI folder read there, would go nowhere. These checks build the bundles as
// esbuild.mts does and fail when a chunk carries state of its own, when the
// extension bundle still carries a feature that moved out, or when a chunk
// takes a library along.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');

/** The modules each chunk exists to keep out of the extension bundle. */
const moved: Readonly<Record<string, readonly string[]>> = {
	'src/pages.ts': ['src/host/indexPage.ts', 'src/host/settingsPage.ts', 'src/host/connectionsPage.ts', 'src/host/siteConnections.ts', 'src/host/planReviewPage.ts', 'src/acp/planReview.ts', 'src/acp/planReviewStore.ts', 'src/host/teamFlowPanel.ts', 'src/host/agentFilesPage.ts', 'src/acp/agentFiles.ts'],
	'src/confluence.ts': ['src/host/confluenceFeature.ts', 'src/host/confluenceReviewPage.ts', 'src/acp/confluence.ts', 'src/acp/confluenceDrafts.ts', 'src/acp/blockMerge.ts', 'src/acp/draftReview.ts'],
	'src/connection.ts': ['src/acp/agentConnection.ts'],
	'src/debug.ts': ['src/host/debug/debugFeature.ts', 'src/host/debug/debugMode.ts', 'src/host/debug/debugBridge.ts', 'src/host/debug/debugEditor.ts', 'src/host/debug/evidencePage.ts', 'src/host/debug/debugStrings.ts', 'src/acp/debug/debugBridgeLogic.ts', 'src/acp/debug/debugMcp.ts', 'src/acp/debug/debugState.ts', 'src/acp/debug/evidenceStore.ts', 'src/acp/debug/ingest.ts', 'src/acp/debug/logTail.ts', 'src/acp/debug/debugRecord.ts', 'src/acp/debug/templates.ts', 'src/acp/debug/regions.ts'],
	'src/onDemand.ts': ['src/host/auditPage.ts', 'src/host/benchmarkCommand.ts', 'src/host/designSystemSync.ts', 'src/host/editorToolsHost.ts', 'src/host/traceRecorder.ts', 'src/host/reviewClone.ts', 'src/acp/cloneSearch.ts', 'src/host/agents/agentMerge.ts', 'src/host/agents/agentTries.ts', 'src/acp/worktreeApply.ts', 'src/acp/tryState.ts', 'src/host/chat/projectStrings.ts', 'src/host/assigneePicker.ts', 'src/host/checkAgent.ts', 'src/acp/cli/contract.ts', 'src/acp/sessionReplay.ts'],
};

interface Built {
	/** The bundle's source modules, relative to the extension's folder. */
	readonly inputs: readonly string[];
	/** The bundle unminified, so its declarations keep their names. */
	readonly text: string;
}

async function build(entry: string): Promise<Built> {
	const result = await esbuild.build({
		entryPoints: [path.join(root, entry)],
		bundle: true,
		minify: false,
		treeShaking: true,
		platform: 'node',
		format: 'cjs',
		target: ['es2024'],
		external: ['vscode'],
		mainFields: ['module', 'main'],
		write: false,
		metafile: true,
		outdir: path.join(root, 'dist'),
		logLevel: 'silent',
	});
	return {
		inputs: Object.keys(result.metafile.inputs).map(file => path.relative(root, path.resolve(process.cwd(), file)).split(path.sep).join('/')),
		text: result.outputFiles.find(file => file.path.endsWith('.js'))!.text,
	};
}

/**
 * The names of a module's top-level state: `let` and `var` declarations, and
 * constants holding an object, array or collection that is changed later.
 */
function stateOf(source: string): string[] {
	const names: string[] = [];
	for (const match of source.matchAll(/^(?:export\s+)?(?:let|var)\s+(?<name>[A-Za-z_$][\w$]*)/gm)) {
		names.push(match.groups!.name);
	}
	for (const match of source.matchAll(/^(?:export\s+)?const\s+(?<name>[A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:\{\s*\}|\[\s*\]|new\s+(?:Map|Set|WeakMap|WeakSet)\b)/gm)) {
		names.push(match.groups!.name);
	}
	return names;
}

describe('bundles loaded on first use', () => {
	const built = new Map<string, Built>();

	beforeAll(async () => {
		for (const entry of ['src/extension.ts', ...Object.keys(moved)]) {
			built.set(entry, await build(entry));
		}
	}, 60_000);

	it('keep their features out of the extension bundle', () => {
		const main = built.get('src/extension.ts')!.inputs;
		expect(Object.values(moved).flat().filter(file => main.includes(file))).toEqual([]);
		for (const [entry, files] of Object.entries(moved)) {
			expect(files.filter(file => !built.get(entry)!.inputs.includes(file))).toEqual([]);
		}
	});

	it('take no library along, except the connection bundle, which alone carries the ACP SDK and zod', () => {
		// jsonc-parser (about 17 KB, no state) edits the CLI's settings files, which the Project Helpers page writes too.
		const small = ['node_modules/jsonc-parser/'];
		const sdk = ['node_modules/@agentclientprotocol/', 'node_modules/zod/'];
		for (const entry of Object.keys(moved)) {
			const allowed = entry === 'src/connection.ts' ? [...small, ...sdk] : small;
			expect(built.get(entry)!.inputs.filter(file => file.includes('node_modules/') && !allowed.some(lib => file.includes(lib)))).toEqual([]);
		}
		// The extension bundle, which every window loads at once, has neither: the agent starts seconds later.
		expect(built.get('src/extension.ts')!.inputs.filter(file => sdk.some(lib => file.includes(lib)))).toEqual([]);
	});

	it('keep no copy of the extension bundle\'s module state: what they need of it comes through their constructors', () => {
		const main = new Set(built.get('src/extension.ts')!.inputs);
		const found: string[] = [];
		for (const entry of Object.keys(moved)) {
			const { inputs, text } = built.get(entry)!;
			// A module only the chunk has keeps its state there, as it would anywhere.
			for (const file of inputs.filter(input => input.startsWith('src/') && main.has(input))) {
				for (const name of stateOf(readFileSync(path.join(root, file), 'utf8'))) {
					// esbuild renames a declaration that clashes with another by adding a number.
					if (new RegExp(`\\b(?:let|var|const)\\s+${name.replace(/\$/g, '\\$')}\\d*\\b`).test(text)) {
						found.push(`${entry}: ${file} ${name}`);
					}
				}
			}
		}
		expect(found).toEqual([]);
	});

	it('register stand-ins for exactly the commands their features register', () => {
		const ids = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map(match => match.groups!.id).sort();
		const registered = Object.values(moved).flat().flatMap(file => ids(readFileSync(path.join(root, file), 'utf8'), /registerCommand\('(?<id>[\w.]+)'/g));
		const lists = [...readFileSync(path.join(root, 'src/extension.ts'), 'utf8').matchAll(/new LazyFeature\(\[(?<ids>[^\]]*)\]/g)].map(match => match.groups!.ids).join(',');
		expect(ids(lists, /'(?<id>[\w.]+)'/g)).toEqual(registered.sort());
	});

	it('finds module state as the check above reads it', () => {
		expect(stateOf([
			'let sink: ((record: TraceRecord) => void) | undefined;',
			'export let shared = 1;',
			'export const productInfo: { -readonly [K in keyof Info]: Info[K] } = {};',
			'const parsedFiles = new Map<string, CachedFile>();',
			'const limit = 2000;',
			'\tlet local = 0;',
		].join('\n'))).toEqual(['sink', 'shared', 'productInfo', 'parsedFiles']);
	});
});
