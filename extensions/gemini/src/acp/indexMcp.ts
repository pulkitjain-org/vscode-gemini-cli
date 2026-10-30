/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The `geminicode-index` MCP server: an agent's way into its folder's index
// and the documentation attached to it, on localMcpServer.ts like
// GeminiCode's other servers. Each agent has its own route and token, bound
// to the one folder it works in, so no agent can search another folder's
// index. A spare session's slot is bound to its folder when it is made.

import { randomBytes } from 'node:crypto';
import type { McpTool, McpToolResult } from './browserMcp';
import type { DocsSearchResult } from './docs/docsProtocol';
import { baseName, diagnosticFiles, type EditorBackend, editorTools, editorToolsInstruction, formatCalls, formatDiagnostics, formatExactReferences, formatHover, noLanguageServer, resolveTarget } from './editorTools';
import { formatDocs, formatRelated, formatSearch, formatSymbol } from './index/format';
import type { Answer } from './index/indexerProtocol';
import type { RelatedResult, SearchQuery, SearchResult, SymbolResult } from './index/query';
import { LocalMcpServer, McpHttpConfig } from './localMcpServer';

export const indexServerName = 'geminicode-index';

export interface AttachedDocs {
	readonly id: string;
	readonly title: string;
	readonly url: string;
}

/** What the server asks of the extension host, for one folder. */
export interface IndexToolBackend {
	search(folder: string, query: SearchQuery): Promise<Answer<SearchResult>>;
	findSymbol(folder: string, name: string, kind: string | undefined, references: boolean): Promise<Answer<SymbolResult>>;
	related(folder: string, file: string): Promise<Answer<RelatedResult & { readonly known: boolean; readonly suggestions: readonly string[] }>>;
	repoMap(folder: string, path: string | undefined, depth: number | undefined): Promise<Answer<string>>;
	docs(folder: string): readonly AttachedDocs[];
	searchDocs(folder: string, ids: readonly string[], query: string): Promise<DocsSearchResult>;
	/** The outline sent with the server's instructions, when one is ready. */
	orientation(folder: string): string | undefined;
	/** A tool was called, for the agent's folder: keeps its index warm. */
	used?(folder: string): void;
	/** Whether the editor's language servers back the tools (`gemini.index.languageServers`). */
	languageServers?(): boolean;
	/** The language servers' reads, loaded on first use (editorTools.ts). */
	editor?(): Promise<EditorBackend | undefined>;
	/** Whether agents can start research (research.ts) from a tool. */
	researchOn?(): boolean;
	/** Researches `question` in `folder` with read-only workers; resolves with the report. */
	research?(folder: string, question: string): Promise<string>;
}

/** What research's workers are called: they get the index tools, but never research itself. */
export const researchWorkerPrefix = 'research-';

/** The one line a session's first prompt carries once the folder's index is built: without it the model reaches for grep_search first (FINDINGS.md). */
export function indexHint(options: { readonly languageServers?: boolean; readonly research?: boolean } = {}): string {
	return [
		'This workspace has a code index: use the geminicode-index tools (code_search, find_symbol, related_files, repo_map) before grep_search, glob or reading whole files. Their results are complete: read only the lines they point to, and don\'t search again for what they found.',
		...options.languageServers ? ['Before renaming or changing a signature, list its uses with find_symbol and references. After editing code, check it with code_diagnostics before you finish, instead of running a build.'] : [],
		...options.research ? ['For a broad question that needs reading many parts of the code (where something happens everywhere, an audit of every place that does X), call research instead of reading them one by one.'] : [],
	].join(' ');
}

interface Caller {
	readonly folder: string | undefined;
	/** The route: the agent's id, or a spare session's slot. */
	readonly route: string;
}

/** Slots kept for spare sessions no agent took. */
const maxUnboundSlots = 8;
const maxOrientationChars = 4_000;

export class IndexMcpServer {

	private readonly server: LocalMcpServer<Caller>;
	/** Each agent's folder. */
	private readonly folders = new Map<string, string>();
	/** Spare sessions' slots, to their folder and, once taken, their agent. */
	private readonly slots = new Map<string, { readonly folder: string; agent: string | undefined }>();

	constructor(private readonly backend: IndexToolBackend, version: string) {
		this.server = new LocalMcpServer<Caller>({
			name: indexServerName,
			version,
			callerOf: route => {
				if (route.includes('/')) {
					return undefined;
				}
				if (route.startsWith('slot-')) {
					const slot = this.slots.get(route);
					return slot ? { folder: slot.agent ? this.folders.get(slot.agent) ?? slot.folder : slot.folder, route } : undefined;
				}
				const folder = this.folders.get(route);
				return folder ? { folder, route } : undefined;
			},
			instructions: caller => this.instructions(caller.folder),
			tools: caller => this.tools(caller.folder, caller.route),
			call: (caller, name, args) => this.call(caller.folder, name, args),
		});
	}

	start(): Promise<number> {
		return this.server.start();
	}

	get listening(): boolean {
		return this.server.listening;
	}

	/** The `mcpServers` entry for `agent`, which works in `folder`; undefined until started. */
	configFor(agent: string, folder: string): McpHttpConfig | undefined {
		if (agent.startsWith('slot-')) {
			return undefined;
		}
		this.folders.set(agent, folder);
		return this.server.configFor(agent);
	}

	/** The entry for a spare session in `folder`, until `bind` gives it to the agent that takes it. */
	configForSlot(folder: string): McpHttpConfig | undefined {
		if (!this.server.listening) {
			return undefined;
		}
		const unbound = [...this.slots].filter(([, slot]) => slot.agent === undefined).map(([id]) => id);
		for (const id of unbound.slice(0, Math.max(0, unbound.length - maxUnboundSlots + 1))) {
			this.slots.delete(id);
		}
		const id = `slot-${randomBytes(12).toString('hex')}`;
		this.slots.set(id, { folder, agent: undefined });
		return this.server.configFor(id);
	}

	/** Gives the session opened with a slot (its server's `url`) to `agent`, working in `folder`. */
	bind(url: string, agent: string, folder: string): void {
		this.folders.set(agent, folder);
		const id = /\/mcp\/([\w-]+)$/.exec(url)?.[1];
		const slot = id ? this.slots.get(id) : undefined;
		if (slot) {
			slot.agent = agent;
		}
	}

	/** Forgets a removed agent: its route and slots answer 404 from now on. */
	forget(agent: string): void {
		this.folders.delete(agent);
		for (const [id, slot] of this.slots) {
			if (slot.agent === agent) {
				this.slots.delete(id);
			}
		}
	}

	dispose(): void {
		this.server.dispose();
	}

	private instructions(folder: string | undefined): string {
		const lines = [
			'An index of this folder\'s code, kept up to date as files change. Prefer these tools to grep_search, glob and reading whole files when looking for where something is defined, used or handled:',
			'- code_search: ranked code chunks for words, names or a description.',
			'- find_symbol: where a function, class or type is defined, and where it is used.',
			'- related_files: a file\'s imports, importers, tests and the files usually changed with it.',
			'- repo_map: an outline of the folder or a subfolder.',
			...this.backend.languageServers?.() ? [editorToolsInstruction] : [],
			...this.backend.researchOn?.() ? ['- research: a broad question answered by several read-only readers at once, with file:line evidence; for questions that need many parts of the code read.'] : [],
			'Results give paths with line ranges and are complete for the folder: read only those lines with read_file, and don\'t repeat the search with grep_search.',
		];
		const docs = folder ? this.backend.docs(folder) : [];
		if (docs.length) {
			lines.push(`- docs_search: the documentation the user attached (${docs.map(d => d.title).join(', ')}). Use it before web_fetch or google_web_search for these libraries.`);
		}
		const orientation = folder ? this.backend.orientation(folder) : undefined;
		if (orientation) {
			lines.push('', 'Outline of this folder:', orientation.slice(0, maxOrientationChars));
		}
		return lines.join('\n');
	}

	private tools(folder: string | undefined, route = ''): McpTool[] {
		const tools: McpTool[] = [
			{
				name: 'code_search',
				description: 'Searches this folder\'s code index and returns the best-matching chunks (whole functions or classes where possible) with paths, line ranges and snippets. Takes plain words, identifiers in any case (applyDiscount, apply_discount) or a short description. Faster and more precise than grep_search for finding where something is handled.',
				inputSchema: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Words, names or a short description of the code to find.' },
						path: { type: 'string', description: 'Only paths matching this, in .gitignore syntax: a folder such as src/cart, or a pattern such as *.test.ts.' },
						lang: { type: 'string', description: 'Only this language, such as typescript, python, go, java or markdown.' },
						limit: { type: 'number', description: 'How many results, 1 to 20 (default 8).' },
					},
					required: ['query'],
				},
			},
			{
				name: 'find_symbol',
				description: 'Finds where a function, method, class, interface or type is defined, with its signature line, and optionally every line that refers to it. Use Container.name for a method, such as CartService.checkout.',
				inputSchema: {
					type: 'object',
					properties: {
						name: { type: 'string', description: 'The symbol\'s name.' },
						kind: { type: 'string', description: 'Only this kind: function, method, class, interface, type, enum, struct, trait, constant or module.' },
						references: { type: 'boolean', description: 'Also list the lines that use it (default false).' },
					},
					required: ['name'],
				},
			},
			{
				name: 'related_files',
				description: 'Lists the files a file imports, the files that import it, its tests, and the files most often changed in the same commits: what a change to it is likely to touch.',
				inputSchema: {
					type: 'object',
					properties: { path: { type: 'string', description: 'The file, relative to this folder.' } },
					required: ['path'],
				},
			},
			{
				name: 'repo_map',
				description: 'An outline of this folder, or one subfolder: the project\'s description, languages, folders with their size, and the public definitions in each.',
				inputSchema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'A subfolder to outline instead of the whole folder.' },
						depth: { type: 'number', description: 'How many folder levels to list, 1 to 4 (default 2).' },
					},
				},
			},
		];
		if (this.backend.languageServers?.()) {
			tools.push(...editorTools);
		}
		if (this.backend.researchOn?.() && !route.startsWith(researchWorkerPrefix)) {
			tools.push({
				name: 'research',
				description: 'Answers a broad question about this folder\'s code by reading many parts of it at once: it splits the question by area, several read-only readers each read one part with these tools, and it returns one report with file:line evidence. Use it for questions such as where something happens everywhere, or an audit of every place that does X; it takes a minute or two. For one lookup, use code_search or find_symbol instead.',
				inputSchema: {
					type: 'object',
					properties: { question: { type: 'string', description: 'The question, in full, as the user would ask it.' } },
					required: ['question'],
				},
			});
		}
		const docs = folder ? this.backend.docs(folder) : [];
		if (docs.length) {
			tools.push({
				name: 'docs_search',
				description: `Searches the documentation the user attached to this folder: ${docs.map(d => `${d.title} (${d.url})`).join('; ')}. Returns matching sections with their page links.`,
				inputSchema: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'What to look up.' },
						source: { type: 'string', description: `Only this source: ${docs.map(d => d.title).join(', ')}.` },
					},
					required: ['query'],
				},
			});
		}
		return tools;
	}

	private async call(folder: string | undefined, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
		if (!folder) {
			return text('The index is not ready for this session yet.', true);
		}
		this.backend.used?.(folder);
		const str = (key: string) => typeof args[key] === 'string' ? (args[key] as string).trim() : undefined;
		const num = (key: string) => typeof args[key] === 'number' && Number.isFinite(args[key]) ? args[key] as number : undefined;
		switch (name) {
			case 'code_search': {
				const query = str('query');
				if (!query) {
					return text('code_search needs a query.', true);
				}
				const answer = await this.backend.search(folder, { query, path: str('path') || undefined, lang: str('lang') || undefined, limit: num('limit') });
				return text(formatSearch(query, answer.result, answer.fallback, answer.partial));
			}
			case 'find_symbol': {
				const symbol = str('name');
				if (!symbol) {
					return text('find_symbol needs a name.', true);
				}
				const answer = await this.backend.findSymbol(folder, symbol, str('kind') || undefined, args.references === true);
				if (args.references !== true || !this.backend.languageServers?.() || answer.result.definitions.length !== 1) {
					return text(formatSymbol(symbol, answer.result, answer.fallback, answer.partial));
				}
				// One definition: the language server's references are the exact ones, where it answers.
				const target = resolveTarget(folder, symbol, answer.result.definitions);
				const exact = typeof target === 'string' ? undefined : await (await this.backend.editor?.())?.references(target).catch(() => undefined);
				if (!exact) {
					return text(`${formatSymbol(symbol, answer.result, answer.fallback, answer.partial)}\n\n${noLanguageServer}`);
				}
				return text(`${formatSymbol(symbol, { ...answer.result, references: [], referenceTotal: 0 }, answer.fallback, answer.partial)}\n\n${formatExactReferences(folder, exact)}`);
			}
			case 'code_type':
			case 'code_calls': {
				const symbol = str('symbol');
				if (!symbol) {
					return text(`${name} needs a symbol.`, true);
				}
				const file = str('path') || undefined;
				const line = num('line');
				const definitions = file && line ? [] : (await this.backend.findSymbol(folder, baseName(symbol), undefined, false)).result.definitions;
				const target = resolveTarget(folder, symbol, definitions, file, line);
				if (typeof target === 'string') {
					return text(target, true);
				}
				const editor = await this.backend.editor?.();
				if (name === 'code_type') {
					const hover = editor ? await editor.hover(target).catch(() => undefined) : undefined;
					return text(hover === undefined ? `${noLanguageServer} Read the definition with find_symbol instead.` : formatHover(target, folder, hover));
				}
				const direction = str('direction') === 'outgoing' ? 'outgoing' : 'incoming';
				const calls = editor ? await editor.calls(target, direction).catch(() => undefined) : undefined;
				return text(calls === undefined ? `${noLanguageServer} For callers, use find_symbol with references.` : formatCalls(target, folder, direction, calls));
			}
			case 'research': {
				const question = str('question');
				if (!question) {
					return text('research needs a question.', true);
				}
				if (!this.backend.research || !this.backend.researchOn?.()) {
					return text('Research is off for this session.', true);
				}
				return text(await this.backend.research(folder, question));
			}
			case 'code_diagnostics': {
				const editor = await this.backend.editor?.();
				if (!editor) {
					return text('The editor\'s language servers are not available to agents in this window.', true);
				}
				const { checked, diagnostics } = await editor.diagnostics(folder, diagnosticFiles(folder, args.paths));
				return text(formatDiagnostics(folder, checked, diagnostics));
			}
			case 'related_files': {
				const file = str('path');
				if (!file) {
					return text('related_files needs a path.', true);
				}
				const answer = await this.backend.related(folder, file);
				return text(formatRelated(file, answer.result, answer.fallback));
			}
			case 'repo_map': {
				const answer = await this.backend.repoMap(folder, str('path') || undefined, num('depth'));
				return text(answer.fallback ? `${answer.result}\n\nThe index for this folder is still being built; this is a plain list of folders.` : answer.result);
			}
			case 'docs_search': {
				const query = str('query');
				if (!query) {
					return text('docs_search needs a query.', true);
				}
				const docs = this.backend.docs(folder);
				const source = str('source')?.toLowerCase();
				const chosen = source ? docs.filter(d => d.title.toLowerCase().includes(source) || d.url.toLowerCase().includes(source)) : docs;
				if (!chosen.length) {
					return text(docs.length ? `No attached documentation is called ${str('source')}. Attached: ${docs.map(d => d.title).join(', ')}.` : 'No documentation is attached to this folder.', true);
				}
				const result = await this.backend.searchDocs(folder, chosen.map(d => d.id), query);
				return text(formatDocs(query, result, new Map(docs.map(d => [d.id, d.title]))));
			}
			default:
				return text(`Unknown tool: ${name}`, true);
		}
	}
}

function text(value: string, isError = false): McpToolResult {
	return { content: [{ type: 'text', text: value }], ...isError ? { isError } : {} };
}
