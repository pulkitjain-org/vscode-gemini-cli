/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat's syntax highlighter, a bundle of its own (media/highlight.js) that
// the chat view loads the first time it shows a code block. highlight.js with
// the languages agents write most; the colours come from the theme
// (src/acp/tokenColors.ts).

import hljs from 'highlight.js/lib/core';
import lang_typescript from 'highlight.js/lib/languages/typescript';
import lang_javascript from 'highlight.js/lib/languages/javascript';
import lang_json from 'highlight.js/lib/languages/json';
import lang_python from 'highlight.js/lib/languages/python';
import lang_bash from 'highlight.js/lib/languages/bash';
import lang_shell from 'highlight.js/lib/languages/shell';
import lang_go from 'highlight.js/lib/languages/go';
import lang_rust from 'highlight.js/lib/languages/rust';
import lang_java from 'highlight.js/lib/languages/java';
import lang_kotlin from 'highlight.js/lib/languages/kotlin';
import lang_swift from 'highlight.js/lib/languages/swift';
import lang_css from 'highlight.js/lib/languages/css';
import lang_scss from 'highlight.js/lib/languages/scss';
import lang_less from 'highlight.js/lib/languages/less';
import lang_xml from 'highlight.js/lib/languages/xml';
import lang_yaml from 'highlight.js/lib/languages/yaml';
import lang_markdown from 'highlight.js/lib/languages/markdown';
import lang_sql from 'highlight.js/lib/languages/sql';
import lang_diff from 'highlight.js/lib/languages/diff';
import lang_c from 'highlight.js/lib/languages/c';
import lang_cpp from 'highlight.js/lib/languages/cpp';
import lang_csharp from 'highlight.js/lib/languages/csharp';
import lang_ruby from 'highlight.js/lib/languages/ruby';
import lang_php from 'highlight.js/lib/languages/php';
import lang_dockerfile from 'highlight.js/lib/languages/dockerfile';
import lang_ini from 'highlight.js/lib/languages/ini';
import lang_makefile from 'highlight.js/lib/languages/makefile';
import lang_graphql from 'highlight.js/lib/languages/graphql';
import lang_lua from 'highlight.js/lib/languages/lua';
import lang_dart from 'highlight.js/lib/languages/dart';
import lang_scala from 'highlight.js/lib/languages/scala';
import lang_r from 'highlight.js/lib/languages/r';
import lang_objectivec from 'highlight.js/lib/languages/objectivec';
import lang_plaintext from 'highlight.js/lib/languages/plaintext';

const languages = {
	typescript: lang_typescript,
	javascript: lang_javascript,
	json: lang_json,
	python: lang_python,
	bash: lang_bash,
	shell: lang_shell,
	go: lang_go,
	rust: lang_rust,
	java: lang_java,
	kotlin: lang_kotlin,
	swift: lang_swift,
	css: lang_css,
	scss: lang_scss,
	less: lang_less,
	xml: lang_xml,
	yaml: lang_yaml,
	markdown: lang_markdown,
	sql: lang_sql,
	diff: lang_diff,
	c: lang_c,
	cpp: lang_cpp,
	csharp: lang_csharp,
	ruby: lang_ruby,
	php: lang_php,
	dockerfile: lang_dockerfile,
	ini: lang_ini,
	makefile: lang_makefile,
	graphql: lang_graphql,
	lua: lang_lua,
	dart: lang_dart,
	scala: lang_scala,
	r: lang_r,
	objectivec: lang_objectivec,
	plaintext: lang_plaintext,
};

for (const [name, language] of Object.entries(languages)) {
	hljs.registerLanguage(name, language);
}
hljs.registerAliases(['tsx', 'mts', 'cts'], { languageName: 'typescript' });
hljs.registerAliases(['jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['jsonc', 'json5'], { languageName: 'json' });
hljs.registerAliases(['sh', 'zsh', 'fish'], { languageName: 'bash' });
hljs.registerAliases(['console', 'terminal'], { languageName: 'shell' });
hljs.registerAliases(['html', 'svg', 'vue'], { languageName: 'xml' });
hljs.registerAliases(['toml', 'env', 'properties'], { languageName: 'ini' });
hljs.registerAliases(['text', 'txt'], { languageName: 'plaintext' });

/** Code longer than this (in characters) isn't worth the time; the block shows as plain text. */
const maxLength = 20_000;

/**
 * `code` as highlighted HTML (highlight.js escapes the text), or undefined
 * for a language it doesn't know or code too long to bother.
 */
export function highlight(code: string, language: string): string | undefined {
	if (code.length > maxLength || !language || !hljs.getLanguage(language)) {
		return undefined;
	}
	return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}
