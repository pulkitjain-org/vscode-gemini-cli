/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that a real Gemini CLI still has everything GeminiCode reads from it
// outside ACP (src/acp/cli/formats.ts): the constants direct requests take from
// its bundle, its debug log and telemetry formats, and where it saves
// sessions. Runs against the bundled CLI or GEMINI_CLI_PATH (test/realCli.ts).
// The debug log, sessions and Rewind are also exercised for real by
// realAgentMcp, realAgentSessions and realRewind.

import { expect, it } from 'vitest';
import { checkCliContract } from '../../src/acp/cli/contract';
import { readCliBundle } from '../../src/acp/directRequest';
import { describeRealCli, realCliPath } from '../realCli';

describeRealCli('the contract with the real CLI', () => {
	it('has everything GeminiCode reads from it', async () => {
		expect(await checkCliContract(realCliPath!)).toEqual([]);
	});

	it('names its OAuth client and Flash models', async () => {
		const info = await readCliBundle(realCliPath!);
		expect({
			clientId: info.oauthClient?.id.endsWith('.apps.googleusercontent.com'),
			secret: !!info.oauthClient?.secret,
			latestFlash: info.latestFlash?.startsWith('gemini-'),
			baseFlash: info.baseFlash?.startsWith('gemini-'),
			codeAssistFlash: info.codeAssistFlash?.startsWith('gemini-'),
			version: /^\d+\.\d+\.\d+/.test(info.version ?? ''),
		}).toEqual({ clientId: true, secret: true, latestFlash: true, baseFlash: true, codeAssistFlash: true, version: true });
	});
});
