/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that the model picker still matches the terminal's `/model` after a
// CLI upgrade: the list a real CLI sends in `session/new`, shaped by
// `terminalModelList`, is the one the terminal shows for the same account
// (read from gemini-cli 0.63's `ModelDialog`). If the CLI changes the list it
// sends, this fails, and modelList.ts needs another look. Uses an API key and
// a fake Gemini API on localhost. Runs against the bundled CLI or GEMINI_CLI_PATH (test/realCli.ts). Runs with an empty HOME.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentConnection } from '../../src/acp/agentConnection';
import { resolveAgentCommand, spawnAgent } from '../../src/acp/agentProcess';
import { terminalModelList } from '../../src/acp/modelList';
import { readSessionSettings } from '../../src/acp/sessionSettings';
import { describeRealCli, realCliPath } from '../realCli';

const cliPath = realCliPath;

describeRealCli('the model list a real CLI sends', () => {
	let server: Server | undefined;
	let connection: AgentConnection | undefined;
	let home: string | undefined;
	let stop: (() => Promise<unknown>) | undefined;

	afterEach(async () => {
		connection?.dispose();
		await stop?.();
		server?.close();
		if (home) {
			rmSync(home, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	it('becomes the terminal\'s /model list', async () => {
		server = createServer((req, res) => req.resume().on('end', () => res.writeHead(404).end()));
		await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
		home = mkdtempSync(path.join(tmpdir(), 'gemini-home-'));
		const work = path.join(home, 'shop');
		mkdirSync(work);
		mkdirSync(path.join(home, '.gemini'));
		writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			GEMINI_API_KEY: 'fake',
			GEMINI_CLI_TRUST_WORKSPACE: 'true',
			GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			NO_PROXY: '127.0.0.1',
		};
		// Vitest's own variables switch the CLI into its test behaviour.
		for (const key of Object.keys(env).filter(k => k.startsWith('VITEST') || /^https?_proxy$/i.test(k))) {
			delete env[key];
		}
		const child = spawnAgent(resolveAgentCommand({ cliPath, execPath: process.execPath, env, platform: process.platform }), work);
		stop = () => {
			const exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : undefined;
			child.kill();
			return Promise.resolve(exited);
		};
		child.stderr.resume();
		connection = new AgentConnection(child.stdin, child.stdout, {
			sessionUpdate: () => { },
			requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
		});
		await connection.initialize();
		const session = await connection.newSession(work);
		const available = readSessionSettings(session).model?.available ?? [];
		expect(terminalModelList(available, { gemma: true }).map(c => c.id)).toEqual([
			'auto', 'gemini-3.1-pro-preview-customtools', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it',
		]);
	}, 60_000);
});
