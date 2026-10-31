/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { redact } from '../../src/acp/redact';

describe('redact', () => {
	it('takes out emails, the named account and project, and the home folder', () => {
		const text = 'Signed in as sam.rivera@acme.com (Sam Rivera) on project acme-checkout-prod; log at /Users/sam/Library/Logs/gemini.log';
		expect(redact(text, { names: ['Sam Rivera', 'acme-checkout-prod'], home: '/Users/sam' }))
			.toBe('Signed in as [email] ([name]) on project [name]; log at ~/Library/Logs/gemini.log');
	});

	it('takes out credentials by their key and tokens by their shape', () => {
		const text = [
			'Authorization: Bearer ya29.a0AfH6SMBx-very-long-token-value-here-1234567890',
			'api_key=AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBxY',
			'"refresh_token": "1//0g-abcdefghijklmnop"',
			'GITLAB_TOKEN=glpat-AbCdEfGhIjKlMnOpQrSt',
			'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
			'commit 3b2a1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b was fine',
		].join('\n');
		expect(redact(text).split('\n')).toEqual([
			'Authorization: Bearer [redacted]',
			'api_key=[redacted]',
			'"refresh_token": "[redacted]"',
			'GITLAB_TOKEN=[redacted]',
			'jwt [redacted]',
			'commit [redacted] was fine',
		]);
	});

	it('leaves ordinary log lines alone', () => {
		const line = '2026-10-30 09:34:38.045 [info] Agent ready (gemini 0.66.0); session 7f3a ready in 812 ms; mode autoEdit';
		expect(redact(line, { names: ['ab'], home: '/Users/sam' })).toBe(line);
	});
});
