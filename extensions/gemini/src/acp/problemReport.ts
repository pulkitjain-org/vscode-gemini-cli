/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The text Report a Problem puts in front of the user: the versions, the
// last failed turn, and the recent log lines, with the user's identity and
// any credential taken out (redact.ts). Ready to paste into an issue, an
// email or a chat, and reviewed by the user first.

import { redact, type RedactOptions } from './redact';

export interface ProblemFacts {
	/** The GeminiCode version; unset in a development build. */
	readonly geminiCode?: string;
	readonly vscode: string;
	readonly os: string;
	/** Such as "0.66.0 (bundled)"; unset until the agent has started. */
	readonly cli?: string;
	/** The last turn that failed in the chat in front, if any. */
	readonly lastError?: { readonly kind: string; readonly message: string };
	/** The Gemini log's recent lines, oldest first. */
	readonly log: readonly string[];
}

export function problemReport(facts: ProblemFacts, redaction: RedactOptions = {}): string {
	const clean = (text: string) => redact(text, redaction);
	return [
		'## What happened',
		'',
		'',
		'## What you expected',
		'',
		'',
		'## Versions',
		'',
		`- GeminiCode: ${facts.geminiCode ?? 'development build'}`,
		`- VS Code: ${facts.vscode}`,
		`- Gemini CLI: ${facts.cli ?? 'not started'}`,
		`- OS: ${facts.os}`,
		'',
		...facts.lastError ? ['## Last failed turn', '', `- ${facts.lastError.kind}: ${clean(facts.lastError.message)}`, ''] : [],
		'## Gemini log',
		'',
		'Account names, emails, project ids, your home folder and anything that looks like a key are replaced; read it over before sending.',
		'',
		'```',
		...facts.log.map(clean),
		'```',
		'',
	].join('\n');
}
