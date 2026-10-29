/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The languages the index reads definitions from. Each is a few line
// patterns, in the manner of ctags' regex parsers, rather than a grammar:
// the release build ships tree-sitter grammars for only six languages, and a
// line scan is far faster than a parse, which keeps indexing light. A
// language without patterns is still indexed, in windows of lines.

export type SymbolKind = 'class' | 'interface' | 'type' | 'enum' | 'function' | 'method' | 'constant' | 'module' | 'struct' | 'trait' | 'heading';

export interface Definition {
	readonly kind: SymbolKind;
	/** Matched against one line. Groups: `name`, and optionally `indent`, `export`, `mods` and `recv` (a Go receiver). */
	readonly pattern: RegExp;
	/** Holds members (a class's methods), found by indentation. */
	readonly container?: boolean;
	/** Only a container: it groups members but is not listed itself (a Rust `impl`). */
	readonly hidden?: boolean;
	/** Only matches as a member of a container, such as a method. */
	readonly member?: boolean;
}

export interface Language {
	readonly id: string;
	readonly definitions: readonly Definition[];
	/** Import specifiers, in group `spec`. */
	readonly imports?: readonly RegExp[];
	/** A line that belongs to the definition below it: a comment or a decorator. */
	readonly leading?: RegExp;
	/** Whether a definition is public, from its match; the default is any top-level one. */
	readonly exported?: (groups: Readonly<Record<string, string | undefined>>, name: string) => boolean;
	/** `#` headings, skipping fenced code. */
	readonly markdown?: boolean;
}

const ident = '[A-Za-z_$][\\w$]*';
/** Words a member pattern can match that are statements, not names. */
export const notNames: ReadonlySet<string> = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'return', 'function', 'super', 'new', 'typeof', 'await', 'throw', 'else', 'do', 'try', 'with', 'yield', 'delete', 'void', 'using', 'lock', 'when', 'match', 'elif', 'sizeof']);

const typescript: Language = {
	id: 'typescript',
	definitions: [
		{ kind: 'class', container: true, pattern: new RegExp(`^(?<indent>\\s*)(?<export>export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(?<name>${ident})`) },
		{ kind: 'interface', pattern: new RegExp(`^(?<indent>\\s*)(?<export>export\\s+)?(?:declare\\s+)?interface\\s+(?<name>${ident})`) },
		{ kind: 'type', pattern: new RegExp(`^(?<indent>\\s*)(?<export>export\\s+)?(?:declare\\s+)?type\\s+(?<name>${ident})\\s*(?:<[^=]*>)?\\s*=`) },
		{ kind: 'enum', pattern: new RegExp(`^(?<indent>\\s*)(?<export>export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(?<name>${ident})`) },
		{ kind: 'module', container: true, pattern: new RegExp(`^(?<indent>\\s*)(?<export>export\\s+)?(?:declare\\s+)?(?:namespace|module)\\s+(?<name>${ident}(?:\\.${ident})*)\\s*\\{`) },
		{ kind: 'function', pattern: new RegExp(`^(?<indent>\\s*)(?<export>export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(?<name>${ident})`) },
		{ kind: 'function', pattern: new RegExp(`^(?<indent>\\s*)(?<export>export\\s+)?(?:const|let|var)\\s+(?<name>${ident})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|(?:<[^>]*>)?\\([^)]*\\)?\\s*(?::\\s*[^=]+)?=>|${ident}\\s*=>|\\($)`) },
		{ kind: 'constant', pattern: new RegExp(`^(?<indent>)(?<export>export\\s+)(?:const|let|var)\\s+(?<name>${ident})`) },
		{ kind: 'method', member: true, pattern: new RegExp(`^(?<indent>\\s+)(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|accessor|get|set)\\s+)*(?<name>#?${ident})\\s*\\??\\s*(?:<[^>]*>)?\\s*\\(`) },
	],
	imports: [
		/(?:^|[\s;])(?:import|export)\s[^'"]*?\bfrom\s*['"](?<spec>[^'"]+)['"]/g,
		/(?:^|[\s;])import\s*['"](?<spec>[^'"]+)['"]/g,
		/\b(?:require|import)\(\s*['"](?<spec>[^'"]+)['"]\s*\)/g,
	],
	leading: /^\s*(?:\/\/|\/\*|\*|@\w)/,
	exported: groups => !!groups.export,
};

const python: Language = {
	id: 'python',
	definitions: [
		{ kind: 'class', container: true, pattern: /^(?<indent>\s*)class\s+(?<name>\w+)/ },
		{ kind: 'function', pattern: /^(?<indent>\s*)(?:async\s+)?def\s+(?<name>\w+)/ },
		{ kind: 'constant', pattern: /^(?<indent>)(?<name>[A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=(?!=)/ },
	],
	imports: [/^\s*from\s+(?<spec>[.\w]+)\s+import\b/gm, /^\s*import\s+(?<spec>[\w.]+)/gm],
	leading: /^\s*(?:#|@)/,
	exported: (_, name) => !name.startsWith('_'),
};

const go: Language = {
	id: 'go',
	definitions: [
		{ kind: 'method', pattern: /^(?<indent>)func\s+\((?<recv>[^)]*)\)\s*(?<name>\w+)/ },
		{ kind: 'function', pattern: /^(?<indent>)func\s+(?<name>\w+)/ },
		{ kind: 'struct', pattern: /^(?<indent>)type\s+(?<name>\w+)(?:\[[^\]]*\])?\s+struct\b/ },
		{ kind: 'interface', pattern: /^(?<indent>)type\s+(?<name>\w+)(?:\[[^\]]*\])?\s+interface\b/ },
		{ kind: 'type', pattern: /^(?<indent>)type\s+(?<name>\w+)/ },
		{ kind: 'constant', pattern: /^(?<indent>)(?:const|var)\s+(?<name>[A-Z]\w*)\b/ },
	],
	leading: /^\s*\/\//,
	exported: (_, name) => /^[A-Z]/.test(name),
};

const rustVisibility = '(?<export>pub(?:\\([^)]*\\))?\\s+)?';
const rust: Language = {
	id: 'rust',
	definitions: [
		{ kind: 'module', container: true, hidden: true, pattern: /^(?<indent>\s*)impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?(?<name>\w+)/ },
		{ kind: 'trait', container: true, pattern: new RegExp(`^(?<indent>\\s*)${rustVisibility}(?:unsafe\\s+)?trait\\s+(?<name>\\w+)`) },
		{ kind: 'function', pattern: new RegExp(`^(?<indent>\\s*)${rustVisibility}(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+(?<name>\\w+)`) },
		{ kind: 'struct', pattern: new RegExp(`^(?<indent>\\s*)${rustVisibility}(?:struct|union)\\s+(?<name>\\w+)`) },
		{ kind: 'enum', pattern: new RegExp(`^(?<indent>\\s*)${rustVisibility}enum\\s+(?<name>\\w+)`) },
		{ kind: 'type', pattern: new RegExp(`^(?<indent>\\s*)${rustVisibility}type\\s+(?<name>\\w+)`) },
		{ kind: 'module', pattern: new RegExp(`^(?<indent>\\s*)${rustVisibility}mod\\s+(?<name>\\w+)\\s*\\{`) },
		{ kind: 'constant', pattern: new RegExp(`^(?<indent>)${rustVisibility}(?:const|static)\\s+(?:mut\\s+)?(?<name>[A-Z][A-Z0-9_]*)\\s*:`) },
	],
	imports: [/^\s*(?:pub\s+)?mod\s+(?<spec>\w+)\s*;/gm],
	leading: /^\s*(?:\/\/|#\[)/,
	exported: groups => !!groups.export,
};

const jvmTypeMods = '(?<mods>(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|data|open|inner|annotation|value|readonly|unsafe|new|fileprivate)\\s+)*)';
const jvmMethodMods = '(?<mods>(?:(?:public|private|protected|internal|static|final|abstract|synchronized|override|virtual|async|native|default|sealed|new|extern|unsafe|open|suspend|inline|operator|mutating|fileprivate|class)\\s+)*)';
const jvmTypes: readonly Definition[] = [
	{ kind: 'class', container: true, pattern: new RegExp(`^(?<indent>\\s*)(?:@\\w+(?:\\([^)]*\\))?\\s+)*${jvmTypeMods}(?:class|record|object|extension)\\s+(?<name>\\w+)`) },
	{ kind: 'interface', container: true, pattern: new RegExp(`^(?<indent>\\s*)${jvmTypeMods}(?:interface|protocol|trait)\\s+(?<name>\\w+)`) },
	{ kind: 'enum', container: true, pattern: new RegExp(`^(?<indent>\\s*)${jvmTypeMods}enum(?:\\s+class)?\\s+(?<name>\\w+)`) },
	{ kind: 'struct', container: true, pattern: new RegExp(`^(?<indent>\\s*)${jvmTypeMods}struct\\s+(?<name>\\w+)`) },
];
const isPublic = (groups: Readonly<Record<string, string | undefined>>) => /\bpublic\b/.test(groups.mods ?? '');
const notPrivate = (groups: Readonly<Record<string, string | undefined>>) => !/\b(?:private|fileprivate)\b/.test(groups.mods ?? '');

const java: Language = {
	id: 'java',
	definitions: [
		...jvmTypes,
		{ kind: 'method', member: true, pattern: new RegExp(`^(?<indent>\\s+)(?:@\\w+(?:\\([^)]*\\))?\\s+)*${jvmMethodMods}(?:<[^>]+>\\s+)?[\\w<>\\[\\],.?]+(?:\\s*<[^>]*>)?\\s+(?<name>\\w+)\\s*\\(`) },
	],
	imports: [/^\s*import\s+(?:static\s+)?(?<spec>[\w.]+?)(?:\.\*)?\s*;/gm],
	leading: /^\s*(?:\/\/|\/\*|\*|@\w)/,
	exported: isPublic,
};

const csharp: Language = { ...java, id: 'csharp', imports: undefined };

const kotlin: Language = {
	id: 'kotlin',
	definitions: [
		...jvmTypes,
		{ kind: 'function', pattern: new RegExp(`^(?<indent>\\s*)(?:@\\w+(?:\\([^)]*\\))?\\s+)*${jvmMethodMods}(?:fun|func|def)\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?(?<name>\\w+)`) },
	],
	imports: java.imports,
	leading: java.leading,
	exported: notPrivate,
};

const ruby: Language = {
	id: 'ruby',
	definitions: [
		{ kind: 'class', container: true, pattern: /^(?<indent>\s*)(?:class|module)\s+(?<name>[A-Z][\w:]*)/ },
		{ kind: 'function', pattern: /^(?<indent>\s*)def\s+(?:self\.)?(?<name>[\w?!=]+)/ },
	],
	imports: [/\brequire_relative\s+['"](?<spec>[^'"]+)['"]/g],
	leading: /^\s*#/,
};

const php: Language = {
	id: 'php',
	definitions: [
		{ kind: 'class', container: true, pattern: /^(?<indent>\s*)(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+(?<name>\w+)/ },
		{ kind: 'function', pattern: /^(?<indent>\s*)(?<mods>(?:(?:public|private|protected|static|abstract|final)\s+)*)function\s+(?<name>\w+)/ },
	],
	leading: /^\s*(?:\/\/|\/\*|\*|#)/,
	exported: notPrivate,
};

const c: Language = {
	id: 'c',
	definitions: [
		{ kind: 'class', container: true, pattern: /^(?<indent>\s*)(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(?:\w+\s+)?(?<name>\w+)\s*(?::[^{;]*)?\{?\s*$/ },
		{ kind: 'module', pattern: /^(?<indent>)namespace\s+(?<name>[\w:]+)/ },
		{ kind: 'function', pattern: /^(?<indent>)(?!(?:if|for|while|switch|return|else|typedef|struct|class|enum)\b)[\w:*&<>,]+(?:\s+[\w:*&<>,]+)*\s+[*&]*(?<name>[\w:~]+)\s*\([^;]*$/ },
	],
	imports: [/^\s*#\s*include\s+"(?<spec>[^"]+)"/gm],
	leading: /^\s*(?:\/\/|\/\*|\*)/,
};

const shell: Language = {
	id: 'shell',
	definitions: [{ kind: 'function', pattern: /^(?<indent>)(?:function\s+)?(?<name>[\w-]+)\s*\(\)\s*\{?/ }],
	leading: /^\s*#/,
};

const markdown: Language = {
	id: 'markdown',
	definitions: [{ kind: 'heading', pattern: /^(?<indent>)#{1,6}\s+(?<name>\S.*?)\s*#*\s*$/ }],
	markdown: true,
};

/** Languages by file extension; files with other extensions are indexed by lines. */
const byExtension: Readonly<Record<string, Language>> = {
	ts: typescript, tsx: typescript, mts: typescript, cts: typescript, js: typescript, jsx: typescript, mjs: typescript, cjs: typescript, vue: typescript, svelte: typescript,
	py: python, pyi: python,
	go,
	rs: rust,
	java, scala: kotlin, kt: kotlin, kts: kotlin, swift: kotlin, groovy: java,
	cs: csharp,
	rb: ruby,
	php,
	c, h: c, cc: c, cpp: c, cxx: c, hpp: c, hh: c, m: c, mm: c,
	sh: shell, bash: shell, zsh: shell,
	md: markdown, mdx: markdown, markdown,
};

/** Plain-text languages: indexed by lines, named for the `lang` filter. */
const plainByExtension: Readonly<Record<string, string>> = {
	json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', html: 'html', htm: 'html', css: 'css', scss: 'css', less: 'css',
	sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'proto', tf: 'terraform', gradle: 'gradle', txt: 'text', rst: 'text', ini: 'ini', properties: 'ini',
	dockerfile: 'dockerfile', lua: 'lua', dart: 'dart', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', ml: 'ocaml', clj: 'clojure', r: 'r', pl: 'perl', ps1: 'powershell',
};

/** The language of `relative`, or undefined for one indexed by lines only. */
export function languageOf(relative: string): Language | undefined {
	return byExtension[extensionOf(relative)];
}

/** The language name for the `lang` filter and the repo map: a known language's id, a plain-text format, or the extension. */
export function languageName(relative: string): string {
	const extension = extensionOf(relative);
	return byExtension[extension]?.id ?? plainByExtension[extension] ?? (extension || 'text');
}

function extensionOf(relative: string): string {
	const base = relative.slice(relative.lastIndexOf('/') + 1).toLowerCase();
	if (base === 'dockerfile' || base.startsWith('dockerfile.')) {
		return 'dockerfile';
	}
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(dot + 1) : '';
}
