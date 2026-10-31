/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The marked lines GeminiCode writes into a program for `debug_instrument`
// (DEBUG_MODE.md, Marked lines): one template per language and channel, a
// region of three or four lines between GEMINI-DEBUG-START and
// GEMINI-DEBUG-END markers. The statement never throws, never awaits and
// returns at once; each JavaScript expression is evaluated in its own try.
// The model gives only expressions; the text here is GeminiCode's.

import { type Channel, marker } from './points';

export type TemplateLanguage = 'javascript' | 'typescript' | 'python';

export const markerStart = 'GEMINI-DEBUG-START';
export const markerEnd = 'GEMINI-DEBUG-END';

/** Values are cut in the program, so a huge string never fills a line or a request. */
export const maxValueCharsInProgram = 4000;

/** The template language of a file; `scriptLang` is the `lang` of a Vue or Svelte file's script block. */
export function templateLanguageOf(file: string, scriptLang?: string): TemplateLanguage | undefined {
	const ext = /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase();
	switch (ext) {
		case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript';
		case 'ts': case 'tsx': case 'mts': case 'cts': return 'typescript';
		case 'py': case 'pyw': return 'python';
		case 'vue': case 'svelte': return scriptLang === 'ts' || scriptLang === 'typescript' ? 'typescript' : 'javascript';
		default: return undefined;
	}
}

export interface Endpoint {
	/** The address the program reaches GeminiCode at: `127.0.0.1` by default, `host.docker.internal` from a container. */
	readonly host: string;
	readonly port: number;
	readonly token: string;
}

export interface TemplateInput {
	readonly language: TemplateLanguage;
	readonly channel: Channel;
	readonly nonce: string;
	readonly point: string;
	readonly expressions: readonly string[];
	/** The indentation of the line the region goes before, copied onto every line. */
	readonly indent?: string;
	/** For the http channel. */
	readonly endpoint?: Endpoint;
}

/** The region's lines, in order, each with `indent` in front. */
export function markedRegion(input: TemplateInput): string[] {
	if (input.channel === 'http' && !input.endpoint) {
		throw new Error('The http channel needs the endpoint.');
	}
	const comment = input.language === 'python' ? '#' : '//';
	const lines = [
		`${comment} ${markerStart} ${input.nonce} ${input.point}`,
		...input.language === 'typescript' ? ['// @ts-ignore'] : [],
		...statement(input),
		`${comment} ${markerEnd} ${input.nonce} ${input.point}`,
	];
	const indent = input.indent ?? '';
	return lines.map(line => `${indent}${line}`);
}

/** The region as one string, the way it is inserted before a line. */
export function markedRegionText(input: TemplateInput, eol = '\n'): string {
	return markedRegion(input).map(line => `${line}${eol}`).join('');
}

function endpointUrl(endpoint: Endpoint): string {
	return `http://${endpoint.host}:${endpoint.port}/debug/${endpoint.token}`;
}

function statement(input: TemplateInput): string[] {
	const tag = marker(input.nonce, input.point);
	switch (input.language) {
		case 'javascript':
		case 'typescript': {
			const fields = input.expressions.map(e => `${JSON.stringify(e)}: (() => { try { return ${e}; } catch (e) { return "<" + e + ">"; } })()`);
			const json = `JSON.stringify({ ${fields.join(', ')} }, (k, v) => typeof v === "bigint" ? String(v) : v).slice(0, ${maxValueCharsInProgram})`;
			const send = input.channel === 'console'
				? `console.log(${JSON.stringify(tag)}, ${json})`
				: `fetch(${JSON.stringify(endpointUrl(input.endpoint as Endpoint))}, { method: "POST", body: ${JSON.stringify(`${tag} `)} + ${json}, keepalive: true }).catch(() => {})`;
			return [`try { ${send}; } catch {}`];
		}
		case 'python': {
			const fields = input.expressions.map(e => `${JSON.stringify(e)}: ${e}`);
			const json = `__import__("json").dumps({${fields.join(', ')}}, default=str)[:${maxValueCharsInProgram}]`;
			if (input.channel === 'console') {
				return [
					`try: __import__("sys").stderr.write(${JSON.stringify(`${tag} `)} + ${json} + "\\n"); __import__("sys").stderr.flush()`,
					'except Exception: pass',
				];
			}
			// The body is built on the calling thread, where the values are; a daemon thread posts it with a short timeout, so a slow or closed endpoint never holds the program.
			const request = `__import__("urllib.request").request.Request(${JSON.stringify(endpointUrl(input.endpoint as Endpoint))}, data=b, method="POST")`;
			return [
				`try: (lambda b: __import__("threading").Thread(target=lambda: __import__("urllib.request").request.urlopen(${request}, timeout=0.2), daemon=True).start())((${JSON.stringify(`${tag} `)} + ${json}).encode())`,
				'except Exception: pass',
			];
		}
	}
}

/** Whether a file is one the templates should never touch: generated, minified, or a format with no comments. */
export function refusesInstrumentation(file: string, head: string): string | undefined {
	const name = file.replace(/\\/g, '/').split('/').pop() ?? file;
	if (/\.(json|lock|map|min\.[cm]?js|min\.css|svg|png|jpe?g|gif|wasm)$/i.test(name) || /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(name)) {
		return 'the file has no room for a comment, or is a lockfile';
	}
	const first = head.slice(0, 2000);
	if (/@generated\b|DO NOT EDIT|\bthis file is generated\b/i.test(first)) {
		return 'the file is generated';
	}
	const firstLine = first.split('\n')[0] ?? '';
	if (firstLine.length > 1000 && !/\n/.test(first.slice(0, 1000))) {
		return 'the file looks minified';
	}
	return undefined;
}
