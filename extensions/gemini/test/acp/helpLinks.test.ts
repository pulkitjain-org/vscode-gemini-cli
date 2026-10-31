/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { cliDocsUrl, upgradeUrl } from '../../src/acp/helpLinks';
import { problemReport } from '../../src/acp/problemReport';

describe('help links', () => {
	it('point at https pages', () => {
		expect([cliDocsUrl, upgradeUrl].every(url => url.startsWith('https://'))).toBe(true);
	});
});

describe('problemReport', () => {
	it('lists the versions, the last failed turn and the log, with nothing personal left in', () => {
		const report = problemReport({
			geminiCode: '1.8.0', vscode: '1.144.0', os: 'darwin 25.6.0 (arm64)', cli: '0.66.0 (bundled)',
			lastError: { kind: 'network', message: 'Could not reach Google for sam@acme.com' },
			log: ['[info] Agent ready (gemini 0.66.0)', '[info] Signed in as sam@acme.com on acme-prod; home /Users/sam', '[error] Authorization: Bearer ya29.a0AfH6SMBx-very-long-token-value-here-1234567890'],
		}, { names: ['acme-prod'], home: '/Users/sam' });
		expect(report).toContain('- GeminiCode: 1.8.0');
		expect(report).toContain('- Gemini CLI: 0.66.0 (bundled)');
		expect(report).toContain('- network: Could not reach Google for [email]');
		expect(report).toContain('[info] Signed in as [email] on [name]; home ~');
		expect(report).toContain('[error] Authorization: Bearer [redacted]');
		expect(report).not.toMatch(/sam@|acme-prod|\/Users\/sam|ya29/);
	});

	it('says when the agent has not started or the build is a dev build, and leaves out a turn that did not fail', () => {
		const report = problemReport({ vscode: '1', os: 'linux', log: [] });
		expect(report).toContain('- GeminiCode: development build');
		expect(report).toContain('- Gemini CLI: not started');
		expect(report).not.toContain('## Last failed turn');
	});
});
