/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that a real Gemini CLI obeys the policy file GeminiCode writes (plan
// Phase 4, policy-enforcement). The CLI talks to a fake Gemini API on
// localhost, through GOOGLE_GEMINI_BASE_URL, that always asks for one shell
// command; no credentials or network are needed.
// Skipped unless GEMINI_CLI_PATH points at the CLI. Runs with an empty HOME.

import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalPolicy, prepareAdminPolicy, shellToolName } from '../../src/acp/adminPolicy';
import { AgentConnection } from '../../src/acp/agentConnection';
import { resolveAgentCommand, spawnAgent } from '../../src/acp/agentProcess';

const cliPath = process.env.GEMINI_CLI_PATH;

interface FunctionResponse {
	readonly name: string;
	readonly response: { readonly output?: string; readonly error?: string };
}

/** A Gemini API that asks for `touch ran.txt` until it sees the tool's response, then ends the turn. */
async function startFakeGemini(responses: FunctionResponse[]): Promise<Server> {
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', chunk => body += chunk);
		req.on('end', () => {
			const parts: { functionResponse?: FunctionResponse }[] = JSON.parse(body || '{}').contents?.at(-1)?.parts ?? [];
			const answered = parts.flatMap(part => part.functionResponse ? [part.functionResponse] : []);
			responses.push(...answered);
			const content = answered.length
				? { role: 'model', parts: [{ text: 'Done.' }] }
				: { role: 'model', parts: [{ functionCall: { name: shellToolName, args: { command: 'touch ran.txt', description: 'Create a file' } } }] };
			const payload = JSON.stringify({ candidates: [{ content, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
			if (req.url?.includes(':streamGenerateContent')) {
				res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${payload}\n\n`);
			} else {
				res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
			}
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return server;
}

describe.skipIf(!cliPath)('gemini --acp with a GeminiCode admin policy', () => {
	let child: ChildProcessWithoutNullStreams | undefined;
	let connection: AgentConnection | undefined;
	let server: Server | undefined;

	afterEach(() => {
		connection?.dispose();
		child?.kill();
		server?.close();
	});

	/** Runs one prompt in `mode` under `policy`; resolves with what the agent asked and what the tool returned. */
	async function runTurn(mode: string, policy: ApprovalPolicy): Promise<{ permissions: number; responses: FunctionResponse[]; ran: boolean }> {
		const responses: FunctionResponse[] = [];
		server = await startFakeGemini(responses);
		const home = mkdtempSync(path.join(tmpdir(), 'gemini-home-'));
		const work = mkdtempSync(path.join(tmpdir(), 'gemini-work-'));
		mkdirSync(path.join(home, '.gemini'));
		writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
		// YOLO and Auto Edit need a trusted folder.
		writeFileSync(path.join(home, '.gemini', 'trustedFolders.json'), JSON.stringify({ [work]: 'TRUST_FOLDER' }));
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			GEMINI_API_KEY: 'fake',
			GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			NO_PROXY: '127.0.0.1',
		};
		// Vitest's own variables switch the CLI into its test behaviour.
		for (const key of Object.keys(env).filter(k => k.startsWith('VITEST') || /^https?_proxy$/i.test(k))) {
			delete env[key];
		}
		const extraArgs = prepareAdminPolicy(path.join(home, 'geminicode-policy'), policy);
		child = spawnAgent(resolveAgentCommand({ cliPath, execPath: process.execPath, env, platform: process.platform, extraArgs }), work);
		child.stderr.resume();
		let permissions = 0;
		connection = new AgentConnection(child.stdin, child.stdout, {
			sessionUpdate: () => { },
			requestPermission: async params => {
				permissions++;
				return { outcome: { outcome: 'selected', optionId: params.options.find(o => o.kind === 'allow_once')!.optionId } };
			},
		});
		await connection.initialize();
		const { sessionId } = await connection.newSession(work);
		// A concrete model skips the CLI's routing call.
		await connection.setModel(sessionId, 'gemini-2.5-flash');
		await connection.setMode(sessionId, mode);
		await connection.prompt(sessionId, [{ type: 'text', text: 'Create the file.' }]);
		return { permissions, responses, ran: existsSync(path.join(work, 'ran.txt')) };
	}

	it('asks before a shell command in Default mode', async () => {
		const result = await runTurn('default', { allowAutoEdit: true, allowYolo: true, allowShell: true });
		expect(result).toMatchObject({ permissions: 1, ran: true });
	}, 60_000);

	it('runs without asking in YOLO mode when YOLO is allowed', async () => {
		const result = await runTurn('yolo', { allowAutoEdit: true, allowYolo: true, allowShell: true });
		expect(result).toMatchObject({ permissions: 0, ran: true });
	}, 60_000);

	it('still asks in YOLO mode when YOLO is turned off', async () => {
		const result = await runTurn('yolo', { allowAutoEdit: true, allowYolo: false, allowShell: true });
		expect(result).toMatchObject({ permissions: 1, ran: true });
	}, 60_000);

	it('removes the shell tool when shell is turned off', async () => {
		const result = await runTurn('default', { allowAutoEdit: true, allowYolo: false, allowShell: false });
		expect(result).toMatchObject({ permissions: 0, ran: false });
		expect(result.responses[0]?.response.error).toMatch(/not found/);
	}, 60_000);
});
