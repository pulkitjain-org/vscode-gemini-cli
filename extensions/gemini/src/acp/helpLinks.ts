/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Where GeminiCode sends people for help: the issue tracker, with the facts a
// report needs filled in (what the CLI's /about shows), the Gemini CLI docs,
// and the page the CLI's /upgrade opens for higher limits.

/** The Gemini CLI documentation, as the CLI's /docs opens it. */
export const cliDocsUrl = 'https://geminicli.com/docs/';
/** Higher usage limits for a Google account (gemini-cli 0.63 `UPGRADE_URL_PAGE`). */
export const upgradeUrl = 'https://goo.gle/set-up-gemini-code-assist';
/** GeminiCode's issue tracker, when the build names none. */
export const defaultIssueUrl = 'https://github.com/pulkitjain-org/vscode-gemini-cli/issues/new';

export interface IssueFacts {
	readonly geminiCode?: string;
	readonly vscode: string;
	readonly os: string;
	/** Such as "gemini-cli 0.63.0 (bundled with GeminiCode)"; unset until the agent has started. */
	readonly cli?: string;
}

/** A new issue with a template and the version facts filled in. No account, project or path is included. */
export function issueUrl(base: string, facts: IssueFacts): string {
	const body = [
		'**What happened**',
		'',
		'',
		'**What you expected**',
		'',
		'',
		'**Steps to reproduce**',
		'',
		'1. ',
		'',
		'**Versions**',
		'',
		`- GeminiCode: ${facts.geminiCode ?? 'development build'}`,
		`- VS Code: ${facts.vscode}`,
		`- Gemini CLI: ${facts.cli ?? 'not started'}`,
		`- OS: ${facts.os}`,
		'',
	].join('\n');
	const url = new URL(base);
	url.searchParams.set('body', body);
	return url.toString();
}
