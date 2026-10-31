/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What an agent's expression may do in the user's program without a card
// (DEBUG_MODE.md, Security): only a plain property path (`a.b[0].c`, `a?.b`,
// `a["k"]`), checked per language. A call, an assignment, an operator, a
// template string or a lambda shows the exact expression on a card. The
// environment is special: a path into it asks, the whole of it is refused.
// Also how a breakpoint's condition is joined with the environment guard.

export type Language = 'javascript' | 'typescript' | 'python' | 'go' | 'java';

export const languages: readonly Language[] = ['javascript', 'typescript', 'python', 'go', 'java'];

/** The language of a file by its extension, or undefined for one the checks do not know. */
export function languageOf(file: string): Language | undefined {
	const ext = /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase();
	switch (ext) {
		case 'js': case 'jsx': case 'mjs': case 'cjs': case 'vue': case 'svelte': return 'javascript';
		case 'ts': case 'tsx': case 'mts': case 'cts': return 'typescript';
		case 'py': case 'pyw': return 'python';
		case 'go': return 'go';
		case 'java': return 'java';
		default: return undefined;
	}
}

export type ExpressionCheck =
	| { readonly kind: 'plain' }
	/** Not a plain path: the user sees it on a card. */
	| { readonly kind: 'asks'; readonly why: string }
	/** Never, even with a card. */
	| { readonly kind: 'refused'; readonly why: string };

const identifier = /^[A-Za-z_$][\w$]*$/;
const pythonIdentifier = /^[A-Za-z_]\w*$/;

/** The segments of a plain path (`a.b[0]["k"]?.c`), or undefined when something else is in it. */
function pathSegments(expression: string, language: Language): string[] | undefined {
	const text = expression.trim();
	if (!text || text.length > 200) {
		return undefined;
	}
	const segments: string[] = [];
	let rest = text;
	let first = true;
	while (rest.length) {
		let match: RegExpExecArray | null;
		if (first) {
			match = /^([A-Za-z_$][\w$]*)/.exec(rest);
			if (!match) {
				return undefined;
			}
			segments.push(match[1]);
			rest = rest.slice(match[0].length);
			first = false;
			continue;
		}
		if ((match = /^(\?\.|\.)([A-Za-z_$][\w$]*)/.exec(rest))) {
			segments.push(match[2]);
		} else if ((match = /^(\?\.)?\[(\d+)\]/.exec(rest))) {
			segments.push(`[${match[2]}]`);
		} else if ((match = /^(\?\.)?\[("[^"\\]*"|'[^'\\]*')\]/.exec(rest))) {
			if (language === 'java') {
				return undefined;
			}
			segments.push(`[${match[2]}]`);
		} else {
			return undefined;
		}
		if (match[1] === '?.' && language !== 'javascript' && language !== 'typescript') {
			return undefined;
		}
		rest = rest.slice(match[0].length);
	}
	const ident = language === 'python' ? pythonIdentifier : identifier;
	if (segments.some(s => !s.startsWith('[') && !ident.test(s))) {
		return undefined;
	}
	return segments;
}

/** Whether `expression` is a plain property path in `language`, with no call, operator or assignment. A property getter can still run code on a plain path; the docs say so. */
export function isPlainPath(expression: string, language: Language): boolean {
	return pathSegments(expression, language) !== undefined;
}

const environmentRoots: Readonly<Record<Language, readonly string[]>> = {
	javascript: ['process.env', 'import.meta.env', 'Deno.env'],
	typescript: ['process.env', 'import.meta.env', 'Deno.env'],
	python: ['os.environ', 'environ'],
	go: ['os.Environ'],
	java: ['System.getenv'],
};

/** Whether an expression, or a condition's side, reads the environment: the whole object is refused, a path into it asks. */
export function checkExpression(expression: string, language: Language): ExpressionCheck {
	const text = expression.trim();
	if (!text) {
		return { kind: 'refused', why: 'The expression is empty.' };
	}
	const segments = pathSegments(text, language);
	for (const root of environmentRoots[language]) {
		const rootSegments = root.split('.');
		const normalised = text.replace(/\?\./g, '.').replace(/\[(["'])([^"']*)\1\]/g, '.$2');
		if (normalised === root || normalised.startsWith(`${root}(`)) {
			return { kind: 'refused', why: 'The whole environment is never shown: name the one variable you need, such as process.env.PORT.' };
		}
		if (normalised.startsWith(`${root}.`) || normalised.startsWith(`${root}[`)) {
			return { kind: 'asks', why: `${rootSegments.join('.')} holds the program's environment, which can include credentials.` };
		}
	}
	if (segments) {
		return { kind: 'plain' };
	}
	return { kind: 'asks', why: describeWhyNotPlain(text) };
}

function describeWhyNotPlain(text: string): string {
	if (/=>|\blambda\b|\bfunc\b/.test(text)) {
		return 'It defines a function.';
	}
	if (/`/.test(text) || /f["']/.test(text)) {
		return 'It is a template string.';
	}
	if (/[^=!<>]=[^=]/.test(text)) {
		return 'It assigns.';
	}
	if (/\(/.test(text)) {
		return 'It calls something.';
	}
	return 'It is not a plain property path (a.b[0].c).';
}

const comparison = /^(.+?)\s*(===|!==|==|!=|<=|>=|<|>|\bis\b|\bis not\b)\s*(.+)$/;
const literal = /^(?:-?\d+(?:\.\d+)?|"[^"\\]*"|'[^'\\]*'|true|false|null|undefined|None|True|False|nil)$/;

function andParts(condition: string, language: Language): string[] | undefined {
	const joiner = language === 'python' ? /\s+and\s+/ : /\s*&&\s*/;
	const parts = condition.trim().split(joiner);
	return parts.every(p => p.trim()) ? parts : undefined;
}

/** Whether a breakpoint's condition is only comparisons of plain paths and literals, joined by the language's `and`. */
export function isPlainCondition(condition: string, language: Language): boolean {
	const parts = andParts(condition, language);
	if (!parts) {
		return false;
	}
	return parts.every(part => {
		const text = part.trim().replace(/^\((.*)\)$/, '$1');
		const match = comparison.exec(text);
		if (!match) {
			return false;
		}
		const [, left, op, right] = match;
		if ((op === 'is' || op === 'is not') && language !== 'python') {
			return false;
		}
		const side = (s: string) => literal.test(s.trim()) || isPlainPath(s, language);
		return side(left) && side(right) && checkExpression(left, language).kind !== 'refused' && checkExpression(right, language).kind !== 'refused';
	});
}

/** The condition that is true only in the program Debug mode launched, by the environment variable it sets; undefined for a language with no guard yet. */
export function environmentGuard(language: Language, nonce: string): string | undefined {
	switch (language) {
		case 'javascript':
		case 'typescript':
			return `process.env.GEMINI_DEBUG === ${JSON.stringify(nonce)}`;
		case 'python':
			return `__import__("os").environ.get("GEMINI_DEBUG") == ${JSON.stringify(nonce)}`;
		default:
			return undefined;
	}
}

/** `guard` and `condition` joined in the language's syntax; either may be empty. */
export function joinCondition(language: Language, guard: string | undefined, condition: string | undefined): string | undefined {
	const parts = [guard, condition].map(p => p?.trim()).filter((p): p is string => !!p);
	if (!parts.length) {
		return undefined;
	}
	if (parts.length === 1) {
		return parts[0];
	}
	const and = language === 'python' ? ' and ' : ' && ';
	return parts.map(p => `(${p})`).join(and);
}
