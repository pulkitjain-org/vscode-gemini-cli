/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { cliDocsUrl, issueUrl } from '../../src/acp/helpLinks';

describe('issueUrl', () => {
	it('fills in the versions and nothing personal', () => {
		const url = new URL(issueUrl('https://github.com/o/r/issues/new', { geminiCode: '0.5.0', vscode: '1.141.0', os: 'darwin 24.0.0 (arm64)', cli: 'gemini-cli 0.63.0' }));
		const body = url.searchParams.get('body')!;
		expect(url.pathname).toBe('/o/r/issues/new');
		expect(body).toContain('- GeminiCode: 0.5.0');
		expect(body).toContain('- Gemini CLI: gemini-cli 0.63.0');
		expect(body).toContain('- OS: darwin 24.0.0 (arm64)');
	});

	it('says when the agent has not started or the build is a dev build', () => {
		const body = new URL(issueUrl('https://example.com/new', { vscode: '1', os: 'linux' })).searchParams.get('body')!;
		expect(body).toContain('- GeminiCode: development build');
		expect(body).toContain('- Gemini CLI: not started');
		expect(cliDocsUrl).toMatch(/^https:\/\//);
	});
});
